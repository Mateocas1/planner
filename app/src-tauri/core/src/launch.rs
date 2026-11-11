//! External entry points into the running shell.
//!
//! Wayland compositors do not let an app grab global keys, so on Hyprland the
//! quick-add chord is a compositor bind that runs `planner --quickadd` (or
//! opens `calendar://quickadd`). The second process forwards its arguments to
//! the running one through the single-instance plugin; this module decides,
//! from those arguments alone, what was asked for. Like `route`, it never
//! evaluates argument text: an argument either is one of the known triggers or
//! is ignored.

/// The command-line flag a compositor bind (or a terminal) passes.
pub const QUICKADD_FLAG: &str = "--quickadd";

const QUICKADD_LINK: &str = "calendar://quickadd";

/// Whether one argument is the quick-add trigger: the exact flag, or the link
/// `calendar://quickadd` (scheme case-insensitive, one optional trailing slash).
fn is_quickadd(arg: &str) -> bool {
    if arg == QUICKADD_FLAG {
        return true;
    }
    let link = arg.strip_suffix('/').unwrap_or(arg);
    link.len() == QUICKADD_LINK.len() && link.eq_ignore_ascii_case(QUICKADD_LINK)
}

/// Whether a launch's arguments (program name excluded) ask for quick add.
pub fn quickadd_requested<S: AsRef<str>>(args: impl IntoIterator<Item = S>) -> bool {
    args.into_iter().any(|arg| is_quickadd(arg.as_ref()))
}

/// Whether GTK will talk Wayland in this session, from `WAYLAND_DISPLAY` and
/// `GDK_BACKEND`: a Wayland display is set and the backend list does not put
/// X11 first (Omarchy exports `GDK_BACKEND=wayland,x11,*`). Under Wayland a
/// global key grab only sees XWayland windows, so the shell leaves the chord to
/// the compositor.
pub fn wayland_session(wayland_display: Option<&str>, gdk_backend: Option<&str>) -> bool {
    let display = wayland_display.is_some_and(|value| !value.trim().is_empty());
    let first_backend = gdk_backend
        .and_then(|list| list.split(',').next())
        .map(str::trim)
        .unwrap_or("");
    display && first_backend != "x11"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_flag_and_the_link_request_quick_add() {
        assert!(quickadd_requested(["--quickadd"]));
        assert!(quickadd_requested(["calendar://quickadd"]));
        assert!(quickadd_requested(["calendar://quickadd/"]));
        assert!(quickadd_requested(["CALENDAR://QuickAdd"]));
        assert!(quickadd_requested(["--autostart", "--quickadd"]));
    }

    #[test]
    fn anything_else_does_not() {
        for arg in [
            "",
            "quickadd",
            "--quick-add",
            "--QUICKADD",
            "--quickadd=1",
            "-quickadd",
            "calendar://quickadd//",
            "calendar://quickadd?text=x",
            "calendar://quickadd/extra",
            "calendar://today",
            "calendar:quickadd",
            "https://example.com/calendar://quickadd",
            "/usr/bin/planner",
        ] {
            assert!(!quickadd_requested([arg]), "{arg:?}");
        }
        assert!(!quickadd_requested(Vec::<&str>::new()));
    }

    #[test]
    fn wayland_needs_a_display_and_no_forced_x11_backend() {
        assert!(wayland_session(Some("wayland-1"), None));
        assert!(wayland_session(Some("wayland-1"), Some("wayland,x11,*")));
        assert!(wayland_session(Some("wayland-1"), Some("")));
        assert!(!wayland_session(Some("wayland-1"), Some("x11")));
        assert!(!wayland_session(Some("wayland-1"), Some(" x11 ,wayland")));
        assert!(!wayland_session(None, Some("wayland")));
        assert!(!wayland_session(Some(""), None));
        assert!(!wayland_session(Some("  "), None));
    }
}
