use std::{net::SocketAddr, sync::Arc, time::Duration};

use axum::{Router, http::StatusCode, routing::get};
use frameweaverd::{
    auth::AuthConfig,
    config::AppConfig,
    health::{AppState, build_router},
};
use reqwest::Url;
use tokio::{net::TcpListener, time::timeout};

#[tokio::test]
async fn health_api_returns_required_status_within_two_seconds() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let state = AppState::new(
        AppConfig::new(
            "127.0.0.1:0".parse().unwrap(),
            "http://127.0.0.1:9".parse().unwrap(),
            Duration::from_millis(1),
        )
        .unwrap(),
        true,
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, build_router(state)).await.unwrap();
    });

    let response = timeout(
        Duration::from_secs(2),
        reqwest::get(format!("http://{address}/api/health")),
    )
    .await
    .expect("health request exceeded two seconds")
    .unwrap();

    assert_eq!(response.status(), reqwest::StatusCode::OK);

    let body: serde_json::Value = response.json().await.unwrap();
    for key in ["service", "database", "comfy", "build"] {
        assert!(body.get(key).is_some(), "missing health key: {key}");
    }

    server.abort();
}

#[test]
fn app_config_rejects_non_http_comfy_base_urls() {
    let listen_addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let non_http_url = "mailto:frameweaver@example.test".parse().unwrap();

    assert!(AppConfig::new(listen_addr, non_http_url, Duration::from_secs(1)).is_err());
}

#[test]
fn app_config_carries_validated_auth_configuration() {
    let auth = AuthConfig::from_values(
        true,
        Some("123456789012345678"),
        Some("client-secret"),
        Some("https://rtx4090.tail37947a.ts.net:10000/auth/callback"),
        Some("987654321098765432"),
        Some("0123456789abcdef0123456789abcdef"),
    )
    .unwrap();
    let config = AppConfig::with_auth(
        "127.0.0.1:5180".parse().unwrap(),
        Url::parse("http://127.0.0.1:8188").unwrap(),
        Duration::from_secs(1),
        auth,
    )
    .unwrap();

    assert!(config.auth().enabled().is_some());
}

#[tokio::test]
async fn health_retries_comfy_probe_after_a_failed_probe() {
    let visits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let comfy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let comfy_address = comfy_listener.local_addr().unwrap();
    let comfy_visits = visits.clone();
    let comfy_server = tokio::spawn(async move {
        let app = Router::new().route(
            "/system_stats",
            get(move || {
                let comfy_visits = comfy_visits.clone();
                async move {
                    if comfy_visits.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                        StatusCode::SERVICE_UNAVAILABLE
                    } else {
                        StatusCode::OK
                    }
                }
            }),
        );
        axum::serve(comfy_listener, app).await.unwrap();
    });

    let health_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let health_address = health_listener.local_addr().unwrap();
    let state = AppState::new(
        AppConfig::new(
            "127.0.0.1:0".parse().unwrap(),
            format!("http://{comfy_address}").parse().unwrap(),
            Duration::from_millis(10),
        )
        .unwrap(),
        true,
    );
    let health_server = tokio::spawn(async move {
        axum::serve(health_listener, build_router(state))
            .await
            .unwrap();
    });

    let health_url = format!("http://{health_address}/api/health");
    reqwest::get(&health_url).await.unwrap();
    wait_for_visits(&visits, 1).await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    reqwest::get(&health_url).await.unwrap();
    wait_for_visits(&visits, 2).await;

    health_server.abort();
    comfy_server.abort();
}

async fn wait_for_visits(visits: &std::sync::atomic::AtomicUsize, expected: usize) {
    timeout(Duration::from_secs(1), async {
        while visits.load(std::sync::atomic::Ordering::SeqCst) < expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("Comfy probe was not retried");
}
