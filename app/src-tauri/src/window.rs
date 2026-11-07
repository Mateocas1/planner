//! Window chrome for the desktop shell (task T3, spec S6).
//!
//! The window itself keeps native Windows decorations: the OS draws the
//! caption buttons (min / max-restore / close with the system hover states,
//! the red close hover and the snap-layouts flyout on maximize hover), and
//! the caption strip is a native drag region with double-click maximize.
//! Keeping `decorations` on is what guarantees that behaviour; see the T3
//! report for why `tauri-plugin-decorum` was rejected.
//!
//! What we add on top is the Windows 11 Mica backdrop: the webview is
//! transparent (wry only clears the WebView2 composition background), so the
//! DWM system backdrop shows through wherever the page paints nothing. On
//! Windows 10 (and Mica-less systems) `apply_mica` fails, the frontend drops
//! the `desktop-mica` class and the page keeps its opaque designed
//! background — a plain window, no crash.

use tauri::{Runtime, WebviewWindow};

/// Applies the Mica backdrop for `dark` or `light` appearance.
///
/// `Some(dark)` also flips `DWMWA_USE_IMMERSIVE_DARK_MODE`, so the native
/// caption strip (text colour, button glyphs) and the backdrop tint follow
/// the app's theme even when the OS setting differs. Called again on every
/// theme change from the frontend; re-applying is idempotent.
#[cfg(target_os = "windows")]
pub fn apply_backdrop<R: Runtime>(window: &WebviewWindow<R>, dark: bool) -> Result<(), String> {
    window_vibrancy::apply_mica(window, Some(dark)).map_err(|error| error.to_string())
}

/// Linux has no backdrop API of its own: a compositor (Hyprland's blur) blurs
/// whatever shows through a transparent window, and the app cannot tell
/// whether it does. So the translucent page is opt-in: with
/// `PLANNER_BACKDROP=blur` in the environment (set it only where a compositor
/// blur rule covers the window, see `packaging/linux/hyprland/planner.lua`)
/// the command succeeds and the page drops its opaque background the way it
/// does over Mica; otherwise the page stays opaque.
#[cfg(target_os = "linux")]
pub fn apply_backdrop<R: Runtime>(_window: &WebviewWindow<R>, _dark: bool) -> Result<(), String> {
    match std::env::var("PLANNER_BACKDROP") {
        Ok(value) if value == "blur" => Ok(()),
        _ => Err("no compositor backdrop (set PLANNER_BACKDROP=blur)".into()),
    }
}

/// Other builds never run the shell; the frontend treats the error as
/// "opaque window" and keeps the web-only background.
#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub fn apply_backdrop<R: Runtime>(_window: &WebviewWindow<R>, _dark: bool) -> Result<(), String> {
    Err("window backdrops are Windows-only".into())
}

/// Frontend command: re-apply the Mica backdrop for the current theme.
///
/// Returns `Err` on Windows 10 / unsupported systems; the frontend then keeps
/// the page opaque (the web design), so the window degrades to a plain
/// opaque window instead of showing content over the raw desktop.
#[tauri::command]
pub fn desktop_backdrop<R: Runtime>(window: WebviewWindow<R>, dark: bool) -> Result<(), String> {
    apply_backdrop(&window, dark)
}

/// The Ronda 9 Linux diagnostics, read from the environment once at startup.
/// Unknown values fall back to the defaults, so a typo never changes behavior.
#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq, Eq)]
pub struct Diag {
    /// `PLANNER_GUARD=off`: the page skips the compositor handoff (D11).
    pub guard_off: bool,
    /// `PLANNER_GLASS=blur`: the page keeps the blurred glass instead of the
    /// flat Linux default.
    pub glass_blur: bool,
    /// `PLANNER_FPS=1`: the page shows the frame-time HUD.
    pub fps: bool,
}

#[cfg(target_os = "linux")]
impl Diag {
    pub fn from_values(guard: Option<&str>, glass: Option<&str>, fps: Option<&str>) -> Self {
        Self {
            guard_off: guard == Some("off"),
            glass_blur: glass == Some("blur"),
            fps: fps == Some("1"),
        }
    }

    pub fn from_env() -> Self {
        let read = |name: &str| std::env::var(name).ok();
        Self::from_values(
            read("PLANNER_GUARD").as_deref(),
            read("PLANNER_GLASS").as_deref(),
            read("PLANNER_FPS").as_deref(),
        )
    }

    /// The init script: the WebKitGTK marker plus `window.__PLANNER_DIAG__`
    /// (`src/ui/perfHud.ts` reads it). Only known values are emitted, as JSON.
    pub fn init_script(&self) -> String {
        let diag = serde_json::json!({
            "guard": if self.guard_off { "off" } else { "on" },
            "glass": if self.glass_blur { "blur" } else { "flat" },
            "fps": self.fps,
        });
        format!("window.__WEBKITGTK__ = true; window.__PLANNER_DIAG__ = {diag};")
    }
}

/// Linux: marks every webview as WebKitGTK before any app script runs
/// (`window.__WEBKITGTK__`), so `main.tsx` installs the end-of-animation guard
/// in `src/ui/compositorHandoff.ts` (Ronda 6 S5). WebKitGTK presents one stale
/// frame when a compositor animation ends; WebView2 does not, so Windows never
/// registers this plugin. The same script hands the page the diagnostics
/// switches (`PLANNER_GUARD`, `PLANNER_GLASS`, `PLANNER_FPS`, see the README).
#[cfg(target_os = "linux")]
pub fn webkitgtk_marker<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("webkitgtk-marker")
        .js_init_script(Diag::from_env().init_script())
        .build()
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::Diag;

    #[test]
    fn defaults_keep_the_guard_flat_glass_and_no_hud() {
        let diag = Diag::from_values(None, None, None);
        assert_eq!(
            diag.init_script(),
            r#"window.__WEBKITGTK__ = true; window.__PLANNER_DIAG__ = {"fps":false,"glass":"flat","guard":"on"};"#
        );
    }

    #[test]
    fn known_values_switch_each_diagnostic() {
        let diag = Diag::from_values(Some("off"), Some("blur"), Some("1"));
        assert_eq!(
            diag.init_script(),
            r#"window.__WEBKITGTK__ = true; window.__PLANNER_DIAG__ = {"fps":true,"glass":"blur","guard":"off"};"#
        );
    }

    #[test]
    fn unknown_values_fall_back_and_are_never_echoed() {
        let diag = Diag::from_values(Some("</script>\""), Some("flat"), Some("true"));
        assert_eq!(diag, Diag::from_values(None, None, None));
        assert!(!diag.init_script().contains("script"));
    }
}
