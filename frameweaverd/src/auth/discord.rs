use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::time::Duration;

use super::DiscordAuthConfig;

const MAX_DISCORD_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize)]
pub struct DiscordToken {
    pub access_token: String,
    pub token_type: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct DiscordUser {
    pub id: String,
    pub username: String,
    pub global_name: Option<String>,
}

#[async_trait]
pub trait DiscordClient: Send + Sync {
    async fn exchange_code(&self, code: &str) -> Result<DiscordToken, String>;
    async fn current_user(&self, token: &DiscordToken) -> Result<DiscordUser, String>;
}

#[derive(Clone)]
pub struct DiscordHttpClient {
    client: Client,
    client_id: String,
    client_secret: String,
    redirect_uri: Url,
}

impl DiscordHttpClient {
    pub fn new(config: &DiscordAuthConfig) -> Result<Self, String> {
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .map_err(|_| "Discord client initialization failed".to_owned())?,
            client_id: config.client_id().to_owned(),
            client_secret: config.client_secret().to_owned(),
            redirect_uri: config.redirect_uri().clone(),
        })
    }

    pub fn disabled() -> Result<Self, String> {
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .map_err(|_| "Discord client initialization failed".to_owned())?,
            client_id: String::new(),
            client_secret: String::new(),
            redirect_uri: Url::parse("https://localhost/auth/callback")
                .expect("static disabled redirect URL is valid"),
        })
    }
}

#[derive(Serialize)]
struct TokenRequest<'a> {
    grant_type: &'static str,
    code: &'a str,
    redirect_uri: &'a str,
}

#[async_trait]
impl DiscordClient for DiscordHttpClient {
    async fn exchange_code(&self, code: &str) -> Result<DiscordToken, String> {
        let response = self
            .client
            .post("https://discord.com/api/v10/oauth2/token")
            .basic_auth(&self.client_id, Some(&self.client_secret))
            .header("content-type", "application/x-www-form-urlencoded")
            .body(
                serde_urlencoded::to_string(TokenRequest {
                    grant_type: "authorization_code",
                    code,
                    redirect_uri: self.redirect_uri.as_str(),
                })
                .map_err(|_| "Discord token request encoding failed".to_owned())?,
            )
            .send()
            .await
            .map_err(|_| "Discord token exchange unavailable".to_owned())?;
        if !response.status().is_success() {
            return Err("Discord token exchange rejected".into());
        }
        read_json_limited(response, "Discord token response invalid").await
    }

    async fn current_user(&self, token: &DiscordToken) -> Result<DiscordUser, String> {
        if !token.token_type.eq_ignore_ascii_case("bearer") {
            return Err("Discord token type invalid".into());
        }
        let response = self
            .client
            .get("https://discord.com/api/v10/users/@me")
            .bearer_auth(&token.access_token)
            .send()
            .await
            .map_err(|_| "Discord user lookup unavailable".to_owned())?;
        if !response.status().is_success() {
            return Err("Discord user lookup rejected".into());
        }
        read_json_limited(response, "Discord user response invalid").await
    }
}

async fn read_json_limited<T: DeserializeOwned>(
    response: reqwest::Response,
    invalid_message: &'static str,
) -> Result<T, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_DISCORD_RESPONSE_BYTES as u64)
    {
        return Err(invalid_message.to_owned());
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| invalid_message.to_owned())?;
        if body.len().saturating_add(chunk.len()) > MAX_DISCORD_RESPONSE_BYTES {
            return Err(invalid_message.to_owned());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| invalid_message.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, response::Response, routing::get};

    async fn response_for(body: Vec<u8>) -> reqwest::Response {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/",
            get(move || async move { Response::new(Body::from(body.clone())) }),
        );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        reqwest::get(format!("http://{address}/")).await.unwrap()
    }

    #[tokio::test]
    async fn accepts_bounded_discord_json() {
        let response =
            response_for(br#"{"id":"123","username":"u","global_name":null}"#.to_vec()).await;
        let user: DiscordUser = read_json_limited(response, "invalid").await.unwrap();
        assert_eq!(user.id, "123");
    }

    #[tokio::test]
    async fn rejects_oversized_discord_response() {
        let response = response_for(vec![b'x'; MAX_DISCORD_RESPONSE_BYTES + 1]).await;
        let result = read_json_limited::<DiscordUser>(response, "invalid").await;
        assert_eq!(result.unwrap_err(), "invalid");
    }
}
