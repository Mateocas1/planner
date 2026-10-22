//! The shapes shared by the Google OAuth command and its tests.

use serde::{Serialize, Serializer};

use crate::loopback::WaitError;

/// The same two read-only scopes as the web import (`GOOGLE_SCOPES` in
/// `src/data/google-client.ts`; a unit test there keeps the two in step).
pub const SCOPE: &str = "https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly";

/// Why a sign-in did not produce a token. Serialized as the short code the
/// webview maps to a sentence (`src/data/google-client.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OAuthError {
    NotConfigured,
    Cancelled,
    Timeout,
    Denied,
    Failed,
}

impl OAuthError {
    fn code(self) -> &'static str {
        match self {
            Self::NotConfigured => "not_configured",
            Self::Cancelled => "cancelled",
            Self::Timeout => "timeout",
            Self::Denied => "denied",
            Self::Failed => "failed",
        }
    }
}

impl Serialize for OAuthError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.code())
    }
}

impl From<WaitError> for OAuthError {
    fn from(error: WaitError) -> Self {
        match error {
            WaitError::Denied => Self::Denied,
            WaitError::Timeout => Self::Timeout,
            WaitError::Cancelled => Self::Cancelled,
            WaitError::Rejected | WaitError::Io => Self::Failed,
        }
    }
}

/// What the webview receives: the access token and its lifetime in seconds.
/// No `Debug`: a token must not be printable by accident.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleToken {
    pub access_token: String,
    pub expires_in: u64,
}

/// A build-time value that was set but blank counts as not set.
pub fn non_empty(value: Option<&'static str>) -> Option<&'static str> {
    value.filter(|text| !text.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scopes_are_the_two_read_only_calendar_ones() {
        assert_eq!(
            SCOPE.split(' ').collect::<Vec<_>>(),
            [
                "https://www.googleapis.com/auth/calendar.events.readonly",
                "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
            ]
        );
    }

    #[test]
    fn errors_serialize_to_their_short_codes() {
        for (error, code) in [
            (OAuthError::NotConfigured, "not_configured"),
            (OAuthError::Cancelled, "cancelled"),
            (OAuthError::Timeout, "timeout"),
            (OAuthError::Denied, "denied"),
            (OAuthError::Failed, "failed"),
        ] {
            assert_eq!(serde_json::to_string(&error).unwrap(), format!("\"{code}\""));
        }
    }

    #[test]
    fn wait_failures_map_to_errors() {
        assert_eq!(OAuthError::from(WaitError::Denied), OAuthError::Denied);
        assert_eq!(OAuthError::from(WaitError::Timeout), OAuthError::Timeout);
        assert_eq!(OAuthError::from(WaitError::Cancelled), OAuthError::Cancelled);
        assert_eq!(OAuthError::from(WaitError::Rejected), OAuthError::Failed);
    }

    #[test]
    fn a_blank_client_id_is_not_configured() {
        assert_eq!(non_empty(None), None);
        assert_eq!(non_empty(Some("  ")), None);
        assert_eq!(non_empty(Some("id")), Some("id"));
    }

    #[test]
    fn the_token_serializes_for_the_webview_without_a_refresh_token() {
        let token = GoogleToken { access_token: "ya29.x".into(), expires_in: 3599 };
        assert_eq!(serde_json::to_string(&token).unwrap(), r#"{"accessToken":"ya29.x","expiresIn":3599}"#);
    }
}
