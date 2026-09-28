use std::sync::Arc;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{Duration, Utc};

use super::{AuthConfig, AuthRepository, DiscordClient, SessionIdentity};

#[derive(Clone)]
pub struct AuthService {
    pub(crate) config: AuthConfig,
    pub(crate) repository: AuthRepository,
    pub(crate) discord: Arc<dyn DiscordClient>,
}

impl AuthService {
    pub fn new(
        config: AuthConfig,
        repository: AuthRepository,
        discord: Arc<dyn DiscordClient>,
    ) -> Self {
        Self {
            config,
            repository,
            discord,
        }
    }

    pub fn enabled(&self) -> bool {
        self.config.enabled().is_some()
    }

    pub(crate) fn random_token() -> String {
        URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
    }

    pub(crate) async fn resolve(&self, token: &str) -> Option<SessionIdentity> {
        let config = self.config.enabled()?;
        self.repository
            .resolve_session(token, config.allowed_user_ids(), Utc::now())
            .await
            .ok()
            .flatten()
    }

    pub(crate) fn state_expiry() -> chrono::DateTime<Utc> {
        Utc::now() + Duration::minutes(10)
    }
    pub(crate) fn session_expiry() -> chrono::DateTime<Utc> {
        Utc::now() + Duration::hours(24)
    }
}
