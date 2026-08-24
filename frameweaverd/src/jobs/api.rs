use std::{error::Error, time::Instant};

use futures_util::{StreamExt, stream};

use axum::{
    Json, Router,
    extract::{FromRequestParts, Path, Query, State},
    http::{StatusCode, request::Parts},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    auth::AuthenticatedIdentity,
    comfy::{ComfyApi, RemoteJob, RemoteJobStatus, flatten_media_outputs},
    events::OperationEvent,
    jobs::{Job, JobRepository, JobStatus, NewJob},
    workers::{
        RoutingError, WorkerCapability, WorkerId, WorkerPreference, WorkerRegistry, WorkerRequest,
    },
};

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const RECONCILE_CONCURRENCY: usize = 4;

#[derive(Clone)]
struct JobsState {
    repository: JobRepository,
    workers: WorkerRegistry,
}

#[derive(Deserialize)]
struct CreateJobRequest {
    client_id: String,
    kind: String,
    mode: String,
    prompt: String,
    settings: Value,
    workflow: Value,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    worker_preference: Option<WorkerPreference>,
}

#[derive(Deserialize)]
struct ListJobsQuery {
    limit: Option<u32>,
}

#[derive(Serialize)]
struct JobListResponse {
    jobs: Vec<Job>,
}

#[derive(Clone)]
struct OwnerId(String);

impl<S> FromRequestParts<S> for OwnerId
where
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        if let Some(identity) = parts.extensions.get::<AuthenticatedIdentity>() {
            return Ok(Self(identity.0.owner_id.to_string()));
        }
        let value = parts
            .headers
            .get("X-FrameWeaver-Owner")
            .and_then(|header| header.to_str().ok())
            .ok_or_else(|| ApiError::bad_request("X-FrameWeaver-Owner is required"))?;
        Uuid::parse_str(value)
            .map_err(|_| ApiError::bad_request("X-FrameWeaver-Owner must be a UUID"))?;
        Ok(Self(value.to_owned()))
    }
}

struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(message: &'static str) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.to_owned(),
        }
    }
    fn not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: "job not found".to_owned(),
        }
    }
    fn conflict() -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: "job cannot be cancelled".to_owned(),
        }
    }
    fn internal() -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: "job operation failed".to_owned(),
        }
    }
    fn service_unavailable() -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "no eligible worker".to_owned(),
        }
    }
    fn bad_gateway_reason(reason: String) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            message: reason,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({"error": self.message})),
        )
            .into_response()
    }
}

pub fn build_router(repository: JobRepository, comfy: ComfyApi) -> Router {
    build_routed_router(repository, WorkerRegistry::local(comfy))
}

pub fn build_routed_router(repository: JobRepository, workers: WorkerRegistry) -> Router {
    Router::new()
        .route("/api/jobs", post(create_job).get(list_jobs))
        .route("/api/jobs/{id}", get(get_job).delete(cancel_job))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .with_state(JobsState {
            repository,
            workers,
        })
}

async fn create_job(
    State(state): State<JobsState>,
    owner: OwnerId,
    Json(request): Json<CreateJobRequest>,
) -> Result<(StatusCode, Json<Job>), ApiError> {
    let started = Instant::now();
    if Uuid::parse_str(&request.client_id).is_err()
        || request
            .request_id
            .as_deref()
            .is_some_and(|id| Uuid::parse_str(id).is_err())
        || !matches!(request.kind.as_str(), "image" | "video")
        || request.mode.is_empty()
        || request.prompt.is_empty()
    {
        return Err(ApiError::bad_request("invalid job request"));
    }
    let owner_id = owner.0.clone();
    let capability = match request.kind.as_str() {
        "video" => WorkerCapability::Video,
        _ => WorkerCapability::Image,
    };
    let required_vram_mb = required_vram_mb(&request.kind, &request.mode)
        .ok_or_else(|| ApiError::bad_request("invalid job request"))?;
    let worker_id = state
        .workers
        .select(&WorkerRequest {
            capability,
            required_vram_mb,
            preference: request.worker_preference.unwrap_or(WorkerPreference::Auto),
        })
        .await
        .map_err(routing_error)?;
    let comfy = state
        .workers
        .client(&worker_id)
        .ok_or_else(ApiError::service_unavailable)?;
    let new_job = NewJob {
        owner_id: owner_id.clone(),
        kind: request.kind,
        mode: request.mode,
        prompt: request.prompt,
        settings_json: request.settings.to_string(),
    };
    let (job, created) = match request.request_id.as_deref() {
        Some(request_id) => {
            state
                .repository
                .create_or_get_routed(new_job, Some(worker_id.as_str()), request_id)
                .await
        }
        None => state
            .repository
            .create_routed(new_job, Some(worker_id.as_str()))
            .await
            .map(|job| (job, true)),
    }
    .map_err(|_| ApiError::internal())?;

    if !created {
        return Ok((StatusCode::OK, Json(job)));
    }

    if let Err(error) = comfy
        .submit(&job.id, &request.client_id, request.workflow)
        .await
    {
        state
            .repository
            .transition(&job.id, JobStatus::Queued, JobStatus::Failed)
            .await
            .map_err(|_| ApiError::internal())?;
        OperationEvent::new("job_submit", "upstream_error", started.elapsed())
            .job_id(&job.id)
            .owner_id(&owner_id)
            .transition("new", "failed")
            .warn();
        return Err(ApiError::bad_gateway_reason(error.to_string()));
    }
    OperationEvent::new("job_submit", "submitted", started.elapsed())
        .job_id(&job.id)
        .owner_id(&owner_id)
        .transition("new", "queued")
        .info();
    Ok((StatusCode::CREATED, Json(job)))
}

fn required_vram_mb(kind: &str, mode: &str) -> Option<u64> {
    match kind {
        "video" if !mode.is_empty() => Some(16 * 1024),
        "image" if mode == "anime" => Some(12 * 1024),
        "image" if !mode.is_empty() => Some(10 * 1024),
        _ => None,
    }
}

async fn list_jobs(
    State(state): State<JobsState>,
    owner: OwnerId,
    Query(query): Query<ListJobsQuery>,
) -> Result<Json<JobListResponse>, ApiError> {
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let jobs = state
        .repository
        .list_for_owner(&owner.0, limit)
        .await
        .map_err(|_| ApiError::internal())?;
    let reconciled = stream::iter(jobs)
        .map(|job| async {
            let fallback = job.clone();
            reconcile_job(&state, job).await.unwrap_or(fallback)
        })
        .buffered(RECONCILE_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    Ok(Json(JobListResponse { jobs: reconciled }))
}

async fn get_job(
    State(state): State<JobsState>,
    owner: OwnerId,
    Path(id): Path<String>,
) -> Result<Json<Job>, ApiError> {
    let job = state
        .repository
        .get_for_owner(&id, &owner.0)
        .await
        .map_err(|_| ApiError::internal())?
        .ok_or_else(ApiError::not_found)?;
    Ok(Json(reconcile_job(&state, job).await?))
}

async fn cancel_job(
    State(state): State<JobsState>,
    owner: OwnerId,
    Path(id): Path<String>,
) -> Result<Json<Job>, ApiError> {
    let started = Instant::now();
    let job = state
        .repository
        .get_for_owner(&id, &owner.0)
        .await
        .map_err(|_| ApiError::internal())?
        .ok_or_else(ApiError::not_found)?;
    let prior_status = job.status.clone();
    if job.status == JobStatus::Cancelled {
        OperationEvent::new("job_cancel", "already_cancelled", started.elapsed())
            .job_id(&id)
            .owner_id(&owner.0)
            .transition("cancelled", "cancelled")
            .info();
        return Ok(Json(job));
    }
    if !matches!(
        job.status,
        JobStatus::Queued | JobStatus::Running | JobStatus::CancelRequested
    ) {
        return Err(ApiError::conflict());
    }
    let requested = if job.status == JobStatus::CancelRequested {
        job
    } else {
        match state
            .repository
            .transition(&id, job.status.clone(), JobStatus::CancelRequested)
            .await
        {
            Ok(requested) => requested,
            Err(_) => {
                let current = state
                    .repository
                    .get_for_owner(&id, &owner.0)
                    .await
                    .map_err(|_| ApiError::internal())?
                    .ok_or_else(ApiError::not_found)?;
                match current.status {
                    JobStatus::Cancelled => {
                        OperationEvent::new("job_cancel", "already_cancelled", started.elapsed())
                            .job_id(&id)
                            .owner_id(&owner.0)
                            .transition("cancelled", "cancelled")
                            .info();
                        return Ok(Json(current));
                    }
                    JobStatus::CancelRequested => current,
                    _ => return Err(ApiError::conflict()),
                }
            }
        }
    };
    let comfy = client_for_job(&state, &requested)?;
    if matches!(comfy.cancel(&id).await, Ok(true)) {
        let cancelled = match state
            .repository
            .transition(&id, JobStatus::CancelRequested, JobStatus::Cancelled)
            .await
        {
            Ok(cancelled) => cancelled,
            Err(_) => state
                .repository
                .get_for_owner(&id, &owner.0)
                .await
                .map_err(|_| ApiError::internal())?
                .ok_or_else(ApiError::not_found)?,
        };
        if cancelled.status != JobStatus::Cancelled {
            return Err(ApiError::internal());
        }
        OperationEvent::new("job_cancel", "cancelled", started.elapsed())
            .job_id(&id)
            .owner_id(&owner.0)
            .transition(prior_status.as_str(), "cancelled")
            .info();
        return Ok(Json(cancelled));
    }
    // A false acknowledgement or transport uncertainty is reconciled before
    // returning.  If Comfy still sees it pending/running, restore a state the
    // owner can safely retry; otherwise keep the durable cancellation request.
    match comfy.get_job(&id).await {
        Ok(Some(remote)) => {
            let status = match remote.status {
                RemoteJobStatus::Pending => JobStatus::Queued,
                RemoteJobStatus::InProgress => JobStatus::Running,
                RemoteJobStatus::Completed => JobStatus::Succeeded,
                RemoteJobStatus::Failed => JobStatus::Failed,
                RemoteJobStatus::Cancelled => JobStatus::Cancelled,
            };
            let output_json = serde_json::to_string(&flatten_media_outputs(&remote.outputs)).ok();
            let error = remote.execution_error.map(|value| value.to_string());
            let reconciled = state
                .repository
                .reconcile_observed_status(
                    &id,
                    JobStatus::CancelRequested,
                    status,
                    output_json.as_deref(),
                    error.as_deref(),
                )
                .await
                .map_err(|_| ApiError::internal())?;
            OperationEvent::new("job_cancel", reconciled.status.as_str(), started.elapsed())
                .job_id(&id)
                .owner_id(&owner.0)
                .transition(prior_status.as_str(), reconciled.status.as_str())
                .info();
            Ok(Json(reconciled))
        }
        Ok(None) | Err(_) => {
            OperationEvent::new("job_cancel", "reconcile_unavailable", started.elapsed())
                .job_id(&id)
                .owner_id(&owner.0)
                .transition(prior_status.as_str(), "cancel_requested")
                .warn();
            Ok(Json(requested))
        }
    }
}

pub async fn reconcile_incomplete(
    repository: &JobRepository,
    comfy: &ComfyApi,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let jobs = repository.recover_incomplete().await?;
    stream::iter(jobs)
        .for_each_concurrent(RECONCILE_CONCURRENCY, |job| async move {
            let started = Instant::now();
            let result: Result<(), Box<dyn Error + Send + Sync>> = async {
                let (status, output_json, error) = match comfy.get_job(&job.id).await? {
                    Some(remote) => remote_details(remote, &job.status)?,
                    None => (JobStatus::Orphaned, None, None),
                };
                repository
                    .reconcile_observed_status(
                        &job.id,
                        job.status.clone(),
                        status.clone(),
                        output_json.as_deref(),
                        error.as_deref(),
                    )
                    .await?;
                let result = if status == JobStatus::Orphaned {
                    "orphaned"
                } else {
                    "reconciled"
                };
                OperationEvent::new("job_recovery", result, started.elapsed())
                    .job_id(&job.id)
                    .owner_id(&job.owner_id)
                    .transition(job.status.as_str(), status.as_str())
                    .info();
                Ok(())
            }
            .await;
            if result.is_err() {
                OperationEvent::new("job_recovery", "failed", started.elapsed())
                    .job_id(&job.id)
                    .owner_id(&job.owner_id)
                    .transition(job.status.as_str(), job.status.as_str())
                    .warn();
            }
        })
        .await;
    Ok(())
}

pub async fn reconcile_incomplete_routed(
    repository: &JobRepository,
    workers: &WorkerRegistry,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let jobs = repository.recover_incomplete().await?;
    stream::iter(jobs)
        .for_each_concurrent(RECONCILE_CONCURRENCY, |job| async move {
            let started = Instant::now();
            let result: Result<(), Box<dyn Error + Send + Sync>> = async {
                let worker_id = WorkerId::new(job.worker_id.as_deref().unwrap_or("rtx4090"))
                    .map_err(|error| error.to_owned())?;
                let comfy = workers
                    .client(&worker_id)
                    .ok_or_else(|| "persisted worker is unavailable".to_owned())?;
                let (status, output_json, error) = match comfy.get_job(&job.id).await? {
                    Some(remote) => remote_details(remote, &job.status)?,
                    None => (JobStatus::Orphaned, None, None),
                };
                repository
                    .reconcile_observed_status(
                        &job.id,
                        job.status.clone(),
                        status.clone(),
                        output_json.as_deref(),
                        error.as_deref(),
                    )
                    .await?;
                OperationEvent::new("job_recovery", "reconciled", started.elapsed())
                    .job_id(&job.id)
                    .owner_id(&job.owner_id)
                    .transition(job.status.as_str(), status.as_str())
                    .info();
                Ok(())
            }
            .await;
            if result.is_err() {
                OperationEvent::new("job_recovery", "failed", started.elapsed())
                    .job_id(&job.id)
                    .owner_id(&job.owner_id)
                    .transition(job.status.as_str(), job.status.as_str())
                    .warn();
            }
        })
        .await;
    Ok(())
}

async fn reconcile_job(state: &JobsState, job: Job) -> Result<Job, ApiError> {
    if !matches!(
        job.status,
        JobStatus::Queued | JobStatus::Running | JobStatus::CancelRequested
    ) {
        return Ok(job);
    }
    let comfy = client_for_job(state, &job)?;
    let remote = match comfy.get_job(&job.id).await {
        Ok(remote) => remote,
        // Comfy 5xx/network errors must not overwrite a locally durable row.
        Err(_) => return Ok(job),
    };
    let (status, output_json, error) = match remote {
        Some(remote) => remote_details(remote, &job.status).map_err(|_| ApiError::internal())?,
        None => (JobStatus::Orphaned, None, None),
    };
    state
        .repository
        .reconcile_observed_status(
            &job.id,
            job.status,
            status,
            output_json.as_deref(),
            error.as_deref(),
        )
        .await
        .map_err(|_| ApiError::internal())
}

fn client_for_job(state: &JobsState, job: &Job) -> Result<ComfyApi, ApiError> {
    let id = job.worker_id.as_deref().unwrap_or("rtx4090");
    let id = WorkerId::new(id).map_err(|_| ApiError::internal())?;
    state
        .workers
        .client(&id)
        .ok_or_else(ApiError::service_unavailable)
}

fn routing_error(error: RoutingError) -> ApiError {
    match error {
        RoutingError::UnknownWorker => ApiError::bad_request("unknown worker"),
        RoutingError::Unavailable | RoutingError::NoEligibleWorker => {
            ApiError::service_unavailable()
        }
    }
}

fn remote_details(
    remote: RemoteJob,
    observed: &JobStatus,
) -> Result<(JobStatus, Option<String>, Option<String>), serde_json::Error> {
    let remote_status = match remote.status {
        RemoteJobStatus::Pending => JobStatus::Queued,
        RemoteJobStatus::InProgress => JobStatus::Running,
        RemoteJobStatus::Completed => JobStatus::Succeeded,
        RemoteJobStatus::Failed => JobStatus::Failed,
        RemoteJobStatus::Cancelled => JobStatus::Cancelled,
    };
    // A stale Comfy read cannot revive a cancellation that has already been requested.
    let status = if *observed == JobStatus::CancelRequested
        && matches!(remote_status, JobStatus::Queued | JobStatus::Running)
    {
        JobStatus::CancelRequested
    } else {
        remote_status
    };
    Ok((
        status,
        Some(serde_json::to_string(&flatten_media_outputs(
            &remote.outputs,
        ))?),
        remote.execution_error.map(|error| error.to_string()),
    ))
}
