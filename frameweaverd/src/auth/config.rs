use std::collections::BTreeSet;

use reqwest::Url;

#[derive(Clone, Debug)]
pub enum AuthConfig {
    Disabled,
    Enabled(DiscordAuthConfig),
}

#[derive(Clone, Debug)]
pub struct DiscordAuthConfig {
    client_id: String,
    client_secret: String,
    redirect_uri: Url,
    allowed_user_ids: BTreeSet<String>,
    session_secret: Vec<u8>,
}

impl AuthConfig {
    pub fn from_env() -> Result<Self, AuthConfigError> {
        let value = |name: &str| std::env::var(name).ok();
        Self::from_values(
            matches!(value("DISCORD_AUTH_ENABLED").as_deref(), Some("1")),
            value("DISCORD_CLIENT_ID").as_deref(),
            value("DISCORD_CLIENT_SECRET").as_deref(),
            value("DISCORD_REDIRECT_URI").as_deref(),
            value("DISCORD_ALLOWED_USER_IDS").as_deref(),
            value("FRAMEWEAVER_SESSION_SECRET").as_deref(),
        )
    }

    pub fn from_values(
        enabled: bool,
        client_id: Option<&str>,
        client_secret: Option<&str>,
        redirect_uri: Option<&str>,
        allowed_user_ids: Option<&str>,
        session_secret: Option<&str>,
    ) -> Result<Self, AuthConfigError> {
        if !enabled {
            return Ok(Self::Disabled);
        }
        let required = |name: &'static str, value: Option<&str>| {
            value
                .filter(|item| !item.trim().is_empty())
                .map(str::to_owned)
                .ok_or_else(|| AuthConfigError(format!("{name} is required")))
        };
        let client_id = required("DISCORD_CLIENT_ID", client_id)?;
        if !is_snowflake(&client_id) {
            return Err(AuthConfigError("DISCORD_CLIENT_ID is invalid".into()));
        }
        let client_secret = required("DISCORD_CLIENT_SECRET", client_secret)?;
        let redirect_uri = required("DISCORD_REDIRECT_URI", redirect_uri)?
            .parse::<Url>()
            .map_err(|_| AuthConfigError("DISCORD_REDIRECT_URI is invalid".into()))?;
        if redirect_uri.scheme() != "https"
            || redirect_uri.host_str().is_none()
            || redirect_uri.username() != ""
            || redirect_uri.password().is_some()
            || redirect_uri.query().is_some()
            || redirect_uri.fragment().is_some()
        {
            return Err(AuthConfigError(
                "DISCORD_REDIRECT_URI must be an HTTPS URL without credentials, query, or fragment"
                    .into(),
            ));
        }
        let raw_allowed = required("DISCORD_ALLOWED_USER_IDS", allowed_user_ids)?;
        let values = raw_allowed
            .split(',')
            .map(str::trim)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if values.is_empty() || values.iter().any(|value| !is_snowflake(value)) {
            return Err(AuthConfigError(
                "DISCORD_ALLOWED_USER_IDS contains an invalid ID".into(),
            ));
        }
        let allowed_user_ids = values.iter().cloned().collect::<BTreeSet<_>>();
        if allowed_user_ids.len() != values.len() {
            return Err(AuthConfigError(
                "DISCORD_ALLOWED_USER_IDS contains a duplicate ID".into(),
            ));
        }
        let session_secret = required("FRAMEWEAVER_SESSION_SECRET", session_secret)?.into_bytes();
        if session_secret.len() < 32 {
            return Err(AuthConfigError(
                "FRAMEWEAVER_SESSION_SECRET must be at least 32 bytes".into(),
            ));
        }
        Ok(Self::Enabled(DiscordAuthConfig {
            client_id,
            client_secret,
            redirect_uri,
            allowed_user_ids,
            session_secret,
        }))
    }

    pub fn enabled(&self) -> Option<&DiscordAuthConfig> {
        match self {
            Self::Disabled => None,
            Self::Enabled(config) => Some(config),
        }
    }
}

impl DiscordAuthConfig {
    pub fn client_id(&self) -> &str {
        &self.client_id
    }
    pub fn client_secret(&self) -> &str {
        &self.client_secret
    }
    pub fn redirect_uri(&self) -> &Url {
        &self.redirect_uri
    }
    pub fn allowed_user_ids(&self) -> &BTreeSet<String> {
        &self.allowed_user_ids
    }
    pub fn session_secret(&self) -> &[u8] {
        &self.session_secret
    }
}

fn is_snowflake(value: &str) -> bool {
    (17..=20).contains(&value.len())
        && !value.starts_with('0')
        && value.bytes().all(|byte| byte.is_ascii_digit())
}

#[derive(Debug)]
pub struct AuthConfigError(pub(crate) String);

impl std::fmt::Display for AuthConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

impl std::error::Error for AuthConfigError {}
