use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{Json, Router, routing::get};
use serde::Serialize;
use tokio::sync::RwLock;

use crate::{config::AppConfig, events::OperationEvent};

const COMFY_PROBE_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Clone)]
pub struct AppState {
    client: reqwest::Client,
    comfy_url: reqwest::Url,
    health_cache_ttl: Duration,
    comfy_cache: Arc<RwLock<CachedComfyHealth>>,
    probe_in_flight: Arc<AtomicBool>,
    database_ready: bool,
    started_at: u64,
}

impl AppState {
    pub fn new(config: AppConfig, database_ready: bool) -> Self {
        Self {
            client: reqwest::Client::new(),
            comfy_url: config.comfy_url().clone(),
            health_cache_ttl: config.health_cache_ttl(),
            comfy_cache: Arc::new(RwLock::new(CachedComfyHealth::unknown())),
            probe_in_flight: Arc::new(AtomicBool::new(false)),
            database_ready,
            started_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock is after Unix epoch")
                .as_secs(),
        }
    }
}

struct CachedComfyHealth {
    status: ComfyStatus,
    checked_at: Option<Instant>,
}

struct ProbeInFlight(Arc<AtomicBool>);

impl Drop for ProbeInFlight {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl CachedComfyHealth {
    fn unknown() -> Self {
        Self {
            status: ComfyStatus::Unknown,
            checked_at: None,
        }
    }

    fn is_stale(&self, ttl: Duration) -> bool {
        self.checked_at
            .is_none_or(|checked_at| checked_at.elapsed() >= ttl)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ComfyStatus {
    Unknown,
    Up,
    Down,
}

#[derive(Serialize)]
struct HealthResponse {
    service: &'static str,
    database: &'static str,
    comfy: ComfyStatus,
    build: BuildMetadata,
}

#[derive(Serialize)]
struct BuildMetadata {
    sha: &'static str,
    version: &'static str,
    started_at: u64,
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .with_state(state)
}

async fn health(state: axum::extract::State<AppState>) -> Json<HealthResponse> {
    let cache = state.comfy_cache.read().await;
    let comfy = cache.status;
    let should_probe = cache.is_stale(state.health_cache_ttl);
    drop(cache);

    if should_probe
        && state
            .probe_in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    {
        tokio::spawn(probe_comfy(state.0.clone()));
    }

    Json(HealthResponse {
        service: if state.database_ready {
            "ready"
        } else {
            "degraded"
        },
        database: if state.database_ready {
            "ready"
        } else {
            "degraded"
        },
        comfy,
        build: BuildMetadata {
            sha: option_env!("FRAMEWEAVER_BUILD_SHA").unwrap_or("dev"),
            version: env!("CARGO_PKG_VERSION"),
            started_at: state.started_at,
        },
    })
}

async fn probe_comfy(state: AppState) {
    let _in_flight = ProbeInFlight(state.probe_in_flight.clone());
    let started = Instant::now();
    let status = match state.comfy_url.join("system_stats") {
        Ok(url) => match state
            .client
            .get(url)
            .timeout(COMFY_PROBE_TIMEOUT)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => ComfyStatus::Up,
            Ok(_) | Err(_) => ComfyStatus::Down,
        },
        Err(_) => ComfyStatus::Down,
    };

    let mut cache = state.comfy_cache.write().await;
    let previous = cache.status;
    if !matches!(cache.status, ComfyStatus::Unknown) && cache.status != status {
        OperationEvent::new("comfy_health", "transition", started.elapsed())
            .transition(comfy_status_name(previous), comfy_status_name(status))
            .info();
    }
    let event = OperationEvent::new(
        "comfy_health",
        if status == ComfyStatus::Up {
            "up"
        } else {
            "down"
        },
        started.elapsed(),
    )
    .transition(comfy_status_name(previous), comfy_status_name(status));
    if status == ComfyStatus::Up {
        event.info();
    } else {
        event.warn();
    }
    *cache = CachedComfyHealth {
        status,
        checked_at: Some(Instant::now()),
    };
}

fn comfy_status_name(status: ComfyStatus) -> &'static str {
    match status {
        ComfyStatus::Unknown => "unknown",
        ComfyStatus::Up => "up",
        ComfyStatus::Down => "down",
    }
}
