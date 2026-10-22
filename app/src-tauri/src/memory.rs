//! Memory pass (task T12, spec S2): lower the WebView2 memory usage target
//! while a window is hidden or minimized.
//!
//! `ICoreWebView2_19::SetMemoryUsageTargetLevel` tells the WebView2 runtime
//! whether a webview should aim for low memory: `LOW` trims and suspends what
//! it can (allocator caches, the browser process's own working set), `NORMAL`
//! restores it. It is a *target*, not a command: an older runtime that lacks
//! interface 19 simply ignores the hint, so every failure here is logged and
//! dropped — never an error the app cares about.
//!
//! The rule per window:
//!
//! - **main** (T6): hidden to the tray (close button or tray toggle) or
//!   minimized → `LOW`; shown or restored → `NORMAL`.
//! - **quickadd** (T5): created hidden at startup and hidden on blur, so it
//!   lives at `LOW` almost all the time and flips to `NORMAL` only while the
//!   hotkey popup is on screen.
//!
//! Tauri does not expose the interface, so this reaches through
//! `WebviewWindow::with_webview` to the `ICoreWebView2Controller` and casts the
//! webview to `ICoreWebView2_19`. The `webview2-com` dependency is pinned to
//! the exact version already in the lock file (wry 0.57's), so the COM
//! interfaces are one and the same crate, not two incompatible copies.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Runtime, WebviewWindow};

/// Whether each window currently wants `LOW`. One per window label: the swap
/// makes repeated syncs (event + call site) free when nothing changed.
static MAIN_HIDDEN: AtomicBool = AtomicBool::new(false);
static QUICKADD_HIDDEN: AtomicBool = AtomicBool::new(false);

/// Applies the hidden/minimized rule to the main window.
pub fn sync_main<R: Runtime>(window: &WebviewWindow<R>) {
    sync(window, &MAIN_HIDDEN);
}

/// Applies the hidden rule to the quick-add window (it cannot be minimized:
/// not resizable and never shown maximized).
pub fn sync_quickadd<R: Runtime>(window: &WebviewWindow<R>) {
    sync(window, &QUICKADD_HIDDEN);
}

/// Reads the window's current state and moves the runtime to `LOW` when the
/// window is hidden or minimized, back to `NORMAL` when it is neither. The
/// getters are best-effort: a failed read is treated as "visible", the state
/// that costs nothing.
fn sync<R: Runtime>(window: &WebviewWindow<R>, current: &AtomicBool) {
    let hidden = window.is_visible().map(|visible| !visible).unwrap_or(false)
        || window.is_minimized().unwrap_or(false);
    if current.swap(hidden, Ordering::Relaxed) == hidden {
        return;
    }
    set_target_level(window, hidden);
}

#[cfg(target_os = "windows")]
fn set_target_level<R: Runtime>(window: &WebviewWindow<R>, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows::core::Interface;

    let level = if low {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
    } else {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
    };
    // with_webview runs the closure on the main thread, where the controller
    // lives. `LOW` applies while the webview is hidden or minimized, which is
    // exactly when we set it.
    let outcome = window.with_webview(move |webview| unsafe {
        let controller = webview.controller();
        let Ok(webview2) = controller.CoreWebView2() else {
            eprintln!("memory: the WebView2 core object is unavailable");
            return;
        };
        // Older runtimes predate interface 19: the cast fails and the hint is
        // dropped, which is the documented degradation for this API.
        let Ok(extended) = webview2.cast::<ICoreWebView2_19>() else {
            eprintln!("memory: this WebView2 runtime lacks ICoreWebView2_19; memory target level not set");
            return;
        };
        if let Err(error) = extended.SetMemoryUsageTargetLevel(level) {
            eprintln!("memory: SetMemoryUsageTargetLevel failed: {}", error.code());
        }
    });
    if let Err(error) = outcome {
        eprintln!("memory: could not reach the webview: {}", error);
    }
}

/// Non-Windows builds (e.g. a Linux `cargo check` of this crate) never run the
/// shell; there is no WebView2 to hint at.
#[cfg(not(target_os = "windows"))]
fn set_target_level<R: Runtime>(_window: &WebviewWindow<R>, _low: bool) {}
