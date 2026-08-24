use std::{
    io::{self, Write},
    path::PathBuf,
    sync::{Arc, Mutex, Once, OnceLock},
    time::Duration,
};

use axum::{
    Router,
    body::{Body, Bytes},
    extract::{
        State,
        ws::{WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    response::IntoResponse,
    routing::{any, get},
};
use frameweaverd::{
    comfy::ComfyApi,
    jobs::{JobRepository, NewJob},
    proxy::{ProxyConfig, build_router as build_proxy_router, controlled_upstream_url},
    static_files::build_router as build_static_router,
    workers::WorkerRegistry,
};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::{sync::Barrier, time::timeout};
use tracing_subscriber::fmt::MakeWriter;
use uuid::Uuid;

#[derive(Clone, Default)]
struct UpstreamRecord {
    request_path: Arc<Mutex<Option<String>>>,
    origin: Arc<Mutex<Option<String>>>,
    headers: Arc<Mutex<HeaderMap>>,
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

async fn upstream(
    State(record): State<UpstreamRecord>,
    headers: HeaderMap,
    uri: Uri,
) -> impl IntoResponse {
    *record.request_path.lock().unwrap() = Some(uri.to_string());
    *record.origin.lock().unwrap() = headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    *record.headers.lock().unwrap() = headers;
    (StatusCode::OK, "proxied")
}

async fn delayed_upstream() -> impl IntoResponse {
    tokio::time::sleep(Duration::from_millis(100)).await;
    "too late"
}

async fn oversized_response(uri: Uri) -> axum::response::Response {
    if uri.query() == Some("stream=1") {
        return Body::from_stream(futures_util::stream::iter(vec![
            Ok::<_, std::convert::Infallible>(Bytes::from_static(b"123456789")),
            Ok(Bytes::from_static(b"abcdefghi")),
        ]))
        .into_response();
    }
    let mut response = Body::from(vec![b'x'; 17]).into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, HeaderValue::from_static("17"));
    response
}

async fn large_view(uri: Uri) -> axum::response::Response {
    let payload = vec![b'v'; 8 * 1024 * 1024 + 32];
    if uri.query() == Some("stream=1") {
        return Body::from_stream(futures_util::stream::iter(vec![
            Ok::<_, std::convert::Infallible>(Bytes::from(payload)),
            Ok(Bytes::from_static(b"view-tail")),
        ]))
        .into_response();
    }
    let mut response = Body::from(payload).into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, HeaderValue::from_static("8388640"));
    response
}

async fn hop_headers(
    State(record): State<UpstreamRecord>,
    headers: HeaderMap,
) -> axum::response::Response {
    *record.headers.lock().unwrap() = headers;
    let mut response = "proxied".into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONNECTION, HeaderValue::from_static("x-remove"));
    headers.insert("x-remove", HeaderValue::from_static("secret"));
    headers.insert("keep-alive", HeaderValue::from_static("timeout=5"));
    headers.insert(header::TE, HeaderValue::from_static("trailers"));
    headers.insert(header::TRAILER, HeaderValue::from_static("x-trailer"));
    headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    response
}

async fn echo_socket(socket: WebSocketUpgrade) -> impl IntoResponse {
    socket.on_upgrade(|mut socket: WebSocket| async move {
        while let Some(Ok(message)) = socket.recv().await {
            if socket.send(message).await.is_err() {
                break;
            }
        }
    })
}

#[derive(Clone)]
struct BroadcastState {
    connected: std::sync::Arc<Barrier>,
    owner_a: String,
    owner_b: String,
}

async fn broadcast_socket(
    State(state): State<BroadcastState>,
    socket: WebSocketUpgrade,
) -> impl IntoResponse {
    socket.on_upgrade(move |mut socket: WebSocket| async move {
        state.connected.wait().await;
        for message in [
            axum::extract::ws::Message::Text(
                serde_json::json!({"type":"executing","data":{"sid":state.owner_a,"node":null}})
                    .to_string()
                    .into(),
            ),
            axum::extract::ws::Message::Text(
                serde_json::json!({"type":"executing","data":{"sid":state.owner_b,"node":null}})
                    .to_string()
                    .into(),
            ),
            axum::extract::ws::Message::Binary(vec![0x89, 0x50].into()),
        ] {
            if socket.send(message).await.is_err() {
                break;
            }
        }
    })
}

async fn websocket_texts(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Vec<String> {
    let mut texts = Vec::new();
    while let Ok(Some(Ok(message))) = timeout(Duration::from_millis(250), socket.next()).await {
        match message {
            tokio_tungstenite::tungstenite::Message::Text(text) => texts.push(text.to_string()),
            tokio_tungstenite::tungstenite::Message::Binary(_) => {
                panic!("binary frame leaked through the proxy")
            }
            _ => {}
        }
    }
    texts
}

async fn start_server(app: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}"), server)
}

fn fixture_dist() -> PathBuf {
    let directory = std::env::temp_dir().join(format!("frameweaverd-static-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("index.html"), "<main>studio</main>").unwrap();
    std::fs::write(directory.join("app-CXvmzkoc.js"), "console.log('studio')").unwrap();
    directory
}

#[tokio::test]
async fn static_router_falls_back_to_index_without_swallowing_api_or_comfy_paths() {
    let dist = fixture_dist();
    let (base_url, server) = start_server(build_static_router(dist.clone())).await;
    let client = reqwest::Client::new();

    let studio = client
        .get(format!("{base_url}/projects/42"))
        .header(header::ACCEPT, "text/html")
        .send()
        .await
        .unwrap();
    assert_eq!(studio.status(), StatusCode::OK);
    assert_eq!(studio.text().await.unwrap(), "<main>studio</main>");
    assert_eq!(
        client
            .get(format!("{base_url}/api/missing"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        client
            .get(format!("{base_url}/assets/missing.js"))
            .header(header::ACCEPT, "text/html")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        client
            .get(format!("{base_url}/projects/42"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        client
            .get(format!("{base_url}/comfy/missing"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );

    server.abort();
    std::fs::remove_dir_all(dist).unwrap();
}

#[tokio::test]
async fn static_router_marks_hashed_assets_immutable() {
    let dist = fixture_dist();
    let (base_url, server) = start_server(build_static_router(dist.clone())).await;

    let response = reqwest::get(format!("{base_url}/app-CXvmzkoc.js"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["cache-control"],
        "public, max-age=31536000, immutable"
    );

    server.abort();
    std::fs::remove_dir_all(dist).unwrap();
}

#[tokio::test]
async fn proxy_rewrites_comfy_path_and_origin() {
    let record = UpstreamRecord::default();
    let upstream_app = Router::new()
        .fallback(any(upstream))
        .with_state(record.clone());
    let (upstream_url, upstream_server) = start_server(upstream_app).await;
    let (base_url, proxy_server) = start_server(build_proxy_router(ProxyConfig::new(
        upstream_url.parse().unwrap(),
        Duration::from_secs(1),
    )))
    .await;

    let response = reqwest::Client::new()
        .get(format!("{base_url}/comfy/view?filename=cat.png"))
        .header("origin", "http://studio.example")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        record.request_path.lock().unwrap().as_deref(),
        Some("/view?filename=cat.png")
    );
    assert_eq!(
        record.origin.lock().unwrap().as_deref(),
        Some(upstream_url.as_str())
    );

    proxy_server.abort();
    upstream_server.abort();
}

#[tokio::test]
async fn routed_history_is_sent_only_to_its_owner_and_recorded_worker() {
    let record = UpstreamRecord::default();
    let (upstream_url, upstream_server) = start_server(
        Router::new()
            .fallback(any(upstream))
            .with_state(record.clone()),
    )
    .await;
    let repository = JobRepository::open(
        std::env::temp_dir().join(format!("frameweaver-proxy-{}.db", Uuid::new_v4())),
    )
    .await
    .unwrap();
    let owner = Uuid::new_v4().to_string();
    let job = repository
        .create_routed(
            NewJob {
                owner_id: owner.clone(),
                kind: "image".into(),
                mode: "txt2img".into(),
                prompt: "safe".into(),
                settings_json: "{}".into(),
            },
            Some("rtx4090"),
        )
        .await
        .unwrap();
    let comfy = ComfyApi::new(upstream_url.parse().unwrap()).unwrap();
    let (base_url, proxy_server) = start_server(build_proxy_router(
        ProxyConfig::new(
            "http://127.0.0.1:9".parse().unwrap(),
            Duration::from_secs(1),
        )
        .with_job_routing(repository, WorkerRegistry::local(comfy)),
    ))
    .await;
    let client = reqwest::Client::new();
    assert_eq!(
        client
            .get(format!("{base_url}/comfy/history/{}", job.id))
            .header("X-FrameWeaver-Owner", &owner)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .get(format!("{base_url}/comfy/history/{}", job.id))
            .header("X-FrameWeaver-Owner", Uuid::new_v4().to_string())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        record.request_path.lock().unwrap().as_deref(),
        Some(format!("/history/{}", job.id).as_str())
    );
    proxy_server.abort();
    upstream_server.abort();
}

#[tokio::test]
async fn proxy_blocks_mutating_comfy_routes_without_contacting_upstream() {
    let record = UpstreamRecord::default();
    let upstream = Router::new()
        .fallback(any(upstream))
        .with_state(record.clone());
    let (upstream_url, upstream_server) = start_server(upstream).await;
    let (base_url, proxy_server) = start_server(build_proxy_router(ProxyConfig::new(
        upstream_url.parse().unwrap(),
        Duration::from_secs(1),
    )))
    .await;

    for path in [
        "prompt",
        "queue",
        "interrupt",
        "api/jobs/1/cancel",
        "frameweaver/open_output",
    ] {
        let response = reqwest::Client::new()
            .post(format!("{base_url}/comfy/{path}"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
    }
    assert!(
        record.request_path.lock().unwrap().is_none(),
        "blocked proxy requests reached upstream"
    );

    proxy_server.abort();
    upstream_server.abort();
}

#[tokio::test]
async fn proxy_allowlist_rejects_bare_history_and_unknown_custom_reads() {
    let record = UpstreamRecord::default();
    let (upstream_url, upstream_server) = start_server(
        Router::new()
            .fallback(any(upstream))
            .with_state(record.clone()),
    )
    .await;
    let (base_url, proxy_server) = start_server(build_proxy_router(ProxyConfig::new(
        upstream_url.parse().unwrap(),
        Duration::from_secs(1),
    )))
    .await;
    for path in [
        "history",
        "history/not-a-uuid",
        "object_info",
        "object_info/OtherNode",
        "object_info/LoraLoaderModelOnly/extra",
        "custom/secret",
        "prompt",
        "object_info/%2e%2e/history",
        "object_info/%2Fhistory",
        "object_info/%252e%252e/history",
        "object_info//LoraLoaderModelOnly",
    ] {
        assert_eq!(
            reqwest::get(format!("{base_url}/comfy/{path}"))
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        reqwest::get(format!("{base_url}/comfy/object_info/LoraLoaderModelOnly"))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    for path in [
        "object_info/CheckpointLoaderSimple",
        "frameweaver/lora_meta",
    ] {
        assert_eq!(
            reqwest::get(format!("{base_url}/comfy/{path}"))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        reqwest::get(format!(
            "{base_url}/comfy/history/11111111-1111-4111-8111-111111111111"
        ))
        .await
        .unwrap()
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        record.request_path.lock().unwrap().as_deref(),
        Some("/history/11111111-1111-4111-8111-111111111111")
    );
    proxy_server.abort();
    upstream_server.abort();
}

#[test]
fn controlled_upstream_paths_cannot_replace_configured_authority_for_http_or_websocket() {
    let configured: reqwest::Url = "http://127.0.0.1:8188/comfy/".parse().unwrap();

    assert!(controlled_upstream_url(&configured, "http://attacker.test/steal", None).is_none());
    assert!(controlled_upstream_url(&configured, "ws://attacker.test/steal", None).is_none());
}

#[test]
fn controlled_upstream_url_rejects_noncanonical_segments_and_preserves_authority_and_path() {
    let configured: reqwest::Url = "http://127.0.0.1:8188/comfy/".parse().unwrap();
    for path in [
        "",
        "/view",
        "object_info//LoraLoaderModelOnly",
        "object_info/./LoraLoaderModelOnly",
        "object_info/../history",
        "object_info/%2e%2e/history",
        "object_info/%252e%252e/history",
        "http://attacker.test/steal",
    ] {
        assert!(
            controlled_upstream_url(&configured, path, Some("filename=cat.png")).is_none(),
            "accepted noncanonical path {path}"
        );
    }
    let normalized = controlled_upstream_url(
        &configured,
        "history/11111111-1111-4111-8111-111111111111",
        Some("filename=cat.png"),
    )
    .unwrap();
    assert_eq!(normalized.scheme(), configured.scheme());
    assert_eq!(normalized.host_str(), configured.host_str());
    assert_eq!(normalized.port(), configured.port());
    assert_eq!(
        normalized.path(),
        "/comfy/history/11111111-1111-4111-8111-111111111111"
    );
    assert_eq!(normalized.query(), Some("filename=cat.png"));
}

#[tokio::test]
async fn proxy_rejects_oversized_content_length_and_streamed_response_bodies() {
    let upstream = Router::new().route("/object_info/LoraLoaderModelOnly", get(oversized_response));
    let (upstream_url, upstream_server) = start_server(upstream).await;
    let config = ProxyConfig::new(upstream_url.parse().unwrap(), Duration::from_secs(1))
        .with_response_limit(16);
    let (base_url, proxy_server) = start_server(build_proxy_router(config)).await;

    let content_length = reqwest::get(format!("{base_url}/comfy/object_info/LoraLoaderModelOnly"))
        .await
        .unwrap();
    assert_eq!(content_length.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let streamed = reqwest::get(format!(
        "{base_url}/comfy/object_info/LoraLoaderModelOnly?stream=1"
    ))
    .await
    .unwrap();
    assert!(
        streamed.bytes().await.is_err(),
        "streamed oversized body must terminate with an error"
    );

    proxy_server.abort();
    upstream_server.abort();
}

#[tokio::test]
async fn proxy_streams_large_view_results_past_the_api_response_cap() {
    let upstream = Router::new().route("/view", get(large_view));
    let (upstream_url, upstream_server) = start_server(upstream).await;
    let (base_url, proxy_server) = start_server(build_proxy_router(ProxyConfig::new(
        upstream_url.parse().unwrap(),
        Duration::from_secs(1),
    )))
    .await;

    for suffix in ["", "?stream=1"] {
        let response = reqwest::get(format!("{base_url}/comfy/view{suffix}"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.bytes().await.unwrap();
        assert!(bytes.len() > 8 * 1024 * 1024);
        assert!(bytes.ends_with(b"view-tail") || suffix.is_empty());
    }

    proxy_server.abort();
    upstream_server.abort();
}

#[tokio::test]
async fn proxy_strips_standard_and_connection_nominated_hop_headers() {
    let record = UpstreamRecord::default();
    let upstream = Router::new()
        .route("/headers", get(hop_headers))
        .with_state(record.clone());
    let (upstream_url, upstream_server) = start_server(upstream).await;
    let (base_url, proxy_server) = start_server(build_proxy_router(ProxyConfig::new(
        upstream_url.parse().unwrap(),
        Duration::from_secs(1),
    )))
    .await;

    let response = reqwest::Client::new()
        .get(format!("{base_url}/comfy/headers"))
        .header(header::CONNECTION, "x-request-remove")
        .header("x-request-remove", "secret")
        .header("keep-alive", "timeout=5")
        .send()
        .await
        .unwrap();
    let received = record.headers.lock().unwrap();
    assert!(!received.contains_key("x-request-remove"));
    assert!(!received.contains_key("keep-alive"));
    drop(received);
    for name in [
        header::CONNECTION,
        header::HeaderName::from_static("keep-alive"),
        header::TE,
        header::TRAILER,
        header::UPGRADE,
        header::HeaderName::from_static("x-remove"),
    ] {
        assert!(
            !response.headers().contains_key(name),
            "hop-by-hop header leaked"
        );
    }

    proxy_server.abort();
    upstream_server.abort();
}

#[tokio::test]
async fn proxy_returns_gateway_timeout_when_upstream_exceeds_bound() {
    let (upstream_url, upstream_server) = start_server(
        Router::new().route("/object_info/LoraLoaderModelOnly", get(delayed_upstream)),
    )
    .await;
    let (base_url, proxy_server) = start_server(build_proxy_router(ProxyConfig::new(
        upstream_url.parse().unwrap(),
        Duration::from_millis(20),
    )))
    .await;

    let response = timeout(
        Duration::from_secs(1),
        reqwest::get(format!("{base_url}/comfy/object_info/LoraLoaderModelOnly")),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);

    proxy_server.abort();
    upstream_server.abort();
}

#[tokio::test]
async fn proxy_tunnels_websocket_echo() {
    let (upstream_url, upstream_server) =
        start_server(Router::new().route("/ws", get(echo_socket))).await;
    let (base_url, proxy_server) = start_server(build_proxy_router(ProxyConfig::new(
        upstream_url.parse().unwrap(),
        Duration::from_secs(1),
    )))
    .await;
    let ws_url = base_url.replacen("http", "ws", 1) + "/comfy/ws";

    let (mut socket, _) = tokio_tungstenite::connect_async(ws_url).await.unwrap();
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            "frameweaver".into(),
        ))
        .await
        .unwrap();
    let reply = socket.next().await.unwrap().unwrap();
    assert_eq!(reply.into_text().unwrap(), "frameweaver");

    proxy_server.abort();
    upstream_server.abort();
}

#[tokio::test]
async fn proxy_websocket_filters_other_clients_completion_events_and_all_binary_frames() {
    let owner_a = Uuid::new_v4().to_string();
    let owner_b = Uuid::new_v4().to_string();
    let state = BroadcastState {
        connected: std::sync::Arc::new(Barrier::new(2)),
        owner_a: owner_a.clone(),
        owner_b: owner_b.clone(),
    };
    let (upstream_url, upstream_server) = start_server(
        Router::new()
            .route("/ws", get(broadcast_socket))
            .with_state(state),
    )
    .await;
    let (base_url, proxy_server) = start_server(build_proxy_router(ProxyConfig::new(
        upstream_url.parse().unwrap(),
        Duration::from_secs(1),
    )))
    .await;
    let ws_base = base_url.replacen("http", "ws", 1);

    let (mut client_a, _) =
        tokio_tungstenite::connect_async(format!("{ws_base}/comfy/ws?clientId={owner_a}"))
            .await
            .unwrap();
    let (mut client_b, _) =
        tokio_tungstenite::connect_async(format!("{ws_base}/comfy/ws?clientId={owner_b}"))
            .await
            .unwrap();
    let a_messages = websocket_texts(&mut client_a).await;
    let b_messages = websocket_texts(&mut client_b).await;

    assert_eq!(a_messages.len(), 1);
    assert!(a_messages[0].contains(&owner_a));
    assert!(!a_messages[0].contains(&owner_b));
    assert_eq!(b_messages.len(), 1);
    assert!(b_messages[0].contains(&owner_b));
    assert!(!b_messages[0].contains(&owner_a));

    proxy_server.abort();
    upstream_server.abort();
}

#[tokio::test]
async fn proxy_logs_capture_only_operation_results_without_request_secrets() {
    let sink = installed_log_sink();
    let log_offset = sink.0.lock().unwrap().len();
    let (upstream_url, upstream_server) = start_server(
        Router::new()
            .route("/object_info/LoraLoaderModelOnly", get(delayed_upstream))
            .route("/ws", get(echo_socket)),
    )
    .await;
    let (base_url, proxy_server) = start_server(build_proxy_router(ProxyConfig::new(
        upstream_url.parse().unwrap(),
        Duration::from_millis(20),
    )))
    .await;
    let secret = "never-log-this-secret";
    let response = reqwest::Client::new()
        .get(format!(
            "{base_url}/comfy/object_info/LoraLoaderModelOnly?token={secret}"
        ))
        .header("authorization", format!("Bearer {secret}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
    let ws_url = base_url.replacen("http", "ws", 1) + "/comfy/ws";
    let (socket, _) = tokio_tungstenite::connect_async(ws_url).await.unwrap();
    drop(socket);
    tokio::time::sleep(Duration::from_millis(50)).await;

    let logs = String::from_utf8(sink.0.lock().unwrap()[log_offset..].to_vec()).unwrap();
    assert!(
        logs.contains("proxy_http"),
        "missing HTTP proxy log: {logs}"
    );
    assert!(
        logs.contains("proxy_websocket"),
        "missing WS proxy log: {logs}"
    );
    assert!(
        !logs.contains(secret),
        "request secret leaked into proxy log"
    );

    proxy_server.abort();
    upstream_server.abort();
}
