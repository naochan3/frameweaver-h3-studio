use super::{WorkerId, WorkerPreference, WorkerRequest, WorkerSnapshot};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoutingError {
    UnknownWorker,
    Unavailable,
    NoEligibleWorker,
}

pub struct RoutingPolicy;

impl RoutingPolicy {
    pub fn select(
        request: &WorkerRequest,
        snapshots: &[WorkerSnapshot],
    ) -> Result<WorkerId, RoutingError> {
        if let WorkerPreference::Explicit(id) = &request.preference {
            let worker = snapshots
                .iter()
                .find(|worker| &worker.id == id)
                .ok_or(RoutingError::UnknownWorker)?;
            return eligible(request, worker)
                .then(|| id.clone())
                .ok_or(RoutingError::Unavailable);
        }

        snapshots
            .iter()
            .filter(|worker| eligible(request, worker))
            .min_by_key(|worker| {
                (
                    preference_rank(worker.id.as_str(), request.required_vram_mb),
                    worker.queue_depth,
                    std::cmp::Reverse(worker.free_vram_mb),
                    worker.id.as_str(),
                )
            })
            .map(|worker| worker.id.clone())
            .ok_or(RoutingError::NoEligibleWorker)
    }
}

fn eligible(request: &WorkerRequest, worker: &WorkerSnapshot) -> bool {
    worker.online
        && !worker.stale
        && worker.free_vram_mb >= request.required_vram_mb
        && worker.capabilities.contains(&request.capability)
}

fn preference_rank(id: &str, required_vram_mb: u64) -> u8 {
    if required_vram_mb <= 8_192 {
        match id {
            "rtx3070" => 0,
            "rtx2070" => 1,
            "rtx5060ti" => 2,
            "rtx4090" => 4,
            _ => 3,
        }
    } else {
        match id {
            "rtx5060ti" => 0,
            "rtx3070" => 1,
            "rtx2070" => 2,
            "rtx4090" => 4,
            _ => 3,
        }
    }
}
