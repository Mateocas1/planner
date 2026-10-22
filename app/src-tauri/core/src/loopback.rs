//! The loopback half of the OAuth 2.0 for Native Apps flow (RFC 8252 §7.3).
//!
//! A one-shot HTTP listener on `127.0.0.1` receives Google's redirect, checks
//! `state` in constant time and hands back the authorization code. Everything
//! else is refused. Nothing here logs, stores or echoes a code or a state.

use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::sleep;
use std::time::{Duration, Instant};

use serde::Deserialize;
use url::Url;

use crate::pkce::ct_eq;

/// How long the user has to finish in the browser.
pub const FLOW_TIMEOUT: Duration = Duration::from_secs(180);
/// Requests to paths other than `/` (favicon, probes) tolerated before giving up.
const MAX_STRAY: u32 = 16;
/// The request line is all we read; a larger head is not a browser redirect.
const MAX_HEAD: usize = 8 * 1024;
const POLL: Duration = Duration::from_millis(50);
const IO_TIMEOUT: Duration = Duration::from_secs(2);

/// What a request to the loopback server means.
#[derive(Debug, PartialEq, Eq)]
pub enum Callback {
    /// Google redirected back with a code and the expected `state`.
    Code(String),
    /// The user refused (`error=...`) and `state` matched.
    Denied,
    /// `GET /` whose `state` is missing, wrong or repeated, or which has no code.
    Rejected,
    /// Another path or method (favicon, probes): answered 404 and ignored.
    Stray,
}

/// How the one-shot wait ended unsuccessfully.
#[derive(Debug, PartialEq, Eq)]
pub enum WaitError {
    Denied,
    Rejected,
    Timeout,
    Cancelled,
    Io,
}

/// Classifies the first line of an HTTP request against the expected `state`.
pub fn parse_callback(request_line: &str, expected_state: &str) -> Callback {
    let mut parts = request_line.split(' ');
    let (Some("GET"), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Callback::Stray;
    };
    if !version.starts_with("HTTP/1.") {
        return Callback::Stray;
    }
    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
        return Callback::Stray;
    };
    if url.path() != "/" {
        return Callback::Stray;
    }
    let (mut state, mut code, mut error) = (Vec::new(), Vec::new(), Vec::new());
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "state" => state.push(value.into_owned()),
            "code" => code.push(value.into_owned()),
            "error" => error.push(()),
            _ => {}
        }
    }
    // A repeated or absent `state` is never accepted; compare in constant time.
    let [state] = state.as_slice() else { return Callback::Rejected };
    if !ct_eq(state, expected_state) {
        return Callback::Rejected;
    }
    match (code.as_slice(), error.len()) {
        ([], 1) => Callback::Denied,
        ([code], 0) if !code.is_empty() => Callback::Code(code.clone()),
        _ => Callback::Rejected,
    }
}

/// The URL Google opens the browser on. Online access only: no refresh token.
pub fn auth_url(endpoint: &str, client_id: &str, redirect_uri: &str, scope: &str, state: &str, challenge: &str) -> String {
    Url::parse_with_params(
        endpoint,
        &[
            ("client_id", client_id),
            ("redirect_uri", redirect_uri),
            ("response_type", "code"),
            ("scope", scope),
            ("state", state),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
        ],
    )
    .expect("the endpoint is a constant URL")
    .into()
}

/// Binds the ephemeral loopback port. IPv4 loopback only: never a public interface.
pub fn bind() -> std::io::Result<(TcpListener, String)> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    Ok((listener, format!("http://127.0.0.1:{port}/")))
}

const PAGE_DONE: &str = "<!doctype html><meta charset=utf-8><title>Planner</title><body style=\"font:16px system-ui;margin:3rem\"><p>You can close this tab and return to Planner.</p>";
const PAGE_DENIED: &str = "<!doctype html><meta charset=utf-8><title>Planner</title><body style=\"font:16px system-ui;margin:3rem\"><p>Google sign-in was cancelled. You can close this tab.</p>";
const PAGE_REJECTED: &str = "<!doctype html><meta charset=utf-8><title>Planner</title><body style=\"font:16px system-ui;margin:3rem\"><p>This sign-in link is not valid. Close this tab and try again from Planner.</p>";

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).and_then(|()| stream.write_all(body.as_bytes()));
    let _ = stream.flush();
    let _ = stream.shutdown(std::net::Shutdown::Write);
}

/// Reads up to the end of the request line. `None` for a silent, slow or oversized peer.
fn read_request_line(stream: &mut TcpStream) -> Option<String> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(IO_TIMEOUT)).ok()?;
    let mut buffer = Vec::with_capacity(512);
    let mut chunk = [0u8; 512];
    while buffer.len() < MAX_HEAD {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = buffer.windows(2).position(|pair| pair == b"\r\n") {
            return String::from_utf8(buffer[..end].to_vec()).ok();
        }
    }
    None
}

/// Serves until exactly one request to `/` arrives, the deadline passes or
/// `cancel` is set. The listener is dropped by the caller, which closes the port.
/// Returns the authorization code only for a request whose `state` matches.
pub fn wait_for_code(
    listener: &TcpListener,
    expected_state: &str,
    deadline: Instant,
    cancel: &AtomicBool,
) -> Result<String, WaitError> {
    listener.set_nonblocking(true).map_err(|_| WaitError::Io)?;
    let mut stray = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(WaitError::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(WaitError::Timeout);
        }
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                sleep(POLL);
                continue;
            }
            Err(_) => return Err(WaitError::Io),
        };
        let outcome = match read_request_line(&mut stream) {
            Some(line) => parse_callback(&line, expected_state),
            None => Callback::Stray,
        };
        match outcome {
            Callback::Code(code) => {
                respond(&mut stream, "200 OK", PAGE_DONE);
                return Ok(code);
            }
            Callback::Denied => {
                respond(&mut stream, "200 OK", PAGE_DENIED);
                return Err(WaitError::Denied);
            }
            Callback::Rejected => {
                respond(&mut stream, "400 Bad Request", PAGE_REJECTED);
                return Err(WaitError::Rejected);
            }
            Callback::Stray => {
                respond(&mut stream, "404 Not Found", "");
                stray += 1;
                if stray >= MAX_STRAY {
                    return Err(WaitError::Rejected);
                }
            }
        }
    }
}

/// The fields of Google's token response the app uses. A `refresh_token`, if
/// Google ever sent one, is deliberately not deserialized.
#[derive(Deserialize)]
struct TokenBody {
    access_token: String,
    expires_in: u64,
    token_type: String,
}

/// Parses the token endpoint body into `(access_token, expires_in_seconds)`.
pub fn parse_token_response(body: &[u8]) -> Option<(String, u64)> {
    let parsed: TokenBody = serde_json::from_slice(body).ok()?;
    (parsed.token_type.eq_ignore_ascii_case("bearer") && !parsed.access_token.is_empty())
        .then_some((parsed.access_token, parsed.expires_in))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    const STATE: &str = "s-t_4te";

    fn line(query: &str) -> String {
        format!("GET /{query} HTTP/1.1")
    }

    #[test]
    fn a_matching_state_with_a_code_is_accepted_and_decoded() {
        assert_eq!(
            parse_callback(&line(&format!("?state={STATE}&code=4%2F0Ab-c&scope=x")), STATE),
            Callback::Code("4/0Ab-c".into())
        );
    }

    #[test]
    fn a_wrong_missing_or_repeated_state_is_rejected() {
        for query in [
            "?state=nope&code=c".to_owned(),
            "?code=c".to_owned(),
            "?state=&code=c".to_owned(),
            format!("?state={STATE}x&code=c"),
            format!("?state={STATE}&state={STATE}&code=c"),
            "?state=nope&error=access_denied".to_owned(),
            "".to_owned(),
        ] {
            assert_eq!(parse_callback(&line(&query), STATE), Callback::Rejected, "{query}");
        }
    }

    #[test]
    fn a_refusal_needs_the_right_state_too() {
        assert_eq!(
            parse_callback(&line(&format!("?state={STATE}&error=access_denied")), STATE),
            Callback::Denied
        );
    }

    #[test]
    fn a_missing_empty_or_repeated_code_is_rejected() {
        for query in [
            format!("?state={STATE}"),
            format!("?state={STATE}&code="),
            format!("?state={STATE}&code=a&code=b"),
            format!("?state={STATE}&code=a&error=x"),
        ] {
            assert_eq!(parse_callback(&line(&query), STATE), Callback::Rejected, "{query}");
        }
    }

    #[test]
    fn other_paths_methods_and_garbage_are_stray() {
        for text in [
            "GET /favicon.ico HTTP/1.1",
            "GET /callback?state=s-t_4te&code=c HTTP/1.1",
            "POST /?state=s-t_4te&code=c HTTP/1.1",
            "GET / SPDY/3",
            "GET /",
            "",
            "\u{0}\u{1}",
        ] {
            assert_eq!(parse_callback(text, STATE), Callback::Stray, "{text:?}");
        }
    }

    #[test]
    fn the_auth_url_carries_pkce_s256_state_loopback_and_no_offline_access() {
        let url = auth_url(
            "https://accounts.google.com/o/oauth2/v2/auth",
            "client.apps.googleusercontent.com",
            "http://127.0.0.1:5555/",
            "scope-a scope-b",
            "the-state",
            "the-challenge",
        );
        let parsed = Url::parse(&url).unwrap();
        assert_eq!(parsed.scheme(), "https");
        let params: Vec<(String, String)> =
            parsed.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        let get = |key: &str| params.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
        assert_eq!(get("code_challenge_method"), Some("S256"));
        assert_eq!(get("code_challenge"), Some("the-challenge"));
        assert_eq!(get("state"), Some("the-state"));
        assert_eq!(get("redirect_uri"), Some("http://127.0.0.1:5555/"));
        assert_eq!(get("response_type"), Some("code"));
        assert_eq!(get("scope"), Some("scope-a scope-b"));
        assert_eq!(get("access_type"), None);
        assert!(!url.contains("code_verifier"));
    }

    #[test]
    fn token_bodies_are_read_and_refresh_tokens_are_ignored() {
        let body = br#"{"access_token":"ya29.x","expires_in":3599,"token_type":"Bearer","refresh_token":"r","scope":"s"}"#;
        assert_eq!(parse_token_response(body), Some(("ya29.x".into(), 3599)));
        assert_eq!(parse_token_response(br#"{"error":"invalid_grant"}"#), None);
        assert_eq!(parse_token_response(br#"{"access_token":"","expires_in":1,"token_type":"Bearer"}"#), None);
        assert_eq!(parse_token_response(b"not json"), None);
    }

    fn serve(state: &'static str, wait: Duration, cancel: Arc<AtomicBool>) -> (String, thread::JoinHandle<Result<String, WaitError>>) {
        let (listener, redirect) = bind().unwrap();
        let port: u16 = redirect.trim_end_matches('/').rsplit(':').next().unwrap().parse().unwrap();
        assert_eq!(listener.local_addr().unwrap().ip(), Ipv4Addr::LOCALHOST);
        let handle = thread::spawn(move || wait_for_code(&listener, state, Instant::now() + wait, &cancel));
        (format!("127.0.0.1:{port}"), handle)
    }

    fn request(addr: &str, target: &str) -> String {
        let mut stream = TcpStream::connect(addr).unwrap();
        write!(stream, "GET {target} HTTP/1.1\r\nHost: {addr}\r\n\r\n").unwrap();
        let mut reply = String::new();
        let _ = stream.read_to_string(&mut reply);
        reply
    }

    #[test]
    fn the_listener_returns_the_code_after_ignoring_a_favicon() {
        let (addr, handle) = serve(STATE, Duration::from_secs(5), Arc::new(AtomicBool::new(false)));
        assert!(request(&addr, "/favicon.ico").starts_with("HTTP/1.1 404"));
        let reply = request(&addr, &format!("/?state={STATE}&code=the-code"));
        assert!(reply.starts_with("HTTP/1.1 200"));
        assert!(reply.contains("You can close this tab"));
        assert!(!reply.contains("the-code"));
        assert_eq!(handle.join().unwrap(), Ok("the-code".to_owned()));
        // The port is closed once the single request was served.
        assert!(TcpStream::connect(&addr).is_err());
    }

    #[test]
    fn the_listener_rejects_a_wrong_state_and_closes() {
        let (addr, handle) = serve(STATE, Duration::from_secs(5), Arc::new(AtomicBool::new(false)));
        assert!(request(&addr, "/?state=evil&code=c").starts_with("HTTP/1.1 400"));
        assert_eq!(handle.join().unwrap(), Err(WaitError::Rejected));
        assert!(TcpStream::connect(&addr).is_err());
    }

    #[test]
    fn the_listener_reports_a_refusal() {
        let (addr, handle) = serve(STATE, Duration::from_secs(5), Arc::new(AtomicBool::new(false)));
        request(&addr, &format!("/?state={STATE}&error=access_denied"));
        assert_eq!(handle.join().unwrap(), Err(WaitError::Denied));
    }

    #[test]
    fn the_listener_times_out_and_can_be_cancelled() {
        let (_, handle) = serve(STATE, Duration::from_millis(150), Arc::new(AtomicBool::new(false)));
        assert_eq!(handle.join().unwrap(), Err(WaitError::Timeout));
        let cancel = Arc::new(AtomicBool::new(false));
        let (_, handle) = serve(STATE, Duration::from_secs(30), cancel.clone());
        cancel.store(true, Ordering::Relaxed);
        assert_eq!(handle.join().unwrap(), Err(WaitError::Cancelled));
    }
}
