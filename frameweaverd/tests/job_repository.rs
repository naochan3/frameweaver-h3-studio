use std::path::PathBuf;

use frameweaverd::jobs::{JobRepository, JobStatus, NewJob};
use sqlx::{Connection, Row, SqliteConnection};
use uuid::Uuid;

fn database_path() -> PathBuf {
    std::env::temp_dir().join(format!("frameweaverd-job-repository-{}.db", Uuid::new_v4()))
}

fn new_job(owner_id: &str, prompt: &str) -> NewJob {
    NewJob {
        owner_id: owner_id.to_owned(),
        kind: "image".to_owned(),
        mode: "txt2img".to_owned(),
        prompt: prompt.to_owned(),
        settings_json: r#"{\"steps\":20}"#.to_owned(),
    }
}

#[tokio::test]
async fn job_repository_configures_wal_and_persists_jobs_after_reopen() {
    let path = database_path();
    let repository = JobRepository::open(&path).await.unwrap();
    let job = repository
        .create(new_job("owner-a", "a lighthouse"))
        .await
        .unwrap();
    assert_eq!(job.status, JobStatus::Queued);
    assert!(job.created_at.ends_with('Z'));
    assert_eq!(job.created_at, job.updated_at);
    drop(repository);

    let mut connection = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
        .await
        .unwrap();
    let journal_mode: String = sqlx::query("PRAGMA journal_mode")
        .fetch_one(&mut connection)
        .await
        .unwrap()
        .get(0);
    assert_eq!(journal_mode, "wal");
    connection.close().await.unwrap();

    let reopened = JobRepository::open(&path).await.unwrap();
    let restored = reopened
        .get_for_owner(&job.id, "owner-a")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restored.prompt, "a lighthouse");
}

#[tokio::test]
async fn job_repository_owner_filtered_reads_do_not_disclose_other_owners_jobs() {
    let repository = JobRepository::open(database_path()).await.unwrap();
    let owner_a_job = repository
        .create(new_job("owner-a", "first"))
        .await
        .unwrap();
    repository
        .create(new_job("owner-b", "second"))
        .await
        .unwrap();

    assert!(
        repository
            .get_for_owner(&owner_a_job.id, "owner-b")
            .await
            .unwrap()
            .is_none()
    );
    let jobs = repository.list_for_owner("owner-a", 50).await.unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].id, owner_a_job.id);
}

#[tokio::test]
async fn job_repository_transition_accepts_only_legal_state_changes() {
    let repository = JobRepository::open(database_path()).await.unwrap();
    let job = repository
        .create(new_job("owner-a", "stateful"))
        .await
        .unwrap();

    assert!(
        repository
            .transition(&job.id, JobStatus::Queued, JobStatus::Succeeded)
            .await
            .is_err()
    );
    assert_eq!(
        repository
            .transition(&job.id, JobStatus::Queued, JobStatus::Running)
            .await
            .unwrap()
            .status,
        JobStatus::Running
    );
    assert_eq!(
        repository
            .transition(&job.id, JobStatus::Running, JobStatus::Succeeded)
            .await
            .unwrap()
            .status,
        JobStatus::Succeeded
    );
    assert!(
        repository
            .transition(&job.id, JobStatus::Succeeded, JobStatus::Running)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn job_repository_recover_incomplete_returns_only_jobs_requiring_startup_reconciliation() {
    let repository = JobRepository::open(database_path()).await.unwrap();
    let queued = repository
        .create(new_job("owner-a", "queued"))
        .await
        .unwrap();
    let running = repository
        .create(new_job("owner-a", "running"))
        .await
        .unwrap();
    let cancel_requested = repository
        .create(new_job("owner-a", "cancel"))
        .await
        .unwrap();
    let completed = repository.create(new_job("owner-a", "done")).await.unwrap();
    repository
        .transition(&running.id, JobStatus::Queued, JobStatus::Running)
        .await
        .unwrap();
    repository
        .transition(
            &cancel_requested.id,
            JobStatus::Queued,
            JobStatus::CancelRequested,
        )
        .await
        .unwrap();
    repository
        .transition(&completed.id, JobStatus::Queued, JobStatus::Running)
        .await
        .unwrap();
    repository
        .transition(&completed.id, JobStatus::Running, JobStatus::Succeeded)
        .await
        .unwrap();

    let candidates = repository.recover_incomplete().await.unwrap();
    let mut candidate_ids: Vec<_> = candidates.iter().map(|job| job.id.as_str()).collect();
    let mut expected_ids = vec![
        cancel_requested.id.as_str(),
        running.id.as_str(),
        queued.id.as_str(),
    ];
    candidate_ids.sort_unstable();
    expected_ids.sort_unstable();
    assert_eq!(candidate_ids, expected_ids);
    assert!(!candidate_ids.contains(&completed.id.as_str()));
}
