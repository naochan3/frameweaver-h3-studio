mod collector;
mod model;

use axum::{Json, Router, extract::State, routing::get};
use chrono::{DateTime, Utc};
use model::FleetSample;
pub use model::{FleetSnapshot, Telemetry, WorkerKind, WorkerSpec};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime},
};
use tokio::sync::Mutex;

type Collector = Arc<
    dyn Fn(WorkerSpec) -> Pin<Box<dyn Future<Output = Result<Telemetry, String>> + Send>>
        + Send
        + Sync,
>;
#[derive(Clone)]
pub struct FleetStore {
    inner: Arc<Inner>,
}
struct Inner {
    workers: Vec<WorkerSpec>,
    samples: Mutex<BTreeMap<String, Stored>>,
    collector: Collector,
    active_collectors: AtomicUsize,
}
struct Stored {
    data: Option<Telemetry>,
    host_status: &'static str,
    comfy_status: &'static str,
    last_success: Option<SystemTime>,
    last_attempt: Option<SystemTime>,
    error: Option<String>,
    history: Vec<(SystemTime, u64)>,
    collecting: bool,
}

impl FleetStore {
    pub fn for_workers<F, Fut>(workers: Vec<WorkerSpec>, collect: F) -> Self
    where
        F: Fn(WorkerSpec) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Telemetry, String>> + Send + 'static,
    {
        let samples = workers
            .iter()
            .map(|w| {
                (
                    w.name.clone(),
                    Stored {
                        data: None,
                        host_status: "unknown",
                        comfy_status: "unknown",
                        last_success: None,
                        last_attempt: None,
                        error: None,
                        history: vec![],
                        collecting: false,
                    },
                )
            })
            .collect();
        Self {
            inner: Arc::new(Inner {
                workers,
                samples: Mutex::new(samples),
                collector: Arc::new(move |w| Box::pin(collect(w))),
                active_collectors: AtomicUsize::new(0),
            }),
        }
    }
    pub fn production() -> Self {
        Self::for_workers(
            vec![
                WorkerSpec::local("rtx4090"),
                WorkerSpec::remote("rtx5060ti"),
                WorkerSpec::remote("nicolas2025"),
                WorkerSpec::remote("nicoyuri"),
            ],
            collector::collect,
        )
    }
    pub fn interval_for(&self, name: &str) -> Option<Duration> {
        self.inner
            .workers
            .iter()
            .find(|w| w.name == name)
            .map(|w| match w.kind {
                WorkerKind::Local => Duration::from_secs(2),
                WorkerKind::Remote => Duration::from_secs(15),
            })
    }
    pub async fn refresh(&self) {
        for w in self.inner.workers.clone() {
            self.refresh_worker(w).await
        }
    }
    async fn refresh_worker(&self, worker: WorkerSpec) {
        {
            let mut all = self.inner.samples.lock().await;
            let entry = all.get_mut(&worker.name).expect("worker exists");
            if entry.collecting {
                return;
            }
            entry.collecting = true;
        }
        self.inner.active_collectors.fetch_add(1, Ordering::AcqRel);
        let attempted = SystemTime::now();
        let result = (self.inner.collector)(worker.clone()).await;
        let mut all = self.inner.samples.lock().await;
        let entry = all.get_mut(&worker.name).expect("worker exists");
        entry.collecting = false;
        match result {
            Ok(data) => {
                let now = SystemTime::now();
                entry.history.push((now, data.vram_used));
                entry.comfy_status = if data.comfy_status == "online" {
                    "online"
                } else {
                    "offline"
                };
                entry.data = Some(data);
                entry.host_status = "online";
                entry.last_success = Some(now);
                entry.last_attempt = Some(now);
                entry.error = None
            }
            Err(_) => {
                entry.host_status = "offline";
                entry.comfy_status = "unknown";
                entry.last_attempt = Some(attempted);
                entry.error = Some("telemetry_unavailable".into())
            }
        }
        self.inner.active_collectors.fetch_sub(1, Ordering::AcqRel);
    }
    pub async fn snapshot(&self) -> FleetSnapshot {
        self.snapshot_at(SystemTime::now()).await
    }
    pub async fn snapshot_at(&self, now: SystemTime) -> FleetSnapshot {
        let mut all = self.inner.samples.lock().await;
        let samples = self
            .inner
            .workers
            .iter()
            .map(|w| {
                let entry = all.get_mut(&w.name).expect("worker exists");
                entry.history.retain(|(at, _)| {
                    now.duration_since(*at).unwrap_or_default() <= Duration::from_secs(60)
                });
                let age = entry
                    .last_success
                    .and_then(|at| now.duration_since(at).ok())
                    .map(|d| d.as_millis() as u64);
                FleetSample {
                    worker: w.name.clone(),
                    telemetry: entry.data.clone(),
                    host_status: entry.host_status.into(),
                    comfy_status: entry.comfy_status.into(),
                    age_ms: age,
                    stale: age.is_none()
                        || age.is_some_and(|v| v >= stale_after_ms(w.kind))
                        || entry.host_status != "online",
                    sample_interval_ms: match w.kind {
                        WorkerKind::Local => 2_000,
                        WorkerKind::Remote => 15_000,
                    },
                    peak_vram_used: entry
                        .history
                        .iter()
                        .map(|(_, used)| *used)
                        .max()
                        .or_else(|| entry.data.as_ref().map(|d| d.vram_used)),
                    last_seen_at: entry.last_success.map(iso),
                    last_attempt_at: entry.last_attempt.map(iso),
                    error: entry.error.clone(),
                }
            })
            .collect();
        FleetSnapshot {
            samples,
            at: iso(now),
            collecting: self.inner.active_collectors.load(Ordering::Acquire) > 0,
        }
    }
    pub fn start(&self) {
        for worker in self.inner.workers.clone() {
            let store = self.clone();
            let interval = self.interval_for(&worker.name).expect("worker interval");
            tokio::spawn(async move {
                store.refresh_worker(worker.clone()).await;
                let mut ticker = tokio::time::interval(interval);
                ticker.tick().await;
                loop {
                    ticker.tick().await;
                    store.refresh_worker(worker.clone()).await
                }
            });
        }
    }
}
fn stale_after_ms(kind: WorkerKind) -> u64 {
    match kind {
        WorkerKind::Local => 6_000,
        WorkerKind::Remote => 30_000,
    }
}
fn iso(time: SystemTime) -> String {
    DateTime::<Utc>::from(time).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn build_router(store: FleetStore) -> Router {
    Router::new()
        .route("/api/fleet", get(fleet))
        .with_state(store)
}
async fn fleet(State(store): State<FleetStore>) -> Json<FleetSnapshot> {
    Json(store.snapshot().await)
}
