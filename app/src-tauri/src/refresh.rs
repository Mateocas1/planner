//! Frame pacing on Linux: make WebKitGTK follow the monitor.
//!
//! On a 144 Hz Wayland monitor WebKitGTK 2.54.2 presented the page at 60 Hz
//! (a 2/3-refresh judder). Two stacked limits, neither a vblank-monitor
//! problem:
//!
//! - GTK 3's frame clock ticks at 60 Hz whenever the window paints through GL
//!   (the default DMABUF path). `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1` paints
//!   through shared memory instead, which hands the frame clock the real
//!   refresh rate. It is read once by the UI process, so `configure_env` sets
//!   it at the top of `run()`.
//! - `PreferPageRenderingUpdatesNear60FPS` (default on) halves `requestAnimationFrame`
//!   on a 144 Hz output to 72 fps. `follow_monitor_refresh` turns it off on
//!   every webview before its window is first shown: flipping it on a window
//!   that is already visible still measured 72 fps.
//!
//! `PLANNER_HZ=60` skips both steps, for an A/B against the old pacing.

use std::ffi::{c_char, c_int, c_void, CStr, OsStr};
use std::sync::{Once, OnceLock};

use tauri::{Runtime, Webview};
use webkit2gtk::glib::translate::ToGlibPtr;
use webkit2gtk::WebViewExt;

/// `PLANNER_HZ=60` opts out of both steps; any other value is ignored.
const OPT_OUT_VAR: &str = "PLANNER_HZ";
const FORCE_SHM_VAR: &str = "WEBKIT_DMABUF_RENDERER_FORCE_SHM";
const NEAR_60_FEATURE: &str = "PreferPageRenderingUpdatesNear60FPS";

/// What this process does about the refresh rate, decided from the environment.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Plan {
    /// Set `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1` (only when it is unset).
    force_shm: bool,
    /// Turn `PreferPageRenderingUpdatesNear60FPS` off on every webview.
    feature_off: bool,
}

impl Plan {
    /// `hz` is `PLANNER_HZ`, `force_shm` the current `WEBKIT_DMABUF_RENDERER_FORCE_SHM`.
    /// A value the user already chose for the latter is never overwritten.
    pub fn from_values(hz: Option<&str>, force_shm: Option<&OsStr>) -> Self {
        if hz == Some("60") {
            return Self { force_shm: false, feature_off: false };
        }
        Self { force_shm: force_shm.is_none(), feature_off: true }
    }

    pub fn from_env() -> Self {
        let hz = std::env::var_os(OPT_OUT_VAR);
        Self::from_values(
            hz.as_deref().and_then(OsStr::to_str),
            std::env::var_os(FORCE_SHM_VAR).as_deref(),
        )
    }
}

/// Step 1. Must be the first thing `run()` does: WebKit reads the variable
/// once, when the first webview starts, and no thread exists yet to race the
/// `set_var`.
pub fn configure_env() {
    if Plan::from_env().force_shm {
        std::env::set_var(FORCE_SHM_VAR, "1");
    }
}

/// Step 2, called for every webview as it is created (the `webkitgtk-marker`
/// plugin). Tauri creates the Planner windows hidden and queues this hook
/// before any `show()`, so the setting lands before the first present.
pub fn follow_monitor_refresh<R: Runtime>(webview: &Webview<R>) {
    if !Plan::from_env().feature_off {
        return;
    }
    // `with_webview` runs the closure on the GTK main thread.
    let _ = webview.with_webview(|platform| {
        let Some(settings) = platform.inner().settings() else { return };
        let pointer: *mut c_void = ToGlibPtr::<*mut webkit2gtk::ffi::WebKitSettings>::to_glib_none(&settings).0.cast();
        // SAFETY: `pointer` is the `WebKitSettings*` of `settings`, which this
        // closure keeps alive until it returns.
        let disabled = api().is_some_and(|api| unsafe { api.disable_near_60(pointer) });
        if !disabled {
            warn_once();
        }
    });
}

fn warn_once() {
    static WARNED: Once = Once::new();
    WARNED.call_once(|| {
        eprintln!("refresh: {NEAR_60_FEATURE} is not available in this WebKitGTK; animation frames stay near 60 fps");
    });
}

// The WebKit feature API (WebKitGTK 2.42+) has no webkit2gtk-rs binding. The
// symbols are looked up at run time instead of declared in an `extern` block:
// a missing one would otherwise fail the dynamic link and the app would not
// start on an older WebKitGTK, for a cosmetic setting.
extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

/// The six WebKit functions the feature switch needs. Opaque pointers stand for
/// `WebKitSettings*`, `WebKitFeatureList*` and `WebKitFeature*`.
struct Api {
    all_features: unsafe extern "C" fn() -> *mut c_void,
    list_length: unsafe extern "C" fn(*mut c_void) -> usize,
    list_get: unsafe extern "C" fn(*mut c_void, usize) -> *mut c_void,
    identifier: unsafe extern "C" fn(*mut c_void) -> *const c_char,
    set_enabled: unsafe extern "C" fn(*mut c_void, *mut c_void, c_int),
    list_unref: unsafe extern "C" fn(*mut c_void),
}

/// Resolved once; `None` when this WebKitGTK predates the feature API.
fn api() -> Option<&'static Api> {
    static API: OnceLock<Option<Api>> = OnceLock::new();
    API.get_or_init(Api::load).as_ref()
}

/// Looks `name` up among the libraries already loaded into the process.
///
/// # Safety
/// `F` must be the `unsafe extern "C" fn` type of the symbol `name` names.
unsafe fn symbol<F: Copy>(name: &CStr) -> Option<F> {
    debug_assert_eq!(std::mem::size_of::<F>(), std::mem::size_of::<*mut c_void>());
    // SAFETY: a null handle is RTLD_DEFAULT; `name` is NUL-terminated.
    let address = dlsym(std::ptr::null_mut(), name.as_ptr());
    // SAFETY: the caller promises the symbol has type `F`, a fn pointer the size of `address`.
    (!address.is_null()).then(|| std::mem::transmute_copy::<*mut c_void, F>(&address))
}

impl Api {
    fn load() -> Option<Self> {
        // SAFETY: each field's type is the C signature of the function it is
        // loaded from (`gsize` is `usize`, `gboolean` is `c_int`).
        unsafe {
            Some(Self {
                all_features: symbol(c"webkit_settings_get_all_features")?,
                list_length: symbol(c"webkit_feature_list_get_length")?,
                list_get: symbol(c"webkit_feature_list_get")?,
                identifier: symbol(c"webkit_feature_get_identifier")?,
                set_enabled: symbol(c"webkit_settings_set_feature_enabled")?,
                list_unref: symbol(c"webkit_feature_list_unref")?,
            })
        }
    }

    /// Finds `PreferPageRenderingUpdatesNear60FPS` by identifier and turns it
    /// off on `settings`. `false` when this WebKit does not know the feature.
    ///
    /// # Safety
    /// `settings` must point to a live `WebKitSettings`, used from its thread.
    unsafe fn disable_near_60(&self, settings: *mut c_void) -> bool {
        // SAFETY (the whole body): `list` is a full-transfer `WebKitFeatureList*`
        // released below; its entries are transfer-none, so they and their
        // identifier strings stay valid until `list_unref`, after the last use.
        let list = (self.all_features)();
        if list.is_null() {
            return false;
        }
        let mut disabled = false;
        for index in 0..(self.list_length)(list) {
            let feature = (self.list_get)(list, index);
            if feature.is_null() {
                continue;
            }
            let identifier = (self.identifier)(feature);
            if !identifier.is_null() && CStr::from_ptr(identifier).to_bytes() == NEAR_60_FEATURE.as_bytes() {
                (self.set_enabled)(settings, feature, 0);
                disabled = true;
                break;
            }
        }
        (self.list_unref)(list);
        disabled
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::{c_char, c_int, c_void, CStr, OsStr};

    use super::{api, symbol, Api, Plan, NEAR_60_FEATURE};

    const BOTH: Plan = Plan { force_shm: true, feature_off: true };
    const NEITHER: Plan = Plan { force_shm: false, feature_off: false };

    #[test]
    fn an_unset_environment_gets_both_steps() {
        assert_eq!(Plan::from_values(None, None), BOTH);
    }

    #[test]
    fn a_force_shm_value_already_set_is_left_alone() {
        assert_eq!(
            Plan::from_values(None, Some(OsStr::new("0"))),
            Plan { force_shm: false, feature_off: true }
        );
    }

    #[test]
    fn planner_hz_60_skips_both_steps() {
        assert_eq!(Plan::from_values(Some("60"), None), NEITHER);
        assert_eq!(Plan::from_values(Some("60"), Some(OsStr::new("1"))), NEITHER);
    }

    #[test]
    fn any_other_planner_hz_value_falls_back_to_the_default() {
        for value in ["", "144", "off", "60 "] {
            assert_eq!(Plan::from_values(Some(value), None), BOTH, "{value:?}");
        }
    }

    /// Reads `PreferPageRenderingUpdatesNear60FPS` back from `settings`.
    fn near_60_enabled(api: &Api, settings: *mut c_void) -> bool {
        // SAFETY: the symbol is `gboolean webkit_settings_get_feature_enabled(WebKitSettings*, WebKitFeature*)`;
        // `settings` is live and the feature list is released after the last use of its entries.
        unsafe {
            let get_enabled: unsafe extern "C" fn(*mut c_void, *mut c_void) -> c_int =
                symbol(c"webkit_settings_get_feature_enabled").expect("get_feature_enabled");
            let list = (api.all_features)();
            let mut enabled = None;
            for index in 0..(api.list_length)(list) {
                let feature = (api.list_get)(list, index);
                if CStr::from_ptr((api.identifier)(feature)).to_bytes() == NEAR_60_FEATURE.as_bytes() {
                    enabled = Some(get_enabled(settings, feature) != 0);
                }
            }
            (api.list_unref)(list);
            enabled.expect("WebKit lists the feature")
        }
    }

    extern "C" {
        fn dlopen(file: *const c_char, mode: c_int) -> *mut c_void;
    }

    /// End to end on a bare `WebKitSettings`: no window and no page, but WebKit
    /// reads the GTK style settings when it creates one, which crashes without a
    /// display session. So it is opt-in: `cargo test --lib -- --ignored`.
    /// It is created through the C API because the Rust binding wants `gtk::init`.
    #[test]
    #[ignore = "needs a display session"]
    fn the_ffi_turns_the_feature_off_on_a_settings_object() {
        // The test binary references no WebKit symbol, so the linker drops the
        // library (the app binary keeps it: wry creates the webview). Load it
        // into the global scope the way the app has it.
        const RTLD_NOW_GLOBAL: c_int = 0x2 | 0x100;
        // SAFETY: `dlopen` with a NUL-terminated soname; the handle is never closed.
        assert!(!unsafe { dlopen(c"libwebkit2gtk-4.1.so.0".as_ptr(), RTLD_NOW_GLOBAL) }.is_null());
        // SAFETY: both symbols have these C signatures; the object is created
        // here, used only below and released with its single reference.
        let (settings, unref) = unsafe {
            let new: unsafe extern "C" fn() -> *mut c_void =
                symbol(c"webkit_settings_new").expect("webkit_settings_new");
            let unref: unsafe extern "C" fn(*mut c_void) = symbol(c"g_object_unref").expect("g_object_unref");
            (new(), unref)
        };
        assert!(!settings.is_null());
        let api = api().expect("this WebKitGTK has the feature API");
        assert!(near_60_enabled(api, settings), "WebKit defaults the feature on");
        // SAFETY: `settings` is the live object created above.
        assert!(unsafe { api.disable_near_60(settings) });
        assert!(!near_60_enabled(api, settings));
        // SAFETY: drops the only reference; `settings` is not used again.
        unsafe { unref(settings) };
    }
}
