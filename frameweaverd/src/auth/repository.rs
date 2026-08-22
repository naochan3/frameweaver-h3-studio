use std::{collections::BTreeSet, error::Error, path::Path, time::Duration};

use chrono::{DateTime, SecondsFormat, Utc};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use subtle::ConstantTimeEq;
use uuid::Uuid;

type RepositoryResult<T> = Result<T, Box<dyn Error + Send + Sync>>;
type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionIdentity {
    pub owner_id: Uuid,
    pub discord_user_hash: String,
    pub display_name: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Clone)]
pub struct AuthRepository {
    pool: SqlitePool,
    key: Vec<u8>,
}

impl AuthRepository {
    pub async fn open(path: impl AsRef<Path>, key: &[u8]) -> RepositoryResult<Self> {
        if key.len() < 32 {
            return Err("auth repository key must be at least 32 bytes".into());
        }
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5))
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Self {
            pool,
            key: key.to_vec(),
        })
    }

    pub async fn create_state(
        &self,
        state: &str,
        binding: &str,
        expires_at: DateTime<Utc>,
    ) -> RepositoryResult<()> {
        sqlx::query(
            "INSERT INTO oauth_states (state_hash, binding_hash, expires_at) VALUES (?, ?, ?)",
        )
        .bind(self.digest("state", state))
        .bind(self.digest("binding", binding))
        .bind(timestamp(expires_at))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn consume_state(
        &self,
        state: &str,
        binding: &str,
        now: DateTime<Utc>,
    ) -> RepositoryResult<bool> {
        let state_hash = self.digest("state", state);
        let expected_binding = self.digest("binding", binding);
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT binding_hash, expires_at, consumed_at FROM oauth_states WHERE state_hash = ?",
        )
        .bind(&state_hash)
        .fetch_optional(&mut *transaction)
        .await?;
        let valid = match row {
            Some(row) => {
                let stored: String = row.try_get("binding_hash")?;
                let expires: String = row.try_get("expires_at")?;
                let consumed: Option<String> = row.try_get("consumed_at")?;
                consumed.is_none()
                    && DateTime::parse_from_rfc3339(&expires)?.with_timezone(&Utc) > now
                    && bool::from(stored.as_bytes().ct_eq(expected_binding.as_bytes()))
            }
            None => false,
        };
        if valid {
            let updated = sqlx::query("UPDATE oauth_states SET consumed_at = ? WHERE state_hash = ? AND consumed_at IS NULL")
                .bind(timestamp(now)).bind(&state_hash).execute(&mut *transaction).await?;
            if updated.rows_affected() != 1 {
                transaction.rollback().await?;
                return Ok(false);
            }
        }
        transaction.commit().await?;
        Ok(valid)
    }

    pub fn owner_for_discord_id(&self, discord_user_id: &str) -> Uuid {
        let digest = self.digest_bytes("owner", discord_user_id);
        let mut bytes = [0_u8; 16];
        bytes.copy_from_slice(&digest[..16]);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        Uuid::from_bytes(bytes)
    }

    pub async fn create_session(
        &self,
        token: &str,
        owner_id: Uuid,
        discord_user_id: &str,
        display_name: &str,
        expires_at: DateTime<Utc>,
    ) -> RepositoryResult<()> {
        let now = Utc::now();
        sqlx::query("INSERT INTO sessions (session_hash, owner_id, discord_user_hash, display_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(self.digest("session", token))
            .bind(owner_id.to_string())
            .bind(self.digest("discord-user", discord_user_id))
            .bind(display_name)
            .bind(timestamp(now))
            .bind(timestamp(expires_at))
            .execute(&self.pool).await?;
        Ok(())
    }

    pub async fn resolve_session(
        &self,
        token: &str,
        allowed_user_ids: &BTreeSet<String>,
        now: DateTime<Utc>,
    ) -> RepositoryResult<Option<SessionIdentity>> {
        let row = sqlx::query("SELECT owner_id, discord_user_hash, display_name, expires_at, revoked_at FROM sessions WHERE session_hash = ?")
            .bind(self.digest("session", token)).fetch_optional(&self.pool).await?;
        let Some(row) = row else { return Ok(None) };
        let revoked: Option<String> = row.try_get("revoked_at")?;
        let expires_raw: String = row.try_get("expires_at")?;
        let expires_at = DateTime::parse_from_rfc3339(&expires_raw)?.with_timezone(&Utc);
        let discord_user_hash: String = row.try_get("discord_user_hash")?;
        let currently_allowed = allowed_user_ids.iter().any(|id| {
            let candidate = self.digest("discord-user", id);
            bool::from(candidate.as_bytes().ct_eq(discord_user_hash.as_bytes()))
        });
        if revoked.is_some() || expires_at <= now || !currently_allowed {
            return Ok(None);
        }
        Ok(Some(SessionIdentity {
            owner_id: Uuid::parse_str(row.try_get::<String, _>("owner_id")?.as_str())?,
            discord_user_hash,
            display_name: row.try_get("display_name")?,
            expires_at,
        }))
    }

    pub async fn revoke_session(&self, token: &str, now: DateTime<Utc>) -> RepositoryResult<()> {
        sqlx::query(
            "UPDATE sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL",
        )
        .bind(timestamp(now))
        .bind(self.digest("session", token))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    fn digest(&self, domain: &str, value: &str) -> String {
        hex(&self.digest_bytes(domain, value))
    }
    fn digest_bytes(&self, domain: &str, value: &str) -> Vec<u8> {
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC accepts any key length");
        mac.update(b"frameweaver\0");
        mac.update(domain.as_bytes());
        mac.update(b"\0");
        mac.update(value.as_bytes());
        mac.finalize().into_bytes().to_vec()
    }
}

fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn hex(bytes: &[u8]) -> String {
    const TABLE: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(TABLE[(byte >> 4) as usize] as char);
        output.push(TABLE[(byte & 0x0f) as usize] as char);
    }
    output
}
