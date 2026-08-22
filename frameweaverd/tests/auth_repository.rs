use std::{collections::BTreeSet, path::PathBuf};

use chrono::{Duration, Utc};
use frameweaverd::auth::{AuthConfig, AuthRepository};
use sqlx::{Row, sqlite::SqliteConnectOptions};
use uuid::Uuid;

fn database_path() -> PathBuf {
    std::env::temp_dir().join(format!("frameweaver-auth-{}.db", Uuid::new_v4()))
}

fn enabled_config(allowed: &str) -> Result<AuthConfig, Box<dyn std::error::Error>> {
    Ok(AuthConfig::from_values(
        true,
        Some("123456789012345678"),
        Some("client-secret-not-written-to-storage"),
        Some("https://rtx4090.tail37947a.ts.net:10000/auth/callback"),
        Some(allowed),
        Some("0123456789abcdef0123456789abcdef"),
    )?)
}

#[test]
fn auth_config_is_optional_when_disabled_and_fail_closed_when_enabled() {
    assert!(matches!(
        AuthConfig::from_values(false, None, None, None, None, None).unwrap(),
        AuthConfig::Disabled
    ));

    for invalid in [
        AuthConfig::from_values(
            true,
            None,
            Some("secret"),
            Some("https://example.test/cb"),
            Some("123456789012345678"),
            Some("0123456789abcdef0123456789abcdef"),
        ),
        AuthConfig::from_values(
            true,
            Some("123456789012345678"),
            None,
            Some("https://example.test/cb"),
            Some("123456789012345678"),
            Some("0123456789abcdef0123456789abcdef"),
        ),
        AuthConfig::from_values(
            true,
            Some("123456789012345678"),
            Some("secret"),
            Some("http://example.test/cb"),
            Some("123456789012345678"),
            Some("0123456789abcdef0123456789abcdef"),
        ),
        AuthConfig::from_values(
            true,
            Some("123456789012345678"),
            Some("secret"),
            Some("https://example.test/cb"),
            Some(""),
            Some("0123456789abcdef0123456789abcdef"),
        ),
        AuthConfig::from_values(
            true,
            Some("123456789012345678"),
            Some("secret"),
            Some("https://example.test/cb"),
            Some("creator"),
            Some("0123456789abcdef0123456789abcdef"),
        ),
        AuthConfig::from_values(
            true,
            Some("123456789012345678"),
            Some("secret"),
            Some("https://example.test/cb"),
            Some("123456789012345678,123456789012345678"),
            Some("0123456789abcdef0123456789abcdef"),
        ),
        AuthConfig::from_values(
            true,
            Some("123456789012345678"),
            Some("secret"),
            Some("https://example.test/cb"),
            Some("123456789012345678"),
            Some("too-short"),
        ),
    ] {
        assert!(invalid.is_err());
    }

    let enabled = enabled_config("123456789012345678,987654321098765432").unwrap();
    let AuthConfig::Enabled(config) = enabled else {
        panic!("expected enabled config")
    };
    assert_eq!(config.allowed_user_ids().len(), 2);
    assert_eq!(
        config.redirect_uri().as_str(),
        "https://rtx4090.tail37947a.ts.net:10000/auth/callback"
    );
}

#[tokio::test]
async fn oauth_state_is_hashed_bound_expiring_and_single_use() {
    let path = database_path();
    let repository = AuthRepository::open(&path, b"0123456789abcdef0123456789abcdef")
        .await
        .unwrap();
    let expires = Utc::now() + Duration::minutes(5);
    repository
        .create_state("raw-state-secret", "raw-binding-secret", expires)
        .await
        .unwrap();

    assert!(
        !repository
            .consume_state("raw-state-secret", "wrong-binding", Utc::now())
            .await
            .unwrap()
    );
    assert!(
        repository
            .consume_state("raw-state-secret", "raw-binding-secret", Utc::now())
            .await
            .unwrap()
    );
    assert!(
        !repository
            .consume_state("raw-state-secret", "raw-binding-secret", Utc::now())
            .await
            .unwrap()
    );

    repository
        .create_state(
            "expired-state",
            "binding",
            Utc::now() - Duration::seconds(1),
        )
        .await
        .unwrap();
    assert!(
        !repository
            .consume_state("expired-state", "binding", Utc::now())
            .await
            .unwrap()
    );

    let options = SqliteConnectOptions::new().filename(&path);
    let pool = sqlx::SqlitePool::connect_with(options).await.unwrap();
    let rows = sqlx::query("SELECT state_hash, binding_hash FROM oauth_states")
        .fetch_all(&pool)
        .await
        .unwrap();
    let stored = rows
        .iter()
        .flat_map(|row| [row.get::<String, _>(0), row.get::<String, _>(1)])
        .collect::<Vec<_>>()
        .join(" ");
    assert!(!stored.contains("raw-state-secret"));
    assert!(!stored.contains("raw-binding-secret"));
}

#[tokio::test]
async fn sessions_are_hashed_expire_revoke_and_recheck_current_allowlist() {
    let path = database_path();
    let repository = AuthRepository::open(&path, b"0123456789abcdef0123456789abcdef")
        .await
        .unwrap();
    let owner = repository.owner_for_discord_id("123456789012345678");
    repository
        .create_session(
            "raw-session-token",
            owner,
            "123456789012345678",
            "Test User",
            Utc::now() + Duration::hours(1),
        )
        .await
        .unwrap();

    let allowed = BTreeSet::from(["123456789012345678".to_owned()]);
    let identity = repository
        .resolve_session("raw-session-token", &allowed, Utc::now())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(identity.owner_id, owner);
    assert!(
        repository
            .resolve_session("raw-session-token", &BTreeSet::new(), Utc::now())
            .await
            .unwrap()
            .is_none()
    );

    repository
        .revoke_session("raw-session-token", Utc::now())
        .await
        .unwrap();
    assert!(
        repository
            .resolve_session("raw-session-token", &allowed, Utc::now())
            .await
            .unwrap()
            .is_none()
    );

    repository
        .create_session(
            "expired-session",
            owner,
            "123456789012345678",
            "Test User",
            Utc::now() - Duration::seconds(1),
        )
        .await
        .unwrap();
    assert!(
        repository
            .resolve_session("expired-session", &allowed, Utc::now())
            .await
            .unwrap()
            .is_none()
    );

    let options = SqliteConnectOptions::new().filename(&path);
    let pool = sqlx::SqlitePool::connect_with(options).await.unwrap();
    let rows = sqlx::query("SELECT session_hash, discord_user_hash FROM sessions")
        .fetch_all(&pool)
        .await
        .unwrap();
    let stored = rows
        .iter()
        .flat_map(|row| [row.get::<String, _>(0), row.get::<String, _>(1)])
        .collect::<Vec<_>>()
        .join(" ");
    assert!(!stored.contains("raw-session-token"));
    assert!(!stored.contains("123456789012345678"));
}
