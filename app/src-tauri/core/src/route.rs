//! The `calendar://` deep-link route set.
//!
//! A link is data, never code: it is parsed into one of a closed set of routes
//! and anything else is ignored. The webview is only ever told "go to today" or
//! "go to this date"; it is never navigated to a URL taken from a link.

use serde::Serialize;

/// Where a deep link can take the app. The serialized form is the event payload
/// the webview receives (`{"kind":"today"}` / `{"kind":"day","date":"YYYY-MM-DD"}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Route {
    Today,
    Day { date: String },
}

const SCHEME: &str = "calendar://";
/// A link longer than this is not one of ours; `calendar://day/YYYY-MM-DD` is 26.
const MAX_LEN: usize = 64;

/// Parses `calendar://today` and `calendar://day/YYYY-MM-DD` (one optional
/// trailing slash, scheme case-insensitive). Query strings, fragments, extra
/// segments, unknown hosts and impossible dates yield `None`.
pub fn parse(url: &str) -> Option<Route> {
    if url.len() > MAX_LEN || !url.is_ascii() {
        return None;
    }
    let scheme = url.get(..SCHEME.len())?;
    if !scheme.eq_ignore_ascii_case(SCHEME) {
        return None;
    }
    let rest = url.get(SCHEME.len()..)?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let mut segments = rest.split('/');
    match (segments.next()?, segments.next(), segments.next()) {
        ("today", None, None) => Some(Route::Today),
        ("day", Some(date), None) if valid_date(date) => Some(Route::Day { date: date.to_owned() }),
        _ => None,
    }
}

/// `YYYY-MM-DD` naming a real calendar day (leap years included), 1970-2100.
fn valid_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<u32> {
        let part = &text[range];
        if part.bytes().all(|byte| byte.is_ascii_digit()) { part.parse().ok() } else { None }
    };
    let (Some(year), Some(month), Some(day)) = (digits(0..4), digits(5..7), digits(8..10)) else {
        return false;
    };
    if !(1970..=2100).contains(&year) || !(1..=12).contains(&month) {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let last = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    (1..=last).contains(&day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn today_parses_with_and_without_trailing_slash_and_any_scheme_case() {
        assert_eq!(parse("calendar://today"), Some(Route::Today));
        assert_eq!(parse("calendar://today/"), Some(Route::Today));
        assert_eq!(parse("CALENDAR://today"), Some(Route::Today));
    }

    #[test]
    fn day_parses_a_real_date() {
        assert_eq!(
            parse("calendar://day/2026-10-22"),
            Some(Route::Day { date: "2026-10-22".into() })
        );
        assert_eq!(
            parse("calendar://day/2028-02-29/"),
            Some(Route::Day { date: "2028-02-29".into() })
        );
    }

    #[test]
    fn impossible_or_malformed_dates_are_ignored() {
        for url in [
            "calendar://day/2027-02-29",
            "calendar://day/2026-13-01",
            "calendar://day/2026-00-10",
            "calendar://day/2026-04-31",
            "calendar://day/2026-10-32",
            "calendar://day/1969-12-31",
            "calendar://day/2101-01-01",
            "calendar://day/2026-1-5",
            "calendar://day/2026-10-+5",
            "calendar://day/",
            "calendar://day",
        ] {
            assert_eq!(parse(url), None, "{url}");
        }
    }

    #[test]
    fn unknown_routes_schemes_and_shapes_are_ignored() {
        for url in [
            "",
            "calendar://",
            "calendar://settings",
            "calendar://today/extra",
            "calendar://today?x=1",
            "calendar://today#frag",
            "calendar://day/2026-10-22/extra",
            "calendar:today",
            "calendar:///today",
            "http://today",
            "javascript:alert(1)",
            "calendar://today\u{0}",
            "calendar://tod\u{e4}y",
            "https://evil.example/calendar://today",
            "calendar://day/2026-10-22\n",
        ] {
            assert_eq!(parse(url), None, "{url:?}");
        }
        assert_eq!(parse(&format!("calendar://day/{}", "9".repeat(80))), None);
    }

    #[test]
    fn route_serializes_to_the_event_payload() {
        assert_eq!(serde_json::to_string(&Route::Today).unwrap(), r#"{"kind":"today"}"#);
        assert_eq!(
            serde_json::to_string(&Route::Day { date: "2026-10-22".into() }).unwrap(),
            r#"{"kind":"day","date":"2026-10-22"}"#
        );
    }
}
