use std::{collections::BTreeMap, sync::Arc};

use futures_util::{StreamExt, stream};
use serde::Deserialize;

use crate::comfy::ComfyApi;

use super::{RoutingError, RoutingPolicy, WorkerId, WorkerRequest, WorkerSnapshot};

#[derive(Clone)]
pub struct WorkerRegistry {
    inner: Arc<BTreeMap<WorkerId, (WorkerSnapshot, ComfyApi)>>,
    probe: bool,
}

impl WorkerRegistry {
    pub fn new(entries: Vec<(WorkerSnapshot, ComfyApi)>) -> Result<Self, String> {
        if entries.is_empty() {
            return Err("at least one worker is required".into());
        }
        let mut inner = BTreeMap::new();
        for (snapshot, client) in entries {
            let id = snapshot.id.clone();
            if snapshot.label.trim().is_empty() || snapshot.capabilities.is_empty() {
                return Err("worker label and capabilities are required".into());
            }
            if inner.insert(id, (snapshot, client)).is_some() {
                return Err("worker ids must be unique".into());
            }
        }
        Ok(Self {
            inner: Arc::new(inner),
            probe: true,
        })
    }

    pub fn local(client: ComfyApi) -> Self {
        let mut registry = Self::new(vec![(
            WorkerSnapshot {
                id: WorkerId::new("rtx4090").expect("static worker id"),
                label: "RTX 4090".into(),
                capabilities: vec![
                    super::WorkerCapability::Image,
                    super::WorkerCapability::Video,
                    super::WorkerCapability::Upscale,
                    super::WorkerCapability::Llm,
                ],
                online: true,
                stale: false,
                free_vram_mb: u64::MAX,
                queue_depth: 0,
            },
            client,
        )])
        .expect("static local registry");
        registry.probe = false;
        registry
    }

    pub fn from_env_or_local(local: ComfyApi) -> Result<Self, String> {
        let Some(raw) = std::env::var("FRAMEWEAVER_WORKERS_JSON")
            .ok()
            .filter(|value| !value.trim().is_empty())
        else {
            return Ok(Self::local(local));
        };
        let definitions: Vec<WorkerDefinition> =
            serde_json::from_str(&raw).map_err(|_| "FRAMEWEAVER_WORKERS_JSON is invalid")?;
        let mut entries = Vec::with_capacity(definitions.len());
        for definition in definitions {
            let url = reqwest::Url::parse(&definition.url).map_err(|_| "worker URL is invalid")?;
            validate_worker_url(&definition.id, &url)?;
            let client = ComfyApi::new(url).map_err(|_| "worker client is invalid")?;
            entries.push((
                WorkerSnapshot {
                    id: WorkerId::new(definition.id)?,
                    label: definition.label,
                    capabilities: definition.capabilities,
                    online: false,
                    stale: true,
                    free_vram_mb: 0,
                    queue_depth: 0,
                },
                client,
            ));
        }
        Self::new(entries)
    }

    pub async fn snapshots(&self) -> Vec<WorkerSnapshot> {
        if !self.probe {
            return self
                .inner
                .values()
                .map(|(snapshot, _)| snapshot.clone())
                .collect();
        }
        stream::iter(self.inner.values().cloned())
            .map(|(mut snapshot, client)| async move {
                match client.worker_metrics().await {
                    Ok((free_vram_mb, queue_depth)) => {
                        snapshot.online = true;
                        snapshot.stale = false;
                        snapshot.free_vram_mb = free_vram_mb;
                        snapshot.queue_depth = queue_depth;
                    }
                    Err(_) => {
                        snapshot.online = false;
                        snapshot.stale = true;
                        snapshot.free_vram_mb = 0;
                    }
                }
                snapshot
            })
            .buffer_unordered(8)
            .collect()
            .await
    }

    pub async fn select(&self, request: &WorkerRequest) -> Result<WorkerId, RoutingError> {
        RoutingPolicy::select(request, &self.snapshots().await)
    }

    pub fn client(&self, id: &WorkerId) -> Option<ComfyApi> {
        self.inner.get(id).map(|(_, client)| client.clone())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerDefinition {
    id: String,
    label: String,
    url: String,
    capabilities: Vec<super::WorkerCapability>,
}

fn validate_worker_url(id: &str, url: &reqwest::Url) -> Result<(), String> {
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("worker URL cannot contain credentials, query, or fragment".into());
    }
    let host = url.host_str().ok_or("worker URL requires a host")?;
    let local = host == "127.0.0.1" || host == "localhost";
    if id == "rtx4090" {
        if url.scheme() != "http" || !local {
            return Err("rtx4090 worker must use loopback HTTP".into());
        }
    } else if url.scheme() != "https" || local || !host.ends_with(".tail37947a.ts.net") {
        return Err("remote workers must use Tailnet HTTPS".into());
    }
    Ok(())
}
