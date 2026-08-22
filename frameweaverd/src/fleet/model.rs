use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerKind {
    Local,
    Remote,
}

#[derive(Clone, Debug)]
pub struct WorkerSpec {
    pub name: String,
    pub kind: WorkerKind,
}
impl WorkerSpec {
    pub fn local(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            kind: WorkerKind::Local,
        }
    }
    pub fn remote(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            kind: WorkerKind::Remote,
        }
    }
}

#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Telemetry {
    pub host: String,
    pub vram_total: u64,
    pub vram_used: u64,
    pub utilization: u64,
    pub power_draw: f64,
    pub power_limit: f64,
    pub temperature: u64,
    pub pstate: String,
    pub power_plan: String,
    #[serde(skip_serializing)]
    pub comfy_status: String,
    pub at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetSample {
    pub worker: String,
    #[serde(flatten)]
    pub telemetry: Option<Telemetry>,
    pub host_status: String,
    pub comfy_status: String,
    pub age_ms: Option<u64>,
    pub stale: bool,
    pub sample_interval_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peak_vram_used: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_attempt_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
pub struct FleetSnapshot {
    pub samples: Vec<FleetSample>,
    pub at: String,
    pub collecting: bool,
}
