use std::{
    future::IntoFuture,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use frameweaverd::fleet::{FleetStore, Telemetry, WorkerKind, WorkerSpec, build_router};

fn telemetry(used: u64) -> Telemetry {
    Telemetry {
        host: "GPU-HOST".into(),
        vram_total: 24_564,
        vram_used: used,
        utilization: 42,
        power_draw: 120.0,
        power_limit: 450.0,
        temperature: 55,
        pstate: "P2".into(),
        power_plan: "バランス".into(),
        comfy_status: "online".into(),
        at: "2026-08-21T08:00:00.000Z".into(),
    }
}

#[tokio::test]
async fn assigns_two_seconds_to_local_and_fifteen_seconds_to_remote_workers() {
    let store = FleetStore::for_workers(
        vec![
            WorkerSpec::local("rtx4090"),
            WorkerSpec::remote("rtx5060ti"),
        ],
        |_| async { Ok(telemetry(2_000)) },
    );

    let snapshot = store.snapshot().await;
    assert_eq!(snapshot.samples[0].sample_interval_ms, 2_000);
    assert_eq!(snapshot.samples[1].sample_interval_ms, 15_000);
}

#[tokio::test]
async fn suppresses_in_flight_refreshes() {
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_for_collect = calls.clone();
    let store = FleetStore::for_workers(vec![WorkerSpec::local("rtx4090")], move |_| {
        let calls = calls_for_collect.clone();
        async move {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(20)).await;
            Ok(telemetry(2_000))
        }
    });

    let first = store.refresh();
    tokio::task::yield_now().await;
    let second = store.refresh();
    tokio::join!(first, second);

    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn failed_refresh_keeps_last_good_values_and_marks_only_that_node_stale() {
    let fail = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let fail_for_collect = fail.clone();
    let store = FleetStore::for_workers(
        vec![
            WorkerSpec::local("rtx4090"),
            WorkerSpec::remote("rtx5060ti"),
        ],
        move |worker| {
            let fail = fail_for_collect.clone();
            async move {
                if worker.name == "rtx5060ti" && fail.load(Ordering::SeqCst) {
                    Err("remote unavailable".into())
                } else {
                    Ok(telemetry(if worker.kind == WorkerKind::Local {
                        2_000
                    } else {
                        3_000
                    }))
                }
            }
        },
    );

    store.refresh().await;
    fail.store(true, Ordering::SeqCst);
    store.refresh().await;
    let snapshot = store.snapshot().await;

    assert_eq!(snapshot.samples[0].host_status, "online");
    assert!(!snapshot.samples[0].stale);
    assert_eq!(snapshot.samples[1].host_status, "offline");
    assert!(snapshot.samples[1].stale);
    assert_eq!(
        snapshot.samples[1]
            .telemetry
            .as_ref()
            .map(|data| data.vram_used),
        Some(3_000)
    );
    assert_eq!(
        snapshot.samples[1].error.as_deref(),
        Some("telemetry_unavailable")
    );
}

#[tokio::test]
async fn local_and_remote_collection_intervals_are_bounded() {
    let store = FleetStore::for_workers(
        vec![
            WorkerSpec::local("rtx4090"),
            WorkerSpec::remote("rtx5060ti"),
        ],
        |_| async { Ok(telemetry(2_000)) },
    );

    assert_eq!(store.interval_for("rtx4090"), Some(Duration::from_secs(2)));
    assert_eq!(
        store.interval_for("rtx5060ti"),
        Some(Duration::from_secs(15))
    );
}

#[tokio::test]
async fn fleet_http_response_has_one_comfy_status_key_and_typescript_compatible_names() {
    let store = FleetStore::for_workers(vec![WorkerSpec::local("rtx4090")], |_| async {
        Ok(telemetry(2_000))
    });
    store.refresh().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(axum::serve(listener, build_router(store)).into_future());

    let body = reqwest::get(format!("http://{address}/api/fleet"))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    server.abort();

    assert_eq!(body.matches("\"comfyStatus\"").count(), 1);
    let value: serde_json::Value = serde_json::from_str(&body).unwrap();
    let sample = &value["samples"][0];
    assert_eq!(sample["vramTotal"], 24_564);
    assert_eq!(sample["sampleIntervalMs"], 2_000);
    assert_eq!(sample["comfyStatus"], "online");
}

#[tokio::test]
async fn local_stales_at_six_seconds_while_remote_stales_at_thirty_seconds() {
    let store = FleetStore::for_workers(
        vec![
            WorkerSpec::local("rtx4090"),
            WorkerSpec::remote("rtx5060ti"),
        ],
        |_| async { Ok(telemetry(2_000)) },
    );
    store.refresh().await;
    let at = std::time::SystemTime::now() + Duration::from_millis(6_000);
    let snapshot = store.snapshot_at(at).await;

    assert!(snapshot.samples[0].stale);
    assert!(!snapshot.samples[1].stale);
}

#[tokio::test]
async fn scheduler_and_manual_refresh_share_worker_in_flight_state() {
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_for_collect = calls.clone();
    let store = FleetStore::for_workers(vec![WorkerSpec::local("rtx4090")], move |_| {
        let calls = calls_for_collect.clone();
        async move {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(40)).await;
            Ok(telemetry(2_000))
        }
    });

    store.start();
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert!(store.snapshot().await.collecting);
    store.refresh().await;

    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
