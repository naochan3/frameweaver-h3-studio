use std::{error::Error, fmt, time::Duration};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

type ComfyResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Debug)]
pub struct ComfySubmitError {
    status: reqwest::StatusCode,
    message: String,
    node_ids: Vec<String>,
}
impl fmt::Display for ComfySubmitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Comfy prompt rejected: {}: {}",
            self.status, self.message
        )?;
        if !self.node_ids.is_empty() {
            write!(f, " (nodes: {})", self.node_ids.join(","))?;
        }
        Ok(())
    }
}
impl Error for ComfySubmitError {}

const SUBMIT_TIMEOUT: Duration = Duration::from_secs(30);
const RECONCILE_TIMEOUT: Duration = Duration::from_secs(2);
const CANCEL_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct ComfyApi {
    client: reqwest::Client,
    base_url: Url,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteJobStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RemoteJob {
    pub status: RemoteJobStatus,
    #[serde(default)]
    pub outputs: serde_json::Map<String, Value>,
    #[serde(default)]
    pub execution_error: Option<Value>,
}

pub fn flatten_media_outputs(outputs: &serde_json::Map<String, Value>) -> Vec<Value> {
    outputs
        .values()
        .filter_map(Value::as_object)
        .flat_map(|node| node.values())
        .filter_map(Value::as_array)
        .flatten()
        .filter(|item| item.get("filename").and_then(Value::as_str).is_some())
        .cloned()
        .collect()
}

impl ComfyApi {
    pub fn new(base_url: Url) -> ComfyResult<Self> {
        if !matches!(base_url.scheme(), "http" | "https") {
            return Err("Comfy URL must use http or https".into());
        }
        Ok(Self {
            client: reqwest::Client::new(),
            base_url,
        })
    }

    pub fn base_url(&self) -> Url {
        self.base_url.clone()
    }

    pub async fn worker_metrics(&self) -> ComfyResult<(u64, u32)> {
        let stats = self
            .client
            .get(self.base_url.join("system_stats")?)
            .timeout(RECONCILE_TIMEOUT)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        let free_vram_bytes = stats
            .pointer("/devices/0/vram_free")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let queue = self
            .client
            .get(self.base_url.join("queue")?)
            .timeout(RECONCILE_TIMEOUT)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        let queue_depth = ["/queue_running", "/queue_pending"]
            .iter()
            .filter_map(|path| queue.pointer(path).and_then(Value::as_array))
            .map(|items| items.len() as u32)
            .sum();
        Ok((free_vram_bytes / (1024 * 1024), queue_depth))
    }

    pub async fn submit(
        &self,
        prompt_id: &str,
        client_id: &str,
        workflow: Value,
    ) -> ComfyResult<()> {
        let response = self
            .client
            .post(self.base_url.join("prompt")?)
            // A workflow submission may legitimately take longer than a status read.
            .timeout(SUBMIT_TIMEOUT)
            .json(&json!({"prompt_id": prompt_id, "client_id": client_id, "prompt": workflow}))
            .send()
            .await?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.json::<Value>().await.unwrap_or(Value::Null);
            let message = body
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("request rejected")
                .to_owned();
            let mut node_ids = body
                .get("node_errors")
                .and_then(Value::as_object)
                .map(|nodes| nodes.keys().cloned().collect())
                .unwrap_or_else(Vec::new);
            node_ids.sort();
            return Err(Box::new(ComfySubmitError {
                status,
                message,
                node_ids,
            }));
        }
        Ok(())
    }

    pub async fn get_job(&self, job_id: &str) -> ComfyResult<Option<RemoteJob>> {
        let response = self
            .client
            .get(self.base_url.join(&format!("api/jobs/{job_id}"))?)
            // List/get reconciliation must not serialize a stalled Comfy daemon.
            .timeout(RECONCILE_TIMEOUT)
            .send()
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let job = response.error_for_status()?.json::<RemoteJob>().await?;
        Ok(Some(job))
    }

    pub async fn cancel(&self, job_id: &str) -> ComfyResult<bool> {
        let response = self
            .client
            .post(self.base_url.join(&format!("api/jobs/{job_id}/cancel"))?)
            // Cancellation is operator-visible, but still bounded to avoid a hung UI action.
            .timeout(CANCEL_TIMEOUT)
            .send()
            .await?
            .error_for_status()?;
        Ok(response
            .json::<Value>()
            .await?
            .get("cancelled")
            .and_then(Value::as_bool)
            .unwrap_or(false))
    }
}
