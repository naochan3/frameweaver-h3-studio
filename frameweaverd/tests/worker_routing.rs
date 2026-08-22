use frameweaverd::workers::{
    RoutingError, RoutingPolicy, WorkerCapability, WorkerId, WorkerPreference, WorkerRequest,
    WorkerSnapshot,
};

fn worker(id: &str, vram: u64, queue: u32, capabilities: &[WorkerCapability]) -> WorkerSnapshot {
    WorkerSnapshot {
        id: WorkerId::new(id).unwrap(),
        label: id.to_owned(),
        capabilities: capabilities.to_vec(),
        online: true,
        stale: false,
        free_vram_mb: vram,
        queue_depth: queue,
    }
}

#[test]
fn auto_prefers_5060_then_light_workers_and_reserves_4090() {
    let snapshots = vec![
        worker(
            "rtx4090",
            20_000,
            0,
            &[WorkerCapability::Image, WorkerCapability::Video],
        ),
        worker("rtx5060ti", 14_000, 1, &[WorkerCapability::Image]),
        worker("rtx3070", 7_000, 0, &[WorkerCapability::Image]),
    ];
    let image = WorkerRequest {
        capability: WorkerCapability::Image,
        required_vram_mb: 10_000,
        preference: WorkerPreference::Auto,
    };
    assert_eq!(
        RoutingPolicy::select(&image, &snapshots).unwrap().as_str(),
        "rtx5060ti"
    );
    let light = WorkerRequest {
        required_vram_mb: 6_000,
        ..image
    };
    assert_eq!(
        RoutingPolicy::select(&light, &snapshots).unwrap().as_str(),
        "rtx3070"
    );
}

#[test]
fn explicit_selection_never_falls_back() {
    let mut selected = worker("rtx3070", 8_000, 0, &[WorkerCapability::Image]);
    selected.online = false;
    let request = WorkerRequest {
        capability: WorkerCapability::Image,
        required_vram_mb: 1_000,
        preference: WorkerPreference::Explicit(WorkerId::new("rtx3070").unwrap()),
    };
    assert_eq!(
        RoutingPolicy::select(&request, &[selected]).unwrap_err(),
        RoutingError::Unavailable
    );
}

#[test]
fn rejects_unknown_stale_role_and_vram_shortage() {
    let snapshots = vec![worker("rtx5060ti", 4_000, 0, &[WorkerCapability::Image])];
    let unknown = WorkerRequest {
        capability: WorkerCapability::Image,
        required_vram_mb: 1,
        preference: WorkerPreference::Explicit(WorkerId::new("missing").unwrap()),
    };
    assert_eq!(
        RoutingPolicy::select(&unknown, &snapshots).unwrap_err(),
        RoutingError::UnknownWorker
    );
    let video = WorkerRequest {
        capability: WorkerCapability::Video,
        required_vram_mb: 1,
        preference: WorkerPreference::Auto,
    };
    assert_eq!(
        RoutingPolicy::select(&video, &snapshots).unwrap_err(),
        RoutingError::NoEligibleWorker
    );
    let large = WorkerRequest {
        capability: WorkerCapability::Image,
        required_vram_mb: 5_000,
        preference: WorkerPreference::Auto,
    };
    assert_eq!(
        RoutingPolicy::select(&large, &snapshots).unwrap_err(),
        RoutingError::NoEligibleWorker
    );
    let mut stale = snapshots[0].clone();
    stale.stale = true;
    let small = WorkerRequest {
        capability: WorkerCapability::Image,
        required_vram_mb: 1,
        preference: WorkerPreference::Auto,
    };
    assert_eq!(
        RoutingPolicy::select(&small, &[stale]).unwrap_err(),
        RoutingError::NoEligibleWorker
    );
}
