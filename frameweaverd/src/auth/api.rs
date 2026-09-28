use axum::{
    Json, Router,
    body::Body,
    extract::{RawQuery, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::get,
};
use chrono::Utc;
use serde_json::json;

use super::{AuthService, SessionIdentity};

const OAUTH_COOKIE: &str = "__Host-frameweaver_oauth";
const SESSION_COOKIE: &str = "__Host-frameweaver_session";

#[derive(Clone, Debug)]
pub struct AuthenticatedIdentity(pub SessionIdentity);

pub fn build_auth_router(service: AuthService) -> Router {
    Router::new()
        .route("/auth/login", get(login))
        .route("/auth/callback", get(callback))
        .route("/auth/logout", get(logout))
        .route("/api/auth/me", get(me))
        .with_state(service)
}

pub fn protect_router(router: Router, service: AuthService) -> Router {
    router.layer(middleware::from_fn_with_state(service, require_auth))
}

async fn login(State(service): State<AuthService>) -> Response {
    let Some(config) = service.config.enabled() else {
        return Redirect::to("/").into_response();
    };
    let state = AuthService::random_token();
    let binding = AuthService::random_token();
    if service
        .repository
        .create_state(&state, &binding, AuthService::state_expiry())
        .await
        .is_err()
    {
        return auth_error(StatusCode::INTERNAL_SERVER_ERROR, "auth_state_unavailable");
    }
    let mut url = reqwest::Url::parse("https://discord.com/oauth2/authorize").expect("static URL");
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", config.client_id())
        .append_pair("scope", "identify")
        .append_pair("state", &state)
        .append_pair("redirect_uri", config.redirect_uri().as_str())
        .append_pair("prompt", "consent");
    let mut response = Redirect::to(url.as_str()).into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, cookie(OAUTH_COOKIE, &binding, 600));
    no_store(&mut response);
    response
}

async fn callback(
    State(service): State<AuthService>,
    headers: HeaderMap,
    RawQuery(raw): RawQuery,
) -> Response {
    let Some(config) = service.config.enabled() else {
        return auth_error(StatusCode::NOT_FOUND, "auth_disabled");
    };
    let Some(raw) = raw.filter(|value| value.len() <= 4096) else {
        return auth_error(StatusCode::BAD_REQUEST, "invalid_callback");
    };
    let pairs = url::form_urlencoded::parse(raw.as_bytes())
        .into_owned()
        .collect::<Vec<_>>();
    let one = |name: &str| {
        let values = pairs
            .iter()
            .filter(|(key, _)| key == name)
            .map(|(_, value)| value)
            .collect::<Vec<_>>();
        (values.len() == 1).then(|| values[0].clone())
    };
    let (Some(code), Some(state), Some(binding)) = (
        one("code"),
        one("state"),
        cookie_value(&headers, OAUTH_COOKIE),
    ) else {
        return auth_error(StatusCode::BAD_REQUEST, "invalid_callback");
    };
    let state_valid = service
        .repository
        .consume_state(&state, &binding, Utc::now())
        .await
        .unwrap_or(false);
    if !state_valid {
        return auth_error(StatusCode::BAD_REQUEST, "invalid_state");
    }
    let token = match service.discord.exchange_code(&code).await {
        Ok(token) => token,
        Err(_) => return auth_error(StatusCode::BAD_GATEWAY, "discord_unavailable"),
    };
    let user = match service.discord.current_user(&token).await {
        Ok(user) => user,
        Err(_) => return auth_error(StatusCode::BAD_GATEWAY, "discord_unavailable"),
    };
    if !config.allowed_user_ids().contains(&user.id) {
        return auth_error(StatusCode::FORBIDDEN, "not_allowed");
    }
    let session = AuthService::random_token();
    let owner = service.repository.owner_for_discord_id(&user.id);
    let display_name = user
        .global_name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(&user.username);
    if service
        .repository
        .create_session(
            &session,
            owner,
            &user.id,
            display_name,
            AuthService::session_expiry(),
        )
        .await
        .is_err()
    {
        return auth_error(StatusCode::INTERNAL_SERVER_ERROR, "session_unavailable");
    }
    let mut response = Redirect::to("/").into_response();
    response
        .headers_mut()
        .append(header::SET_COOKIE, clear_cookie(OAUTH_COOKIE));
    response
        .headers_mut()
        .append(header::SET_COOKIE, cookie(SESSION_COOKIE, &session, 86_400));
    no_store(&mut response);
    response
}

async fn me(State(service): State<AuthService>, headers: HeaderMap) -> Response {
    if !service.enabled() {
        return Json(json!({"enabled": false, "authenticated": true})).into_response();
    }
    let Some(token) = cookie_value(&headers, SESSION_COOKIE) else {
        return auth_error(StatusCode::UNAUTHORIZED, "authentication_required");
    };
    let Some(identity) = service.resolve(&token).await else {
        return auth_error(StatusCode::UNAUTHORIZED, "authentication_required");
    };
    let mut response =
        Json(json!({"enabled": true, "authenticated": true, "displayName": identity.display_name}))
            .into_response();
    no_store(&mut response);
    response
}

async fn logout(State(service): State<AuthService>, headers: HeaderMap) -> Response {
    if let Some(token) = cookie_value(&headers, SESSION_COOKIE) {
        let _ = service.repository.revoke_session(&token, Utc::now()).await;
    }
    let mut response = Redirect::to("/").into_response();
    response
        .headers_mut()
        .append(header::SET_COOKIE, clear_cookie(SESSION_COOKIE));
    no_store(&mut response);
    response
}

async fn require_auth(
    State(service): State<AuthService>,
    mut request: Request,
    next: Next,
) -> Response {
    if !service.enabled() {
        return next.run(request).await;
    }
    let token = cookie_value(request.headers(), SESSION_COOKIE);
    let Some(identity) = (match token {
        Some(token) => service.resolve(&token).await,
        None => None,
    }) else {
        return auth_error(StatusCode::UNAUTHORIZED, "authentication_required");
    };
    request
        .extensions_mut()
        .insert(AuthenticatedIdentity(identity));
    next.run(request).await
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .find_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            (key == name && !value.is_empty()).then(|| value.to_owned())
        })
}

fn cookie(name: &str, value: &str, max_age: u64) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{name}={value}; Path=/; Max-Age={max_age}; HttpOnly; Secure; SameSite=Lax"
    ))
    .expect("generated cookie is valid")
}

fn clear_cookie(name: &str) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax"
    ))
    .expect("generated cookie is valid")
}

fn auth_error(status: StatusCode, code: &'static str) -> Response {
    let body = Body::from(serde_json::to_vec(&json!({"error": code})).expect("static JSON"));
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body)
        .expect("valid response");
    no_store(&mut response);
    response
}

fn no_store(response: &mut Response) {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
}
