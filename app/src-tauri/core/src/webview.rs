//! WebView2 environment options shared by every window.
//!
//! WebView2 lets windows share one user-data folder (and one browser process)
//! only when their environments were created with identical options. A window
//! built without explicit browser args gets wry's default, which appends
//! `--autoplay-policy=no-user-gesture-required` to the string below; mixing it
//! with the windows from `tauri.conf.json` fails with HRESULT 0x8007139F and
//! aborts the app at startup. Every window must therefore carry exactly
//! [`BROWSER_ARGS`]: the config windows through `additionalBrowserArgs`, the
//! code-built ones through `WebviewWindowBuilder::additional_browser_args`.

/// The single WebView2 browser-args string every window uses.
pub const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

#[cfg(test)]
mod tests {
    use super::BROWSER_ARGS;

    #[test]
    fn every_config_window_pins_the_shared_browser_args() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).expect("valid tauri.conf.json");
        let windows = config["app"]["windows"].as_array().expect("app.windows");
        assert!(!windows.is_empty());
        for window in windows {
            assert_eq!(
                window["additionalBrowserArgs"].as_str(),
                Some(BROWSER_ARGS),
                "window {} must pin the shared WebView2 browser args",
                window["label"]
            );
        }
    }
}
