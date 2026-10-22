//! Windows idle probe (task T9, spec S8.5).
//!
//! One command, `idle_seconds`, reports how long since the last keyboard or
//! mouse input anywhere on the desktop: `GetLastInputInfo` gives the tick the
//! last input happened at and `GetTickCount64` gives the uptime, so the
//! difference is the idle time — a session-independent value the frontend
//! compares against the away threshold while a focus session runs. The
//! frontend owns every decision (threshold, spans, confirmation); this module
//! only measures.
//!
//! Non-Windows builds get a stub that always answers 0 (never idle), so the
//! crate still compiles and tests on Linux. Only the frontend gating in
//! `isTauri()` decides whether the command is ever called.

/// Seconds since the last user input, or 0 when that cannot be measured.
#[cfg(windows)]
pub fn measure_idle_seconds() -> u64 {
    use std::mem::size_of;
    use windows::Win32::System::SystemInformation::GetTickCount64;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    // SAFETY: `info` is a valid, correctly sized LASTINPUTINFO that the API
    // fills in; both calls are plain reads of system state with no handle.
    let ok = unsafe { GetLastInputInfo(&mut info) };
    if !ok.as_bool() {
        return 0;
    }
    let now = unsafe { GetTickCount64() };
    let last = u64::from(info.dwTime);
    // Both stamps are milliseconds of uptime. `dwTime` is a u32 and wraps
    // roughly every 49.7 days of uptime, so a last-input stamp above the u64
    // counter means the counter wrapped since that input.
    let idle_ms = if now >= last { now - last } else { now + (u32::MAX as u64 + 1) - last };
    idle_ms / 1000
}

/// Stub for non-Windows builds: the probe is a Windows-first feature (S1) and
/// the frontend never polls it outside the desktop shell.
#[cfg(not(windows))]
pub fn measure_idle_seconds() -> u64 {
    0
}

/// Tauri command: seconds since the last user input on the machine.
#[tauri::command]
pub fn idle_seconds() -> u64 {
    measure_idle_seconds()
}

#[cfg(all(test, windows))]
mod tests {
    use super::measure_idle_seconds;

    #[test]
    fn a_machine_with_input_reports_a_small_idle_time() {
        // Nobody can guarantee an exact value in CI, but a desktop that just
        // ran this test cannot plausibly have been idle for an hour.
        let seconds = measure_idle_seconds();
        assert!(seconds < 3600, "implausible idle time: {seconds}s");
    }
}
