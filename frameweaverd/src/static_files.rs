use std::{
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};

#[derive(Clone)]
struct StaticFiles {
    root: Arc<PathBuf>,
}

pub fn build_router(root: PathBuf) -> Router {
    Router::new().fallback(get(serve)).with_state(StaticFiles {
        root: Arc::new(root),
    })
}

async fn serve(State(files): State<StaticFiles>, request: Request) -> Response {
    let path = request.uri().path();
    if path.starts_with("/api/")
        || path == "/api"
        || path.starts_with("/comfy/")
        || path == "/comfy"
    {
        return StatusCode::NOT_FOUND.into_response();
    }

    let candidate = path.strip_prefix('/').unwrap_or(path);
    if let Some(file) = safe_path(&files.root, candidate).filter(|path| path.is_file()) {
        return file_response(&file);
    }
    if candidate == "assets"
        || candidate.starts_with("assets/")
        || !is_html_navigation(request.method(), request.headers())
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    file_response(&files.root.join("index.html"))
}

fn is_html_navigation(method: &Method, headers: &axum::http::HeaderMap) -> bool {
    matches!(*method, Method::GET | Method::HEAD)
        && headers
            .get(header::ACCEPT)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|accept| accept.contains("text/html"))
}

fn safe_path(root: &Path, requested: &str) -> Option<PathBuf> {
    let candidate = Path::new(requested);
    if candidate
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    Some(root.join(candidate))
}

fn file_response(path: &Path) -> Response {
    match std::fs::read(path) {
        Ok(contents) => {
            let mut response = Response::new(Body::from(contents));
            response
                .headers_mut()
                .insert(header::CONTENT_TYPE, content_type(path));
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static(if is_hashed_asset(path) {
                    "public, max-age=31536000, immutable"
                } else {
                    "no-cache"
                }),
            );
            response
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

fn is_hashed_asset(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.rsplit_once('.').map(|(stem, _)| stem))
        .and_then(|stem| stem.rsplit_once('-').map(|(_, hash)| hash))
        .is_some_and(|hash| {
            hash.len() >= 8
                && hash
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        })
}

fn content_type(path: &Path) -> HeaderValue {
    let value = match path.extension().and_then(|extension| extension.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("json") => "application/json; charset=utf-8",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    };
    HeaderValue::from_static(value)
}
