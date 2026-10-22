//! Google OAuth for the Calendar import in the desktop shell: the system
//! browser plus a loopback redirect (RFC 8252) with PKCE S256 (RFC 7636).
//!
//! A Google sign-in popup cannot work inside WebView2, so the webview asks this
//! command for an access token instead. The token goes to the webview and
//! nowhere else: it is not written to disk, no refresh token is requested, and
//! neither tokens, codes nor verifiers are ever logged. The protocol pieces
//! (PKCE, redirect parsing, the one-shot listener) are in `planner_core`.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use planner_core::loopback::{self, FLOW_TIMEOUT};
use planner_core::oauth::{non_empty, GoogleToken, OAuthError, SCOPE};
use planner_core::pkce;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_opener::OpenerExt;

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT: &str = "https://oauth2.googleapis.com/revoke";

/// A "Desktop app" OAuth client, baked in at build time. Neither value is
/// committed: without them the build still succeeds and the import says so.
/// (Google asks installed apps for the secret too, but treats it as public.)
const CLIENT_ID: Option<&str> = option_env!("GOOGLE_DESKTOP_CLIENT_ID");
const CLIENT_SECRET: Option<&str> = option_env!("GOOGLE_DESKTOP_CLIENT_SECRET");

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BODY: u64 = 64 * 1024;

/// The sign-in in progress, if any. Starting a new one cancels the old one.
#[derive(Default)]
pub struct OAuthFlow(Mutex<Option<Arc<AtomicBool>>>);

fn client() -> Result<(&'static str, Option<&'static str>), OAuthError> {
    let id = non_empty(CLIENT_ID).ok_or(OAuthError::NotConfigured)?;
    Ok((id, non_empty(CLIENT_SECRET)))
}

fn agent() -> ureq::Agent {
    // No redirects: the token POST carries the code, verifier and client secret.
    ureq::AgentBuilder::new().timeout(HTTP_TIMEOUT).redirects(0).build()
}

/// Trades the authorization code (+ PKCE verifier) for an access token.
fn exchange(
    client_id: &str,
    client_secret: Option<&str>,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<GoogleToken, OAuthError> {
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("code_verifier", verifier),
        ("redirect_uri", redirect_uri),
        ("client_id", client_id),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret));
    }
    let response = agent().post(TOKEN_ENDPOINT).send_form(&form).map_err(|_| OAuthError::Failed)?;
    let mut body = Vec::new();
    response.into_reader().take(MAX_BODY).read_to_end(&mut body).map_err(|_| OAuthError::Failed)?;
    let (access_token, expires_in) = loopback::parse_token_response(&body).ok_or(OAuthError::Failed)?;
    Ok(GoogleToken { access_token, expires_in })
}

/// Opens the system browser on Google's consent page and waits (up to ~3 min)
/// for the loopback redirect, then returns the access token.
#[tauri::command]
pub async fn google_oauth_start<R: Runtime>(
    app: AppHandle<R>,
    flow: State<'_, OAuthFlow>,
) -> Result<GoogleToken, OAuthError> {
    let (client_id, client_secret) = client()?;
    let verifier = pkce::new_verifier().map_err(|_| OAuthError::Failed)?;
    let state = pkce::new_state().map_err(|_| OAuthError::Failed)?;
    let (listener, redirect) = loopback::bind().map_err(|_| OAuthError::Failed)?;
    let url = loopback::auth_url(AUTH_ENDPOINT, client_id, &redirect, SCOPE, &state, &pkce::challenge_s256(&verifier));

    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut slot) = flow.0.lock() {
        if let Some(previous) = slot.replace(cancel.clone()) {
            previous.store(true, Ordering::Relaxed);
        }
    }
    app.opener().open_url(url, None::<&str>).map_err(|_| OAuthError::Failed)?;

    let waiting = cancel.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let code = loopback::wait_for_code(&listener, &state, Instant::now() + FLOW_TIMEOUT, &waiting)
            .map_err(OAuthError::from)?;
        // One request only: the port closes before the token exchange starts.
        drop(listener);
        exchange(client_id, client_secret, &code, &verifier, &redirect)
    })
    .await
    .map_err(|_| OAuthError::Failed)
    .and_then(|outcome| outcome);

    if let Ok(mut slot) = flow.0.lock() {
        if slot.as_ref().is_some_and(|current| Arc::ptr_eq(current, &cancel)) {
            *slot = None;
        }
    }
    result
}

/// Cancels the sign-in in progress (the sheet closed): the loopback port closes
/// within one poll. A no-op when nothing is pending.
#[tauri::command]
pub fn google_oauth_cancel(flow: State<'_, OAuthFlow>) {
    if let Ok(mut slot) = flow.0.lock() {
        if let Some(pending) = slot.take() {
            pending.store(true, Ordering::Relaxed);
        }
    }
}

/// Hands an access token back to Google once the import is over (best effort).
#[tauri::command]
pub async fn google_oauth_revoke(token: String) -> Result<(), OAuthError> {
    tauri::async_runtime::spawn_blocking(move || {
        agent().post(REVOKE_ENDPOINT).send_form(&[("token", token.as_str())]).map(|_| ()).map_err(|_| OAuthError::Failed)
    })
    .await
    .map_err(|_| OAuthError::Failed)
    .and_then(|outcome| outcome)
}
