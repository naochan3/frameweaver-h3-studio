use axum::{Json, Router, routing::post};
use frameweaverd::comfy::ComfyApi;
use serde_json::json;
use tokio::net::TcpListener;

#[tokio::test]
async fn submit_exposes_status_message_and_node_ids_without_workflow_contents() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, Router::new().route("/prompt", post(|| async {
            (axum::http::StatusCode::BAD_REQUEST, Json(json!({"error":{"message":"invalid sampler"},"node_errors":{"42":{"errors":[]},"7":{"errors":[]}}})))
        }))).await.unwrap()
    });
    let api = ComfyApi::new(format!("http://{address}").parse().unwrap()).unwrap();
    let error = api
        .submit(
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
            json!({"secret_prompt":"do not leak"}),
        )
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("400") && error.contains("invalid sampler") && error.contains("42,7"));
    assert!(!error.contains("secret_prompt"));
    server.abort();
}
