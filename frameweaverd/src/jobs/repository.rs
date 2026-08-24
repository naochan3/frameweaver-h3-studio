use std::{error::Error, path::Path, str::FromStr, time::Duration};

use chrono::{SecondsFormat, Utc};
use serde_json::Value;
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use uuid::Uuid;

use super::{Job, JobStatus, NewJob};

type RepositoryResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Clone)]
pub struct JobRepository {
    pool: SqlitePool,
}

impl JobRepository {
    pub async fn open(database_path: impl AsRef<Path>) -> RepositoryResult<Self> {
        let options = SqliteConnectOptions::new()
            .filename(database_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_millis(5_000))
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Self { pool })
    }

    pub async fn create(&self, new_job: NewJob) -> RepositoryResult<Job> {
        self.create_routed(new_job, None).await
    }

    pub async fn create_routed(
        &self,
        new_job: NewJob,
        worker_id: Option<&str>,
    ) -> RepositoryResult<Job> {
        let id = Uuid::new_v4().to_string();
        let timestamp = utc_timestamp();
        sqlx::query(
            "INSERT INTO jobs (id, owner_id, worker_id, kind, mode, status, prompt, settings_json, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&new_job.owner_id)
        .bind(worker_id)
        .bind(&new_job.kind)
        .bind(&new_job.mode)
        .bind(JobStatus::Queued.as_str())
        .bind(&new_job.prompt)
        .bind(&new_job.settings_json)
        .bind(&timestamp)
        .bind(&timestamp)
        .execute(&self.pool)
        .await?;

        self.get_by_id(&id).await
    }

    /// Stores a client-generated request key before upstream submission. Replays return
    /// the original durable job so a dropped response cannot submit twice.
    pub async fn create_or_get_routed(
        &self,
        new_job: NewJob,
        worker_id: Option<&str>,
        request_key: &str,
    ) -> RepositoryResult<(Job, bool)> {
        let id = Uuid::new_v4().to_string();
        let timestamp = utc_timestamp();
        let result = sqlx::query(
            "INSERT OR IGNORE INTO jobs (id, owner_id, worker_id, kind, mode, status, prompt, settings_json, request_key, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&new_job.owner_id)
        .bind(worker_id)
        .bind(&new_job.kind)
        .bind(&new_job.mode)
        .bind(JobStatus::Queued.as_str())
        .bind(&new_job.prompt)
        .bind(&new_job.settings_json)
        .bind(request_key)
        .bind(&timestamp)
        .bind(&timestamp)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok((self.get_by_id(&id).await?, true));
        }
        let row = sqlx::query(
            "SELECT id, owner_id, worker_id, kind, mode, status, prompt, settings_json, output_json, error, \
             created_at, updated_at, started_at, finished_at FROM jobs WHERE owner_id = ? AND request_key = ?",
        )
        .bind(&new_job.owner_id)
        .bind(request_key)
        .fetch_one(&self.pool)
        .await?;
        Ok((job_from_row(row)?, false))
    }

    pub async fn get_for_owner(&self, id: &str, owner_id: &str) -> RepositoryResult<Option<Job>> {
        let row = sqlx::query(
            "SELECT id, owner_id, worker_id, kind, mode, status, prompt, settings_json, output_json, error, \
             created_at, updated_at, started_at, finished_at FROM jobs WHERE id = ? AND owner_id = ?",
        )
        .bind(id)
        .bind(owner_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(job_from_row).transpose()
    }

    pub async fn worker_for_owned_output(
        &self,
        id: &str,
        owner_id: &str,
        filename: &str,
        subfolder: &str,
        kind: &str,
    ) -> RepositoryResult<Option<String>> {
        let Some(job) = self.get_for_owner(id, owner_id).await? else {
            return Ok(None);
        };
        let Some(output_json) = job.output_json else {
            return Ok(None);
        };
        let matches_output = serde_json::from_str::<Vec<Value>>(&output_json)
            .unwrap_or_default()
            .iter()
            .any(|output| {
                output.get("filename").and_then(Value::as_str) == Some(filename)
                    && output
                        .get("subfolder")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        == subfolder
                    && output
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("output")
                        == kind
            });
        Ok(matches_output.then_some(job.worker_id).flatten())
    }

    pub async fn list_for_owner(&self, owner_id: &str, limit: u32) -> RepositoryResult<Vec<Job>> {
        let rows = sqlx::query(
            "SELECT id, owner_id, worker_id, kind, mode, status, prompt, settings_json, output_json, error, \
             created_at, updated_at, started_at, finished_at FROM jobs WHERE owner_id = ? \
             ORDER BY created_at DESC, id DESC LIMIT ?",
        )
        .bind(owner_id)
        .bind(i64::from(limit))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(job_from_row).collect()
    }

    pub async fn transition(
        &self,
        id: &str,
        from: JobStatus,
        to: JobStatus,
    ) -> RepositoryResult<Job> {
        if !from.permits(to.clone()) {
            return Err(format!(
                "illegal job transition: {} -> {}",
                from.as_str(),
                to.as_str()
            )
            .into());
        }

        let timestamp = utc_timestamp();
        let starts_job = to == JobStatus::Running;
        let finishes_job = to.is_terminal();
        let updated = sqlx::query(
            "UPDATE jobs SET status = ?, updated_at = ?, \
             started_at = CASE WHEN ? AND started_at IS NULL THEN ? ELSE started_at END, \
             finished_at = CASE WHEN ? AND finished_at IS NULL THEN ? ELSE finished_at END \
             WHERE id = ? AND status = ?",
        )
        .bind(to.as_str())
        .bind(&timestamp)
        .bind(starts_job)
        .bind(&timestamp)
        .bind(finishes_job)
        .bind(&timestamp)
        .bind(id)
        .bind(from.as_str())
        .execute(&self.pool)
        .await?;
        if updated.rows_affected() != 1 {
            return Err("job was not found in the expected status".into());
        }

        self.get_by_id(id).await
    }

    pub async fn recover_incomplete(&self) -> RepositoryResult<Vec<Job>> {
        let rows = sqlx::query(
            "SELECT id, owner_id, worker_id, kind, mode, status, prompt, settings_json, output_json, error, \
             created_at, updated_at, started_at, finished_at FROM jobs \
             WHERE status IN ('queued', 'running', 'cancel_requested') ORDER BY created_at ASC, id ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(job_from_row).collect()
    }

    pub async fn reconcile_observed_status(
        &self,
        id: &str,
        observed: JobStatus,
        to: JobStatus,
        output_json: Option<&str>,
        error: Option<&str>,
    ) -> RepositoryResult<Job> {
        let timestamp = utc_timestamp();
        let starts_job = to == JobStatus::Running;
        let finishes_job = to.is_terminal();
        let updated = sqlx::query(
            "UPDATE jobs SET status = ?, output_json = ?, error = ?, updated_at = ?, \
             started_at = CASE WHEN ? AND started_at IS NULL THEN ? ELSE started_at END, \
             finished_at = CASE WHEN ? AND finished_at IS NULL THEN ? ELSE finished_at END \
             WHERE id = ? AND status = ?",
        )
        .bind(to.as_str())
        .bind(output_json)
        .bind(error)
        .bind(&timestamp)
        .bind(starts_job)
        .bind(&timestamp)
        .bind(finishes_job)
        .bind(&timestamp)
        .bind(id)
        .bind(observed.as_str())
        .execute(&self.pool)
        .await?;
        if updated.rows_affected() != 1 {
            // A concurrent cancel/reconcile already wrote a newer state. Return that
            // durable state instead of converting a benign compare-and-swap miss into 500.
            return self.get_by_id(id).await;
        }

        self.get_by_id(id).await
    }

    async fn get_by_id(&self, id: &str) -> RepositoryResult<Job> {
        let row = sqlx::query(
            "SELECT id, owner_id, worker_id, kind, mode, status, prompt, settings_json, output_json, error, \
             created_at, updated_at, started_at, finished_at FROM jobs WHERE id = ?",
        )
        .bind(id)
        .fetch_one(&self.pool)
        .await?;
        job_from_row(row)
    }
}

fn utc_timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn job_from_row(row: sqlx::sqlite::SqliteRow) -> RepositoryResult<Job> {
    Ok(Job {
        id: row.try_get("id")?,
        owner_id: row.try_get("owner_id")?,
        worker_id: row.try_get("worker_id")?,
        kind: row.try_get("kind")?,
        mode: row.try_get("mode")?,
        status: JobStatus::from_str(row.try_get::<String, _>("status")?.as_str())?,
        prompt: row.try_get("prompt")?,
        settings_json: row.try_get("settings_json")?,
        output_json: row.try_get("output_json")?,
        error: row.try_get("error")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        started_at: row.try_get("started_at")?,
        finished_at: row.try_get("finished_at")?,
    })
}
