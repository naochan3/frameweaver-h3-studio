use std::{
    io,
    time::{Duration, Instant},
};

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Path, Request, State, WebSocketUpgrade},
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::any,
};
use futures_util::{SinkExt, StreamExt};
use reqwest::Url;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, protocol::Message},
};
use uuid::Uuid;

use crate::events::OperationEvent;

const MAX_PROXY_BODY_BYTES: usize = 64 * 1024 * 1024;
const MAX_PROXY_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub struct ProxyConfig {
    upstream: Url,
    timeout: Duration,
    response_limit: usize,
    client: reqwest::Client,
}

impl ProxyConfig {
    pub fn new(upstream: Url, timeout: Duration) -> Self {
        Self {
            upstream,
            timeout,
            response_limit: MAX_PROXY_RESPONSE_BYTES,
            client: reqwest::Client::new(),
        }
    }

    pub fn with_response_limit(mut self, response_limit: usize) -> Self {
        self.response_limit = response_limit;
        self
    }
}

pub fn build_router(config: ProxyConfig) -> Router {
    Router::new()
        .route("/comfy/ws", any(proxy_websocket))
        .route("/comfy/{*path}", any(proxy_http_handler))
        .with_state(config)
}

async fn proxy_http_handler(
    State(config): State<ProxyConfig>,
    Path(path): Path<String>,
    request: Request,
) -> Response {
    proxy_http(config, path, request).await
}

async fn proxy_websocket(
    State(config): State<ProxyConfig>,
    uri: Uri,
    upgrade: WebSocketUpgrade,
) -> Response {
    websocket(upgrade, config, "ws".to_owned(), uri).await
}

async fn proxy_http(config: ProxyConfig, path: String, request: Request) -> Response {
    let started = Instant::now();
    let Some(path) = canonical_proxy_path(&path) else {
        OperationEvent::new("proxy_http", "invalid_path", started.elapsed()).warn();
        return StatusCode::FORBIDDEN.into_response();
    };
    if !allowed_http_route(request.method(), &path) {
        OperationEvent::new("proxy_http", "forbidden_route", started.elapsed()).warn();
        return StatusCode::FORBIDDEN.into_response();
    }
    let (parts, body) = request.into_parts();
    let body = match to_bytes(body, MAX_PROXY_BODY_BYTES).await {
        Ok(body) => body,
        Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
    };
    let url = match controlled_upstream_url(&config.upstream, &path, parts.uri.query()) {
        Some(url) => url,
        None => {
            OperationEvent::new("proxy_http", "normalization_failed", started.elapsed()).warn();
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };
    let mut builder = config
        .client
        .request(parts.method, url)
        .timeout(config.timeout)
        .body(body);
    for (name, value) in parts
        .headers
        .iter()
        .filter(|(name, _)| forward_header(name, &parts.headers))
    {
        builder = builder.header(name, value);
    }
    builder = builder.header(header::ORIGIN, origin(&config.upstream));
    match builder.send().await {
        Ok(response) => {
            OperationEvent::new("proxy_http", "upstream_response", started.elapsed()).info();
            upstream_response(
                response,
                response_limit_for_path(&path, config.response_limit),
            )
            .await
        }
        Err(error) if error.is_timeout() => {
            OperationEvent::new("proxy_http", "timeout", started.elapsed()).warn();
            StatusCode::GATEWAY_TIMEOUT.into_response()
        }
        Err(_) => {
            OperationEvent::new("proxy_http", "error", started.elapsed()).warn();
            StatusCode::BAD_GATEWAY.into_response()
        }
    }
}

fn allowed_http_route(method: &axum::http::Method, path: &str) -> bool {
    // Job control goes through the owner-scoped control-plane API.  The proxy
    // only exposes Comfy reads plus the UI's image upload endpoint.
    if *method == axum::http::Method::POST {
        return path == "upload/image";
    }
    if !matches!(*method, axum::http::Method::GET | axum::http::Method::HEAD) {
        return false;
    }
    path == "view"
        || path == "object_info/LoraLoaderModelOnly"
        || path == "object_info/CheckpointLoaderSimple"
        || path == "frameweaver/lora_meta"
        || path
            .strip_prefix("history/")
            .is_some_and(|id| Uuid::parse_str(id).is_ok())
}

fn canonical_proxy_path(path: &str) -> Option<String> {
    let segments = path.split('/').collect::<Vec<_>>();
    if segments.is_empty()
        || segments.iter().any(|segment| {
            segment.is_empty()
                || matches!(*segment, "." | "..")
                // Axum has decoded the request path by now. A remaining percent sign
                // indicates a double-encoded separator or traversal attempt.
                || segment.contains('%')
        })
    {
        return None;
    }
    Some(segments.join("/"))
}

async fn upstream_response(response: reqwest::Response, response_limit: Option<usize>) -> Response {
    if response_limit.is_some_and(|response_limit| {
        response
            .content_length()
            .is_some_and(|content_length| content_length > response_limit as u64)
    }) {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let headers = response.headers().clone();
    let body = match response_limit {
        Some(response_limit) => {
            Body::from_stream(response.bytes_stream().scan(0usize, move |seen, chunk| {
                let next = match chunk {
                    Ok(chunk) if chunk.len() <= response_limit.saturating_sub(*seen) => {
                        *seen += chunk.len();
                        Ok(chunk)
                    }
                    Ok(_) => Err(io::Error::other(
                        "upstream response exceeded configured byte limit",
                    )),
                    Err(error) => Err(io::Error::other(error)),
                };
                futures_util::future::ready(Some(next))
            }))
        }
        None => Body::from_stream(
            response
                .bytes_stream()
                .map(|chunk| chunk.map_err(io::Error::other)),
        ),
    };
    let mut downstream = Response::new(body);
    *downstream.status_mut() = status;
    for (name, value) in headers
        .iter()
        .filter(|(name, _)| forward_header(name, &headers))
    {
        downstream.headers_mut().insert(name, value.clone());
    }
    downstream
}

fn response_limit_for_path(path: &str, default_limit: usize) -> Option<usize> {
    if path.trim_start_matches('/') == "view" {
        None
    } else {
        Some(default_limit)
    }
}

async fn websocket(
    upgrade: WebSocketUpgrade,
    config: ProxyConfig,
    path: String,
    uri: Uri,
) -> Response {
    let upstream = match controlled_upstream_url(&config.upstream, &path, uri.query()) {
        Some(url) => url,
        None => return StatusCode::BAD_GATEWAY.into_response(),
    };
    let client_id = upstream
        .query_pairs()
        .find_map(|(key, value)| (key == "clientId").then(|| value.into_owned()))
        .filter(|value| Uuid::parse_str(value).is_ok());
    upgrade.on_upgrade(move |socket| {
        tunnel_websocket(socket, upstream, origin(&config.upstream), client_id)
    })
}

async fn tunnel_websocket(
    socket: axum::extract::ws::WebSocket,
    mut upstream: Url,
    upstream_origin: HeaderValue,
    client_id: Option<String>,
) {
    let started = Instant::now();
    let scheme = if upstream.scheme() == "https" {
        "wss"
    } else {
        "ws"
    };
    if upstream.set_scheme(scheme).is_err() {
        OperationEvent::new("proxy_websocket", "scheme_error", started.elapsed()).warn();
        return;
    }
    let mut request = match upstream.as_str().into_client_request() {
        Ok(request) => request,
        Err(_) => {
            OperationEvent::new("proxy_websocket", "request_error", started.elapsed()).warn();
            return;
        }
    };
    let origin = match tokio_tungstenite::tungstenite::http::HeaderValue::from_bytes(
        upstream_origin.as_bytes(),
    ) {
        Ok(origin) => origin,
        Err(_) => {
            OperationEvent::new("proxy_websocket", "origin_error", started.elapsed()).warn();
            return;
        }
    };
    request
        .headers_mut()
        .insert(tokio_tungstenite::tungstenite::http::header::ORIGIN, origin);
    let (upstream, _) =
        match tokio::time::timeout(Duration::from_secs(5), connect_async(request)).await {
            Ok(Ok(connection)) => connection,
            Ok(Err(_)) => {
                OperationEvent::new("proxy_websocket", "connect_error", started.elapsed()).warn();
                return;
            }
            Err(_) => {
                OperationEvent::new("proxy_websocket", "connect_timeout", started.elapsed()).warn();
                return;
            }
        };
    let (mut client_sender, mut client_receiver) = socket.split();
    let (mut upstream_sender, mut upstream_receiver) = upstream.split();
    loop {
        tokio::select! {
            message = client_receiver.next() => match message {
                Some(Ok(message)) => if let Some(message) = client_message(message)
                    && upstream_sender.send(message).await.is_err() { break; },
                _ => break,
            },
            message = upstream_receiver.next() => match message {
                Some(Ok(message)) => if let Some(message) = upstream_message(message, client_id.as_deref())
                    && client_sender.send(message).await.is_err() { break; },
                _ => break,
            },
        }
    }
    OperationEvent::new("proxy_websocket", "closed", started.elapsed()).info();
}

fn client_message(message: axum::extract::ws::Message) -> Option<Message> {
    match message {
        axum::extract::ws::Message::Text(text) => Some(Message::Text(text.to_string().into())),
        axum::extract::ws::Message::Binary(bytes) => Some(Message::Binary(bytes.to_vec().into())),
        axum::extract::ws::Message::Ping(bytes) => Some(Message::Ping(bytes.to_vec().into())),
        axum::extract::ws::Message::Pong(bytes) => Some(Message::Pong(bytes.to_vec().into())),
        axum::extract::ws::Message::Close(_) => None,
    }
}

fn upstream_message(
    message: Message,
    client_id: Option<&str>,
) -> Option<axum::extract::ws::Message> {
    match message {
        Message::Text(text) if text_matches_client(text.as_ref(), client_id) => {
            Some(axum::extract::ws::Message::Text(text.to_string().into()))
        }
        Message::Text(_) => None,
        // Comfy previews have no client id.  Forwarding them leaks one
        // browser's in-progress image to every other proxied browser.
        Message::Binary(_) => None,
        Message::Ping(bytes) => Some(axum::extract::ws::Message::Ping(bytes.to_vec().into())),
        Message::Pong(bytes) => Some(axum::extract::ws::Message::Pong(bytes.to_vec().into())),
        Message::Close(_) => None,
        Message::Frame(_) => None,
    }
}

fn text_matches_client(text: &str, client_id: Option<&str>) -> bool {
    let Some(client_id) = client_id else {
        return true;
    };
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(text) else {
        return true;
    };
    let event_client = payload
        .get("client_id")
        .or_else(|| payload.get("clientId"))
        .or_else(|| payload.get("sid"))
        .or_else(|| payload.pointer("/data/client_id"))
        .or_else(|| payload.pointer("/data/clientId"))
        .or_else(|| payload.pointer("/data/sid"))
        .and_then(serde_json::Value::as_str);
    event_client.is_none_or(|event_client| event_client == client_id)
}

pub fn controlled_upstream_url(base: &Url, path: &str, query: Option<&str>) -> Option<Url> {
    let path = canonical_proxy_path(path)?;
    let mut url = base.clone();
    let base_path = url.path().trim_end_matches('/');
    url.set_path(&format!("{base_path}/{path}"));
    url.set_query(query);
    Some(url)
}

fn origin(url: &Url) -> HeaderValue {
    HeaderValue::from_str(&url.origin().ascii_serialization())
        .expect("URL origin is a valid header")
}

fn forward_header(name: &header::HeaderName, headers: &HeaderMap) -> bool {
    !matches!(
        name.as_str(),
        "connection"
            | "host"
            | "origin"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    ) && !headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|nominated| nominated.trim().eq_ignore_ascii_case(name.as_str()))
}
