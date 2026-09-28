use std::{path::PathBuf, sync::Arc};

use async_trait::async_trait;
use axum::{Router, routing::get};
use frameweaverd::auth::{
    AuthConfig, AuthRepository, AuthService, DiscordClient, DiscordToken, DiscordUser,
    build_auth_router, protect_router,
};
use tokio::net::TcpListener;
use uuid::Uuid;

#[derive(Clone)]
struct FakeDiscord {
    user_id: String,
    token_error: bool,
}

#[async_trait]
impl DiscordClient for FakeDiscord {
    async fn exchange_code(&self, code: &str) -> Result<DiscordToken, String> {
        if self.token_error || code != "valid-code" {
            Err("token exchange failed".into())
        } else {
            Ok(DiscordToken {
                access_token: "ephemeral-access-token".into(),
                token_type: "Bearer".into(),
            })
        }
    }

    async fn current_user(&self, token: &DiscordToken) -> Result<DiscordUser, String> {
        assert_eq!(token.access_token, "ephemeral-access-token");
        Ok(DiscordUser {
            id: self.user_id.clone(),
            username: "tester".into(),
            global_name: Some("Test User".into()),
        })
    }
}

fn database_path() -> PathBuf {
    std::env::temp_dir().join(format!("frameweaver-auth-api-{}.db", Uuid::new_v4()))
}

fn config(allowed: &str) -> AuthConfig {
    AuthConfig::from_values(
        true,
        Some("123456789012345678"),
        Some("client-secret"),
        Some("https://rtx4090.tail37947a.ts.net:10000/auth/callback"),
        Some(allowed),
        Some("0123456789abcdef0123456789abcdef"),
    )
    .unwrap()
}

async fn server(user_id: &str, allowed: &str) -> String {
    let auth = config(allowed);
    let repository =
        AuthRepository::open(database_path(), auth.enabled().unwrap().session_secret())
            .await
            .unwrap();
    let service = AuthService::new(
        auth,
        repository,
        Arc::new(FakeDiscord {
            user_id: user_id.into(),
            token_error: false,
        }),
    );
    let protected = protect_router(
        Router::new().route("/api/private", get(|| async { "private" })),
        service.clone(),
    );
    let app = build_auth_router(service).merge(protected);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{address}")
}

fn cookie_pair(set_cookie: &str) -> String {
    set_cookie.split(';').next().unwrap().to_owned()
}

#[tokio::test]
async fn login_uses_identify_state_and_hardened_binding_cookie() {
    let base = server("987654321098765432", "987654321098765432").await;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let response = client
        .get(format!("{base}/auth/login"))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), reqwest::StatusCode::SEE_OTHER);
    let location = response
        .headers()
        .get("location")
        .unwrap()
        .to_str()
        .unwrap();
    let url = reqwest::Url::parse(location).unwrap();
    assert_eq!(url.host_str(), Some("discord.com"));
    let query = url
        .query_pairs()
        .collect::<std::collections::BTreeMap<_, _>>();
    assert_eq!(query.get("response_type").map(|v| v.as_ref()), Some("code"));
    assert_eq!(query.get("scope").map(|v| v.as_ref()), Some("identify"));
    assert!(query.get("state").is_some_and(|value| value.len() >= 40));
    assert_eq!(
        query.get("redirect_uri").map(|v| v.as_ref()),
        Some("https://rtx4090.tail37947a.ts.net:10000/auth/callback")
    );
    let cookie = response
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(cookie.starts_with("__Host-frameweaver_oauth="));
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("Secure"));
    assert!(cookie.contains("SameSite=Lax"));
    assert!(cookie.contains("Path=/"));
}

#[tokio::test]
async fn allowed_callback_creates_session_me_and_rejects_replay() {
    let base = server("987654321098765432", "987654321098765432").await;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let login = client
        .get(format!("{base}/auth/login"))
        .send()
        .await
        .unwrap();
    let oauth_cookie = cookie_pair(login.headers().get("set-cookie").unwrap().to_str().unwrap());
    let state = reqwest::Url::parse(login.headers().get("location").unwrap().to_str().unwrap())
        .unwrap()
        .query_pairs()
        .find(|(name, _)| name == "state")
        .unwrap()
        .1
        .into_owned();

    let callback_url = format!("{base}/auth/callback?code=valid-code&state={state}");
    let callback = client
        .get(&callback_url)
        .header("cookie", &oauth_cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(callback.status(), reqwest::StatusCode::SEE_OTHER);
    let session_cookie_header = callback
        .headers()
        .get_all("set-cookie")
        .iter()
        .map(|value| value.to_str().unwrap())
        .find(|value| value.starts_with("__Host-frameweaver_session="))
        .unwrap();
    assert!(session_cookie_header.contains("HttpOnly"));
    assert!(session_cookie_header.contains("Secure"));
    assert!(session_cookie_header.contains("SameSite=Lax"));
    let session_cookie = cookie_pair(session_cookie_header);

    let me = client
        .get(format!("{base}/api/auth/me"))
        .header("cookie", &session_cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(me.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = me.json().await.unwrap();
    assert_eq!(body["authenticated"], true);
    assert_eq!(body["displayName"], "Test User");
    assert!(body.get("discordUserId").is_none());

    let private = client
        .get(format!("{base}/api/private"))
        .header("cookie", &session_cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(private.status(), reqwest::StatusCode::OK);
    let replay = client
        .get(&callback_url)
        .header("cookie", &oauth_cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(replay.status(), reqwest::StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn unauthenticated_and_unlisted_users_fail_closed() {
    let base = server("777777777777777777", "987654321098765432").await;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    assert_eq!(
        client
            .get(format!("{base}/api/private"))
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );

    let login = client
        .get(format!("{base}/auth/login"))
        .send()
        .await
        .unwrap();
    let cookie = cookie_pair(login.headers().get("set-cookie").unwrap().to_str().unwrap());
    let state = reqwest::Url::parse(login.headers().get("location").unwrap().to_str().unwrap())
        .unwrap()
        .query_pairs()
        .find(|(name, _)| name == "state")
        .unwrap()
        .1
        .into_owned();
    let denied = client
        .get(format!(
            "{base}/auth/callback?code=valid-code&state={state}"
        ))
        .header("cookie", cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), reqwest::StatusCode::FORBIDDEN);
    assert!(denied.headers().get_all("set-cookie").iter().all(|value| {
        !value
            .to_str()
            .unwrap()
            .starts_with("__Host-frameweaver_session=")
    }));
}
