use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub struct WorkerId(String);

impl WorkerId {
    pub fn new(value: impl Into<String>) -> Result<Self, &'static str> {
        let value = value.into();
        if value.is_empty()
            || value.len() > 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err("worker id must be 1-64 lowercase ASCII letters, digits, or hyphens");
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerCapability {
    Image,
    Video,
    Upscale,
    Llm,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "mode", content = "worker_id")]
pub enum WorkerPreference {
    Auto,
    Explicit(WorkerId),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerRequest {
    pub capability: WorkerCapability,
    pub required_vram_mb: u64,
    pub preference: WorkerPreference,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkerSnapshot {
    pub id: WorkerId,
    pub label: String,
    pub capabilities: Vec<WorkerCapability>,
    pub online: bool,
    pub stale: bool,
    pub free_vram_mb: u64,
    pub queue_depth: u32,
}
