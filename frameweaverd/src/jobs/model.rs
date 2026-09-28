use std::{fmt, str::FromStr};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    CancelRequested,
    Cancelled,
    Orphaned,
}

impl JobStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::CancelRequested => "cancel_requested",
            Self::Cancelled => "cancelled",
            Self::Orphaned => "orphaned",
        }
    }

    pub(crate) fn permits(&self, next: Self) -> bool {
        matches!(
            (self, next),
            (
                Self::Queued,
                Self::Running
                    | Self::Failed
                    | Self::CancelRequested
                    | Self::Cancelled
                    | Self::Orphaned
            ) | (
                Self::Running,
                Self::Succeeded | Self::Failed | Self::CancelRequested | Self::Orphaned
            ) | (
                Self::CancelRequested,
                Self::Queued
                    | Self::Running
                    | Self::Succeeded
                    | Self::Failed
                    | Self::Cancelled
                    | Self::Orphaned
            )
        )
    }

    pub(crate) fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::Orphaned
        )
    }
}

impl FromStr for JobStatus {
    type Err = JobStatusParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            "cancel_requested" => Ok(Self::CancelRequested),
            "cancelled" => Ok(Self::Cancelled),
            "orphaned" => Ok(Self::Orphaned),
            _ => Err(JobStatusParseError(value.to_owned())),
        }
    }
}

#[derive(Debug)]
pub struct JobStatusParseError(String);

impl fmt::Display for JobStatusParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "unknown job status: {}", self.0)
    }
}

impl std::error::Error for JobStatusParseError {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Job {
    pub id: String,
    pub owner_id: String,
    pub worker_id: Option<String>,
    pub kind: String,
    pub mode: String,
    pub status: JobStatus,
    pub prompt: String,
    pub settings_json: String,
    pub output_json: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct NewJob {
    pub owner_id: String,
    pub kind: String,
    pub mode: String,
    pub prompt: String,
    pub settings_json: String,
}
