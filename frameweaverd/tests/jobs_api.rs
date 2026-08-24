use std::{
    collections::HashMap,
    io::{self, Write},
    net::SocketAddr,
    path::PathBuf,
    sync::{
        Arc, Mutex, Once, OnceLock,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tracing_subscriber::fmt::MakeWriter;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{StatusCode, Uri},
    response::IntoResponse,
    routing::{any, get, post},
};
use frameweaverd::{
    comfy::ComfyApi,
    jobs::{
        JobRepository, JobStatus, NewJob,
        api::{build_router, reconcile_incomplete},
    },
};
use serde_json::{Value, json};
use tokio::{
    net::TcpListener,
    sync::Notify,
    time::{Instant, sleep, timeout},
};
use uuid::Uuid;

#[derive(Clone, Default)]
struct MockComfyState {
    prompt_ids: Arc<Mutex<Vec<String>>>,
    client_ids: Arc<Mutex<Vec<String>>>,
    cancelled: Arc<Mutex<Vec<String>>>,
    job_responses: Arc<Mutex<HashMap<String, MockJobResponse>>>,
    reject_submissions: Arc<AtomicBool>,
    cancel_responses: Arc<Mutex<Vec<MockCancelResponse>>>,
    unexpected_paths: Arc<Mutex<Vec<String>>>,
    hold_gets: Arc<AtomicBool>,
    get_started: Arc<Notify>,
    release_gets: Arc<Notify>,
    get_delay_ms: Arc<AtomicU64>,
    active_gets: Arc<AtomicUsize>,
    max_active_gets: Arc<AtomicUsize>,
}

#[derive(Clone)]
enum MockJobResponse {
    Status(&'static str),
    Payload(Value),
    ServerError,
}

#[derive(Clone)]
enum MockCancelResponse {
    Result(bool),
    Error(StatusCode),
    HoldThenResult(bool),
    SleepThenResult(Duration, bool),
}

#[derive(Clone, Default)]
struct LogSink(Arc<Mutex<Vec<u8>>>);

struct LogWriter(LogSink);

impl Write for LogWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0.0.lock().unwrap().extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for LogSink {
    type Writer = LogWriter;

    fn make_writer(&'a self) -> Self::Writer {
        LogWriter(self.clone())
    }
}

fn installed_log_sink() -> LogSink {
    static SINK: OnceLock<LogSink> = OnceLock::new();
    static INSTALL: Once = Once::new();
    let sink = SINK.get_or_init(LogSink::default).clone();
    INSTALL.call_once(|| {
        let subscriber = tracing_subscriber::fmt()
            .with_writer(sink.clone())
            .with_ansi(false)
            .without_time()
            .finish();
        tracing::subscriber::set_global_default(subscriber).unwrap();
    });
    sink
}

async fn mock_comfy() -> (SocketAddr, MockComfyState, tokio::task::JoinHandle<()>) {
    let state = MockComfyState::default();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/prompt", post(record_prompt))
        .route("/api/jobs/{id}", get(get_job))
        .route("/api/jobs/{id}/cancel", post(cancel_job))
        .fallback(any(record_unexpected))
        .with_state(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (address, state, server)
}

async fn record_unexpected(State(state): State<MockComfyState>, uri: Uri) -> StatusCode {
    state
        .unexpected_paths
        .lock()
        .unwrap()
        .push(uri.path().to_owned());
    StatusCode::NOT_FOUND
}

async fn record_prompt(State(state): State<MockComfyState>, Json(body): Json<Value>) -> StatusCode {
    state
        .prompt_ids
        .lock()
        .unwrap()
        .push(body["prompt_id"].as_str().unwrap_or_default().to_owned());
    state
        .client_ids
        .lock()
        .unwrap()
        .push(body["client_id"].as_str().unwrap_or_default().to_owned());
    if state.reject_submissions.load(Ordering::SeqCst) {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::OK
    }
}

async fn get_job(
    State(state): State<MockComfyState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    if state.hold_gets.load(Ordering::SeqCst) {
        state.get_started.notify_one();
        state.release_gets.notified().await;
    }
    let active = state.active_gets.fetch_add(1, Ordering::SeqCst) + 1;
    state.max_active_gets.fetch_max(active, Ordering::SeqCst);
    let delay_ms = state.get_delay_ms.load(Ordering::SeqCst);
    if delay_ms > 0 {
        sleep(Duration::from_millis(delay_ms)).await;
    }
    let response = match state.job_responses.lock().unwrap().get(&id) {
        Some(MockJobResponse::Status(status)) => {
            (StatusCode::OK, Json(json!({"status": status}))).into_response()
        }
        Some(MockJobResponse::Payload(payload)) => {
            (StatusCode::OK, Json(payload.clone())).into_response()
        }
        Some(MockJobResponse::ServerError) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    };
    state.active_gets.fetch_sub(1, Ordering::SeqCst);
    response
}

async fn cancel_job(
    State(state): State<MockComfyState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    state.cancelled.lock().unwrap().push(id);
    let response = state
        .cancel_responses
        .lock()
        .unwrap()
        .pop()
        .unwrap_or(MockCancelResponse::Result(true));
    match response {
        MockCancelResponse::Result(cancelled) => {
            Json(json!({"cancelled": cancelled})).into_response()
        }
        MockCancelResponse::Error(status) => status.into_response(),
        MockCancelResponse::HoldThenResult(cancelled) => {
            sleep(Duration::from_millis(200)).await;
            Json(json!({"cancelled": cancelled})).into_response()
        }
        MockCancelResponse::SleepThenResult(delay, cancelled) => {
            sleep(delay).await;
            Json(json!({"cancelled": cancelled})).into_response()
        }
    }
}

fn database_path() -> PathBuf {
    std::env::temp_dir().join(format!("frameweaverd-jobs-api-{}.db", Uuid::new_v4()))
}

fn owner() -> String {
    Uuid::new_v4().to_string()
}

async fn api_server(
    comfy_address: SocketAddr,
) -> (String, JobRepository, tokio::task::JoinHandle<()>) {
    let repository = JobRepository::open(database_path()).await.unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let comfy = ComfyApi::new(format!("http://{comfy_address}").parse().unwrap()).unwrap();
    let app = build_router(repository.clone(), comfy);
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}"), repository, server)
}

fn job_request() -> Value {
    json!({
        "client_id": Uuid::new_v4().to_string(),
        "kind": "image",
        "mode": "txt2img",
        "prompt": "a lighthouse",
        "settings": {"steps": 20},
        "workflow": {"1": {"class_type": "KSampler", "inputs": {}}}
    })
}

#[tokio::test]
async fn jobs_api_replay_with_same_request_key_submits_once() {
    let (comfy_address, comfy_state, comfy_server) = mock_comfy().await;
    let (api_url, _, api_server) = api_server(comfy_address).await;
    let owner = owner();
    let mut request = job_request();
    request["request_id"] = Value::String(Uuid::new_v4().to_string());
    let client = reqwest::Client::new();
    let first = client
        .post(format!("{api_url}/api/jobs"))
        .header("X-FrameWeaver-Owner", &owner)
        .json(&request)
        .send()
        .await
        .unwrap();
    let second = client
        .post(format!("{api_url}/api/jobs"))
        .header("X-FrameWeaver-Owner", &owner)
        .json(&request)
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::CREATED);
    assert_eq!(second.status(), StatusCode::OK);
    assert_eq!(comfy_state.prompt_ids.lock().unwrap().len(), 1);
    api_server.abort();
    comfy_server.abort();
}

#[tokio::test]
async fn jobs_api_rejects_reused_request_key_with_changed_payload() {
    let (comfy_address, comfy_state, comfy_server) = mock_comfy().await;
    let (api_url, _, api_server) = api_server(comfy_address).await;
    let owner = owner();
    let mut request = job_request();
    request["request_id"] = Value::String(Uuid::new_v4().to_string());
    let client = reqwest::Client::new();
    assert_eq!(
        client
            .post(format!("{api_url}/api/jobs"))
            .header("X-FrameWeaver-Owner", &owner)
            .json(&request)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CREATED
    );
    request["prompt"] = Value::String("different input".to_owned());
    assert_eq!(
        client
            .post(format!("{api_url}/api/jobs"))
            .header("X-FrameWeaver-Owner", &owner)
            .json(&request)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(comfy_state.prompt_ids.lock().unwrap().len(), 1);
    api_server.abort();
    comfy_server.abort();
}

#[tokio::test]
async fn jobs_api_submits_server_generated_uuid_and_owner_can_cancel_only_that_job() {
    let (comfy_address, comfy_state, comfy_server) = mock_comfy().await;
    let (api_url, _, api_server) = api_server(comfy_address).await;
    let owner_a = owner();
    let client = reqwest::Client::new();

    let created = client
        .post(format!("{api_url}/api/jobs"))
        .header("X-FrameWeaver-Owner", &owner_a)
        .json(&job_request())
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);
    let job: Value = created.json().await.unwrap();
    let job_id = job["id"].as_str().unwrap().to_owned();
    assert!(Uuid::parse_str(&job_id).is_ok());
    assert_eq!(
        comfy_state.prompt_ids.lock().unwrap().as_slice(),
        [job_id.as_str()]
    );
    assert!(Uuid::parse_str(comfy_state.client_ids.lock().unwrap()[0].as_str()).is_ok());

    let cancelled = client
        .delete(format!("{api_url}/api/jobs/{job_id}"))
        .header("X-FrameWeaver-Owner", &owner_a)
        .send()
        .await
        .unwrap();
    assert_eq!(cancelled.status(), StatusCode::OK);
    assert_eq!(
        comfy_state.cancelled.lock().unwrap().as_slice(),
        [job_id.as_str()]
    );
    assert!(
        !comfy_state
            .unexpected_paths
            .lock()
            .unwrap()
            .contains(&"/interrupt".to_owned())
    );
    assert!(
        !comfy_state
            .unexpected_paths
            .lock()
            .unwrap()
            .contains(&"/queue".to_owned())
    );

    api_server.abort();
    comfy_server.abort();
}

#[tokio::test]
async fn concurrent_successful_targeted_cancels_return_the_current_cancelled_row() {
    let (comfy_address, comfy_state, comfy_server) = mock_comfy().await;
    let (api_url, repository, api_server) = api_server(comfy_address).await;
    let owner_a = owner();
    let job = repository
        .create(NewJob {
            owner_id: owner_a.clone(),
            kind: "image".to_owned(),
            mode: "txt2img".to_owned(),
            prompt: "cancel race".to_owned(),
            settings_json: "{}".to_owned(),
        })
        .await
        .unwrap();
    *comfy_state.cancel_responses.lock().unwrap() = vec![
        MockCancelResponse::HoldThenResult(true),
        MockCancelResponse::HoldThenResult(true),
    ];

    let delete = |url: String, owner: String| async move {
        reqwest::Client::new()
            .delete(url)
            .header("X-FrameWeaver-Owner", owner)
            .send()
            .await
            .unwrap()
    };
    let first = tokio::spawn(delete(
        format!("{api_url}/api/jobs/{}", job.id),
        owner_a.clone(),
    ));
    let second = tokio::spawn(delete(
        format!("{api_url}/api/jobs/{}", job.id),
        owner_a.clone(),
    ));
    assert_eq!(first.await.unwrap().status(), StatusCode::OK);
    assert_eq!(second.await.unwrap().status(), StatusCode::OK);
    let stored = repository
        .get_for_owner(&job.id, &owner_a)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.status, JobStatus::Cancelled);

    api_server.abort();
    comfy_server.abort();
}

#[tokio::test]
async fn false_cancel_reconciles_pending_to_queued_and_remains_retryable() {
    let (comfy_address, comfy_state, comfy_server) = mock_comfy().await;
    let (api_url, repository, api_server) = api_server(comfy_address).await;
    let owner_a = owner();
    let job = repository
        .create(NewJob {
            owner_id: owner_a.clone(),
            kind: "image".to_owned(),
            mode: "txt2img".to_owned(),
            prompt: "false cancellation acknowledgement".to_owned(),
            settings_json: "{}".to_owned(),
        })
        .await
        .unwrap();
    comfy_state
        .job_responses
        .lock()
        .unwrap()
        .insert(job.id.clone(), MockJobResponse::Status("pending"));
    *comfy_state.cancel_responses.lock().unwrap() = vec![
        MockCancelResponse::Result(true),
        MockCancelResponse::Result(false),
    ];
    let client = reqwest::Client::new();

    let first: Value = client
        .delete(format!("{api_url}/api/jobs/{}", job.id))
        .header("X-FrameWeaver-Owner", &owner_a)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(first["status"], "queued");
    let retry = client
        .delete(format!("{api_url}/api/jobs/{}", job.id))
        .header("X-FrameWeaver-Owner", &owner_a)
        .send()
        .await
        .unwrap();
    assert_eq!(retry.status(), StatusCode::OK);
    assert_eq!(
        repository
            .get_for_owner(&job.id, &owner_a)
            .await
            .unwrap()
            .unwrap()
            .status,
        JobStatus::Cancelled
    );

    api_server.abort();
    comfy_server.abort();
}

#[tokio::test]
async fn uncertain_cancel_reconciles_running_to_retryable_running_state() {
    let (comfy_address, comfy_state, comfy_server) = mock_comfy().await;
    let (api_url, repository, api_server) = api_server(comfy_address).await;
    let owner_a = owner();
    let job = repository
        .create(NewJob {
            owner_id: owner_a.clone(),
            kind: "image".to_owned(),
            mode: "txt2img".to_owned(),
            prompt: "transport timeout cancellation".to_owned(),
            settings_json: "{}".to_owned(),
        })
        .await
        .unwrap();
    repository
        .transition(&job.id, JobStatus::Queued, JobStatus::Running)
        .await
        .unwrap();
    comfy_state
        .job_responses
        .lock()
        .unwrap()
        .insert(job.id.clone(), MockJobResponse::Status("in_progress"));
    *comfy_state.cancel_responses.lock().unwrap() =
        vec![MockCancelResponse::Error(StatusCode::GATEWAY_TIMEOUT)];

    let response: Value = reqwest::Client::new()
        .delete(format!("{api_url}/api/jobs/{}", job.id))
        .header("X-FrameWeaver-Owner", &owner_a)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["status"], "running");
    assert_eq!(
        repository
            .get_for_owner(&job.id, &owner_a)
            .await
            .unwrap()
            .unwrap()
            .status,
        JobStatus::Running
    );

    api_server.abort();
    comfy_server.abort();
}

#[tokio::test]
async fn timed_out_cancel_reconciles_running_to_retryable_running_state() {
    let (comfy_address, comfy_state, comfy_server) = mock_comfy().await;
    let (api_url, repository, api_server) = api_server(comfy_address).await;
    let owner_a = owner();
    let job = repository
        .create(NewJob {
            owner_id: owner_a.clone(),
            kind: "image".to_owned(),
            mode: "txt2img".to_owned(),
            prompt: "actual cancellation timeout".to_owned(),
            settings_json: "{}".to_owned(),
        })
        .await
        .unwrap();
    repository
        .transition(&job.id, JobStatus::Queued, JobStatus::Running)
        .await
        .unwrap();
    comfy_state
        .job_responses
        .lock()
        .unwrap()
        .insert(job.id.clone(), MockJobResponse::Status("in_progress"));
    *comfy_state.cancel_responses.lock().unwrap() = vec![MockCancelResponse::SleepThenResult(
        Duration::from_secs(11),
        true,
    )];

    let response: Value = reqwest::Client::new()
        .delete(format!("{api_url}/api/jobs/{}", job.id))
        .header("X-FrameWeaver-Owner", &owner_a)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["status"], "running");
    assert_eq!(
        repository
            .get_for_owner(&job.id, &owner_a)
            .await
            .unwrap()
            .unwrap()
            .status,
        JobStatus::Running
    );

    api_server.abort();
    comfy_server.abort();
}

#[tokio::test]
async fn jobs_api_hides_other_owners_jobs_and_rejects_invalid_headers_and_oversized_bodies() {
    let (comfy_address, comfy_state, comfy_server) = mock_comfy().await;
    let (api_url, _, api_server) = api_server(comfy_address).await;
    let owner_a = owner();
    let client = reqwest::Client::new();
    let created: Value = client
        .post(format!("{api_url}/api/jobs"))
        .header("X-FrameWeaver-Owner", &owner_a)
        .json(&job_request())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let job_id = created["id"].as_str().unwrap();

    let hidden = client
        .delete(format!("{api_url}/api/jobs/{job_id}"))
        .header("X-FrameWeaver-Owner", owner())
        .send()
        .await
        .unwrap();
    assert_eq!(hidden.status(), StatusCode::NOT_FOUND);
    assert_eq!(comfy_state.cancelled.lock().unwrap().len(), 0);

    let invalid_owner = client
        .get(format!("{api_url}/api/jobs/{job_id}"))
        .header("X-FrameWeaver-Owner", "not-a-uuid")
        .send()
        .await
        .unwrap();
    assert_eq!(invalid_owner.status(), StatusCode::BAD_REQUEST);

    let oversized = client
        .post(format!("{api_url}/api/jobs"))
        .header("X-FrameWeaver-Owner", owner_a)
        .header("content-type", "application/json")
        .body(format!("{{\"prompt\":\"{}\"}}", "x".repeat(65 * 1024)))
        .send()
        .await
        .unwrap();
    assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(comfy_state.prompt_ids.lock().unwrap().len(), 1);

    api_server.abort();
    comfy_server.abort();
}

#[tokio::test]
async fn jobs_api_marks_submission_failure_and_absent_recovery_jobs_orphaned() {
    let (comfy_address, comfy_state, comfy_server) = mock_comfy().await;
    let (api_url, repository, api_server) = api_server(comfy_address).await;
    let owner_a = owner();
    let client = reqwest::Client::new();

    comfy_state.reject_submissions.store(true, Ordering::SeqCst);
    let failed = client
        .post(format!("{api_url}/api/jobs"))
        .header("X-FrameWeaver-Owner", &owner_a)
        .json(&job_request())
        .send()
        .await
        .unwrap();
    assert_eq!(failed.status(), StatusCode::BAD_GATEWAY);
    let submitted = repository.list_for_owner(&owner_a, 10).await.unwrap();
    assert_eq!(submitted.len(), 1);
    assert_eq!(submitted[0].status, JobStatus::Failed);

    let queued = repository
        .create(NewJob {
            owner_id: owner_a,
            kind: "image".to_owned(),
            mode: "txt2img".to_owned(),
            prompt: "recover me".to_owned(),
            settings_json: "{}".to_owned(),
        })
        .await
        .unwrap();
    let comfy = ComfyApi::new(format!("http://{comfy_address}").parse().unwrap()).unwrap();
    reconcile_incomplete(&repository, &comfy).await.unwrap();
    let recovered = repository
        .get_for_owner(&queued.id, &queued.owner_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovered.status, JobStatus::Orphaned);

    api_server.abort();
    comfy_server.abort();
}

#[tokio::test]
async fn recovery_converges_each_comfy_status_without_relaxing_normal_transitions() {
    let (comfy_address, comfy_state, comfy_server) = mock_comfy().await;
    let repository = JobRepository::open(database_path()).await.unwrap();
    let owner_a = owner();
    let mut jobs = Vec::new();
    for remote_status in ["pending", "in_progress", "completed", "failed", "cancelled"] {
        let job = repository
            .create(NewJob {
                owner_id: owner_a.clone(),
                kind: "image".to_owned(),
                mode: "txt2img".to_owned(),
                prompt: remote_status.to_owned(),
                settings_json: "{}".to_owned(),
            })
            .await
            .unwrap();
        comfy_state
            .job_responses
            .lock()
            .unwrap()
            .insert(job.id.clone(), MockJobResponse::Status(remote_status));
        jobs.push((job, remote_status));
    }

    let comfy = ComfyApi::new(format!("http://{comfy_address}").parse().unwrap()).unwrap();
    reconcile_incomplete(&repository, &comfy).await.unwrap();

    let pending_id = jobs[0].0.id.clone();
    for (job, remote_status) in jobs {
        let recovered = repository
            .get_for_owner(&job.id, &job.owner_id)
            .await
            .unwrap()
            .unwrap();
        let expected = match remote_status {
            "pending" => JobStatus::Queued,
            "in_progress" => JobStatus::Running,
            "completed" => JobStatus::Succeeded,
            "failed" => JobStatus::Failed,
            "cancelled" => JobStatus::Cancelled,
            _ => unreachable!(),
        };
        assert_eq!(recovered.status, expected);
    }

    assert!(
        repository
            .transition(&pending_id, JobStatus::Queued, JobStatus::Succeeded)
            .await
            .is_err()
    );
    comfy_server.abort();
}

#[tokio::test]
async fn recovery_preserves_local_rows_when_comfy_returns_server_error() {
    let (comfy_address, comfy_state, comfy_server) = mock_comfy().await;
    let repository = JobRepository::open(database_path()).await.unwrap();
    let job = repository
        .create(NewJob {
            owner_id: owner(),
            kind: "image".to_owned(),
            mode: "txt2img".to_owned(),
            prompt: "do not orphan me on a Comfy outage".to_owned(),
            settings_json: "{}".to_owned(),
        })
        .await
        .unwrap();
    comfy_state
        .job_responses
        .lock()
        .unwrap()
        .insert(job.id.clone(), MockJobResponse::ServerError);

    let comfy = ComfyApi::new(format!("http://{comfy_address}").parse().unwrap()).unwrap();
    assert!(reconcile_incomplete(&repository, &comfy).await.is_ok());
    let stored = repository
        .get_for_owner(&job.id, &job.owner_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.status, JobStatus::Queued);

    comfy_server.abort();
}

#[tokio::test]
async fn jobs_api_reconciles_only_the_owners_incomplete_jobs_and_persists_typed_outputs() {
    let (comfy_address, comfy_state, comfy_server) = mock_comfy().await;
    let (api_url, repository, api_server) = api_server(comfy_address).await;
    let owner_a = owner();
    let owner_b = owner();
    let job_a = repository
        .create(NewJob {
            owner_id: owner_a.clone(),
            kind: "image".to_owned(),
            mode: "txt2img".to_owned(),
            prompt: "completed output".to_owned(),
            settings_json: "{}".to_owned(),
        })
        .await
        .unwrap();
    let job_b = repository
        .create(NewJob {
            owner_id: owner_b.clone(),
            kind: "image".to_owned(),
            mode: "txt2img".to_owned(),
            prompt: "other owner".to_owned(),
            settings_json: "{}".to_owned(),
        })
        .await
        .unwrap();
    let failed_job = repository
        .create(NewJob {
            owner_id: owner_a.clone(),
            kind: "video".to_owned(),
            mode: "text".to_owned(),
            prompt: "failed output".to_owned(),
            settings_json: "{}".to_owned(),
        })
        .await
        .unwrap();
    let unavailable_job = repository
        .create(NewJob {
            owner_id: owner_a.clone(),
            kind: "image".to_owned(),
            mode: "txt2img".to_owned(),
            prompt: "preserve local".to_owned(),
            settings_json: "{}".to_owned(),
        })
        .await
        .unwrap();
    comfy_state.job_responses.lock().unwrap().insert(
        job_a.id.clone(),
        MockJobResponse::Payload(json!({
            "status": "completed",
            "outputs": {"42": {"images": [{"filename": "result.png", "subfolder": "images", "type": "output"}]}}
        })),
    );
    comfy_state.job_responses.lock().unwrap().insert(
        failed_job.id.clone(),
        MockJobResponse::Payload(
            json!({"status": "failed", "outputs": {}, "execution_error": {"exception_message": "sampler failed"}}),
        ),
    );
    comfy_state
        .job_responses
        .lock()
        .unwrap()
        .insert(unavailable_job.id.clone(), MockJobResponse::ServerError);

    let response: Value = reqwest::Client::new()
        .get(format!("{api_url}/api/jobs"))
        .header("X-FrameWeaver-Owner", &owner_a)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let listed = response["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|job| job["id"] == job_a.id)
        .unwrap();
    assert_eq!(listed["id"], job_a.id);
    assert_eq!(listed["status"], "succeeded");
    assert_eq!(
        listed["output_json"],
        json!("[{\"filename\":\"result.png\",\"subfolder\":\"images\",\"type\":\"output\"}]")
    );

    let stored_a = repository
        .get_for_owner(&job_a.id, &owner_a)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored_a.status, JobStatus::Succeeded);
    assert!(stored_a.finished_at.is_some());
    let stored_b = repository
        .get_for_owner(&job_b.id, &owner_b)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored_b.status, JobStatus::Queued);

    let failed: Value = reqwest::Client::new()
        .get(format!("{api_url}/api/jobs/{}", failed_job.id))
        .header("X-FrameWeaver-Owner", &owner_a)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(failed["status"], "failed");
    assert_eq!(
        failed["error"],
        "{\"exception_message\":\"sampler failed\"}"
    );
    assert!(failed["finished_at"].is_string());

    let preserved: Value = reqwest::Client::new()
        .get(format!("{api_url}/api/jobs/{}", unavailable_job.id))
        .header("X-FrameWeaver-Owner", &owner_a)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(preserved["status"], "queued");
    assert!(preserved["output_json"].is_null());

    api_server.abort();
    comfy_server.abort();
}

#[tokio::test]
async fn get_reconciliation_cas_does_not_overwrite_a_successful_targeted_cancellation() {
    let (comfy_address, comfy_state, comfy_server) = mock_comfy().await;
    let (api_url, repository, api_server) = api_server(comfy_address).await;
    let owner_a = owner();
    let job = repository
        .create(NewJob {
            owner_id: owner_a.clone(),
            kind: "image".to_owned(),
            mode: "txt2img".to_owned(),
            prompt: "race".to_owned(),
            settings_json: "{}".to_owned(),
        })
        .await
        .unwrap();
    comfy_state
        .job_responses
        .lock()
        .unwrap()
        .insert(job.id.clone(), MockJobResponse::Status("pending"));
    comfy_state.hold_gets.store(true, Ordering::SeqCst);

    let get_client = reqwest::Client::new();
    let get_url = format!("{api_url}/api/jobs/{}", job.id);
    let get_owner = owner_a.clone();
    let get_task = tokio::spawn(async move {
        get_client
            .get(get_url)
            .header("X-FrameWeaver-Owner", get_owner)
            .send()
            .await
            .unwrap()
    });
    timeout(Duration::from_secs(1), comfy_state.get_started.notified())
        .await
        .unwrap();

    let cancelled = reqwest::Client::new()
        .delete(format!("{api_url}/api/jobs/{}", job.id))
        .header("X-FrameWeaver-Owner", &owner_a)
        .send()
        .await
        .unwrap();
    assert_eq!(cancelled.status(), StatusCode::OK);
    comfy_state.release_gets.notify_one();

    let reconciled = get_task.await.unwrap();
    assert_eq!(reconciled.status(), StatusCode::OK);
    let stored = repository
        .get_for_owner(&job.id, &owner_a)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        stored.status,
        JobStatus::Cancelled | JobStatus::CancelRequested
    ));

    api_server.abort();
    comfy_server.abort();
}

#[tokio::test]
async fn reconciliation_does_not_regress_cancel_requested_when_comfy_is_still_pending() {
    let (comfy_address, comfy_state, comfy_server) = mock_comfy().await;
    let (api_url, repository, api_server) = api_server(comfy_address).await;
    let owner_a = owner();
    let job = repository
        .create(NewJob {
            owner_id: owner_a.clone(),
            kind: "image".to_owned(),
            mode: "txt2img".to_owned(),
            prompt: "cancel requested".to_owned(),
            settings_json: "{}".to_owned(),
        })
        .await
        .unwrap();
    repository
        .transition(&job.id, JobStatus::Queued, JobStatus::CancelRequested)
        .await
        .unwrap();
    comfy_state
        .job_responses
        .lock()
        .unwrap()
        .insert(job.id.clone(), MockJobResponse::Status("pending"));

    let response: Value = reqwest::Client::new()
        .get(format!("{api_url}/api/jobs/{}", job.id))
        .header("X-FrameWeaver-Owner", &owner_a)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["status"], "cancel_requested");
    let stored = repository
        .get_for_owner(&job.id, &owner_a)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.status, JobStatus::CancelRequested);

    api_server.abort();
    comfy_server.abort();
}

#[tokio::test]
async fn owner_reconciliation_is_bounded_and_times_out_without_serial_wall_time() {
    let (comfy_address, comfy_state, comfy_server) = mock_comfy().await;
    let (api_url, repository, api_server) = api_server(comfy_address).await;
    let owner_a = owner();
    for index in 0..4 {
        let job = repository
            .create(NewJob {
                owner_id: owner_a.clone(),
                kind: "image".to_owned(),
                mode: "txt2img".to_owned(),
                prompt: format!("slow-{index}"),
                settings_json: "{}".to_owned(),
            })
            .await
            .unwrap();
        comfy_state
            .job_responses
            .lock()
            .unwrap()
            .insert(job.id, MockJobResponse::Status("pending"));
    }
    comfy_state.get_delay_ms.store(3_000, Ordering::SeqCst);

    let started = Instant::now();
    let response: Value = reqwest::Client::new()
        .get(format!("{api_url}/api/jobs"))
        .header("X-FrameWeaver-Owner", &owner_a)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(response["jobs"].as_array().unwrap().len(), 4);
    assert!(comfy_state.max_active_gets.load(Ordering::SeqCst) >= 4);
    assert!(comfy_state.max_active_gets.load(Ordering::SeqCst) <= 8);

    api_server.abort();
    comfy_server.abort();
}

#[tokio::test]
async fn job_cancel_and_recovery_logs_expose_only_ids_and_results() {
    let sink = installed_log_sink();
    let log_offset = sink.0.lock().unwrap().len();
    let (comfy_address, comfy_state, comfy_server) = mock_comfy().await;
    let (api_url, repository, api_server) = api_server(comfy_address).await;
    let owner_a = owner();
    let sensitive_prompt = "prompt-value-should-not-log";
    let sensitive_setting = "settings-value-should-not-log";
    let sensitive_workflow = "workflow-value-should-not-log";
    let created: Value = reqwest::Client::new()
        .post(format!("{api_url}/api/jobs"))
        .header("X-FrameWeaver-Owner", &owner_a)
        .json(&json!({
            "client_id": Uuid::new_v4().to_string(),
            "kind": "image",
            "mode": "txt2img",
            "prompt": sensitive_prompt,
            "settings": {"secret_setting": sensitive_setting},
            "workflow": {"secret_workflow": sensitive_workflow}
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = created["id"].as_str().unwrap();
    reqwest::Client::new()
        .delete(format!("{api_url}/api/jobs/{id}"))
        .header("X-FrameWeaver-Owner", &owner_a)
        .send()
        .await
        .unwrap();

    let recovery_job = repository
        .create(NewJob {
            owner_id: owner_a,
            kind: "image".to_owned(),
            mode: "txt2img".to_owned(),
            prompt: sensitive_prompt.to_owned(),
            settings_json: format!("{{\"secret\":\"{sensitive_setting}\"}}"),
        })
        .await
        .unwrap();
    comfy_state
        .job_responses
        .lock()
        .unwrap()
        .insert(recovery_job.id, MockJobResponse::ServerError);
    let orphan_job = repository
        .create(NewJob {
            owner_id: created["owner_id"].as_str().unwrap().to_owned(),
            kind: "image".to_owned(),
            mode: "txt2img".to_owned(),
            prompt: sensitive_prompt.to_owned(),
            settings_json: format!("{{\"secret\":\"{sensitive_setting}\"}}"),
        })
        .await
        .unwrap();
    let comfy = ComfyApi::new(format!("http://{comfy_address}").parse().unwrap()).unwrap();
    reconcile_incomplete(&repository, &comfy).await.unwrap();

    let logs = String::from_utf8(sink.0.lock().unwrap()[log_offset..].to_vec()).unwrap();
    for event in ["job_submit", "job_cancel", "job_recovery"] {
        assert!(logs.contains(event), "missing {event} log: {logs}");
    }
    assert!(
        logs.contains(id),
        "job ID missing from operation logs: {logs}"
    );
    assert!(
        logs.contains(&orphan_job.id),
        "orphan job ID missing from logs: {logs}"
    );
    assert!(
        logs.contains("orphaned"),
        "orphan result missing from logs: {logs}"
    );
    for field in ["owner_short", "from", "to", "result", "duration_ms"] {
        assert!(
            logs.contains(field),
            "missing structured field {field}: {logs}"
        );
    }
    for sensitive in [
        sensitive_prompt,
        sensitive_setting,
        sensitive_workflow,
        "secret_setting",
    ] {
        assert!(
            !logs.contains(sensitive),
            "sensitive content leaked: {sensitive}"
        );
    }

    api_server.abort();
    comfy_server.abort();
}
