mod api;
mod config;
mod discord;
mod repository;
mod service;

pub use api::{AuthenticatedIdentity, build_auth_router, protect_router};
pub use config::{AuthConfig, AuthConfigError, DiscordAuthConfig};
pub use discord::{DiscordClient, DiscordHttpClient, DiscordToken, DiscordUser};
pub use repository::{AuthRepository, SessionIdentity};
pub use service::AuthService;
