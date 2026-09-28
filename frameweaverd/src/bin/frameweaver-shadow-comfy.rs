use axum::{
    Json, Router,
    extract::{Path, WebSocketUpgrade, ws::WebSocket},
    response::IntoResponse,
    routing::{get, post},
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() {
    let address = std::env::var("FRAMEWEAVER_SHADOW_COMFY_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:15280".to_owned());
    let listener = TcpListener::bind(&address)
        .await
        .expect("bind shadow Comfy");
    println!("shadow_comfy_listening {address}");
    axum::serve(
        listener,
        Router::new()
            .route("/system_stats", get(system_stats))
            .route("/prompt", post(prompt))
            .route("/api/jobs/{id}", get(job))
            .route("/api/jobs/{id}/cancel", post(cancel))
            .route("/ws", get(ws)),
    )
    .await
    .expect("serve shadow Comfy");
}

async fn system_stats() -> Json<Value> {
    println!("GET /system_stats");
    Json(json!({"system": {"mock": true}}))
}

async fn prompt(Json(body): Json<Value>) -> Json<Value> {
    println!("POST /prompt {body}");
    Json(json!({"number": 1}))
}

async fn job(Path(id): Path<String>) -> Json<Value> {
    println!("GET /api/jobs/{id}");
    Json(json!({"status": "pending", "outputs": [], "error": null}))
}

async fn cancel(Path(id): Path<String>) -> Json<Value> {
    println!("POST /api/jobs/{id}/cancel body=<empty>");
    Json(json!({"cancelled": true}))
}

async fn ws(upgrade: WebSocketUpgrade) -> axum::response::Response {
    println!("GET /ws upgrade=websocket");
    upgrade.on_upgrade(echo).into_response()
}

async fn echo(mut socket: WebSocket) {
    while let Some(Ok(message)) = socket.next().await {
        if socket.send(message).await.is_err() {
            break;
        }
    }
}
