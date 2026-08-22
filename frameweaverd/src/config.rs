use std::{env, fmt, net::SocketAddr, time::Duration};

use reqwest::Url;

use crate::auth::AuthConfig;

#[derive(Clone, Debug)]
pub struct AppConfig {
    listen_addr: SocketAddr,
    comfy_url: Url,
    health_cache_ttl: Duration,
    auth: AuthConfig,
}

impl AppConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let auth = AuthConfig::from_env().map_err(|error| ConfigError(error.to_string()))?;
        Self::from_values(
            &env::var("FRAMEWEAVER_LISTEN_ADDR").unwrap_or_else(|_| "127.0.0.1:5180".to_owned()),
            &env::var("FRAMEWEAVER_COMFY_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8188".to_owned()),
            &env::var("FRAMEWEAVER_HEALTH_CACHE_TTL_MS").unwrap_or_else(|_| "1000".to_owned()),
            auth,
        )
    }

    fn from_values(
        listen_addr: &str,
        comfy_url: &str,
        health_cache_ttl_ms: &str,
        auth: AuthConfig,
    ) -> Result<Self, ConfigError> {
        let listen_addr = listen_addr
            .parse()
            .map_err(|error| ConfigError::new("FRAMEWEAVER_LISTEN_ADDR", error))?;
        let comfy_url = comfy_url
            .parse()
            .map_err(|error| ConfigError::new("FRAMEWEAVER_COMFY_URL", error))?;
        let health_cache_ttl = health_cache_ttl_ms
            .parse::<u64>()
            .map(Duration::from_millis)
            .map_err(|error| ConfigError::new("FRAMEWEAVER_HEALTH_CACHE_TTL_MS", error))?;
        Self::with_auth(listen_addr, comfy_url, health_cache_ttl, auth)
    }

    pub fn new(
        listen_addr: SocketAddr,
        comfy_url: Url,
        health_cache_ttl: Duration,
    ) -> Result<Self, ConfigError> {
        Self::with_auth(
            listen_addr,
            comfy_url,
            health_cache_ttl,
            AuthConfig::Disabled,
        )
    }

    pub fn with_auth(
        listen_addr: SocketAddr,
        comfy_url: Url,
        health_cache_ttl: Duration,
        auth: AuthConfig,
    ) -> Result<Self, ConfigError> {
        if !matches!(comfy_url.scheme(), "http" | "https") {
            return Err(ConfigError::new(
                "FRAMEWEAVER_COMFY_URL",
                "must use the http or https scheme",
            ));
        }
        comfy_url
            .join("system_stats")
            .map_err(|error| ConfigError::new("FRAMEWEAVER_COMFY_URL", error))?;

        Ok(Self {
            listen_addr,
            comfy_url,
            health_cache_ttl,
            auth,
        })
    }

    pub fn listen_addr(&self) -> SocketAddr {
        self.listen_addr
    }

    pub fn comfy_url(&self) -> &Url {
        &self.comfy_url
    }

    pub fn health_cache_ttl(&self) -> Duration {
        self.health_cache_ttl
    }

    pub fn auth(&self) -> &AuthConfig {
        &self.auth
    }
}

#[derive(Debug)]
pub struct ConfigError(String);

impl ConfigError {
    fn new(variable: &str, error: impl fmt::Display) -> Self {
        Self(format!("invalid {variable}: {error}"))
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl std::error::Error for ConfigError {}
