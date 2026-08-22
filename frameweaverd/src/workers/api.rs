use axum::{Json, Router, extract::State, routing::get};

use super::WorkerRegistry;

pub fn build_router(registry: WorkerRegistry) -> Router {
    Router::new()
        .route("/api/workers", get(list_workers))
        .with_state(registry)
}

async fn list_workers(State(registry): State<WorkerRegistry>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "workers": registry.snapshots().await }))
}
