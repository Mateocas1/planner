import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../desktop.ts";
import { formatShortcutLabel, shortcutFromEvent } from "./quickAddWindow.ts";
import "./QuickAddWindow.css";

/**
 * The quick-add hotkey control (task T5, spec S8.1) — the desktop-only row in
 * Day settings, mounted by `DaySettingsSheet` only inside the Tauri shell, so
 * the web build never sees it. The Rust side owns the truth: this row reads
 * the current shortcut and its registration status with
 * `quickadd_get_config`, captures a new combination by listening for one
 * keydown (Escape cancels, like any sheet), and hands the accelerator to
 * `quickadd_set_shortcut`, which validates, re-registers live, persists the
 * choice and rolls back to the previous shortcut when the OS refuses the new
 * one. What the user sees on a refusal is the registration error, never a
 * silent no-op.
 *
 * Nothing here animates: the state is read at a glance, the way the rest of
 * this sheet works.
 */

type ShortcutStatus = { shortcut: string; registered: boolean; error: string | null };

export function QuickAddShortcut() {
  const [status, setStatus] = useState<ShortcutStatus | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return undefined;
    invoke<ShortcutStatus>("quickadd_get_config")
      .then(setStatus)
      .catch(() => setMessage("The hotkey control is not available in this build."));
    return undefined;
  }, []);

  useEffect(() => {
    if (!capturing) return undefined;
    const onKey = (event: KeyboardEvent) => {
      // Capture phase, so the sheet's own Escape close and the button's Enter
      // activation never see the captured keys.
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturing(false);
        return;
      }
      setCapturing(false);
      const capture = shortcutFromEvent(event);
      if (!capture.ok) {
        setMessage(capture.error);
        return;
      }
      invoke<ShortcutStatus>("quickadd_set_shortcut", { shortcut: capture.accelerator })
        .then(next => {
          setStatus(next);
          setMessage(null);
        })
        .catch(cause => {
          setMessage(cause instanceof Error ? cause.message : "Planner could not register that combination.");
        });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing]);

  const label = status === null ? "—" : formatShortcutLabel(status.shortcut);

  return (
    <div className="form-group quickadd-shortcut">
      <div className="form-row">
        <span id="quickadd-shortcut-label">Quick add hotkey</span>
        <button
          type="button"
          className="quickadd-shortcut-button"
          aria-labelledby="quickadd-shortcut-label"
          aria-live="polite"
          onClick={() => {
            setMessage(null);
            setCapturing(true);
          }}
          onBlur={() => setCapturing(false)}
        >
          {capturing ? "Press keys…" : label}
        </button>
      </div>
      <p className="day-settings-note">
        {capturing
          ? "Press a modifier (Ctrl, Alt, Shift or the Windows key) plus a key. Esc cancels."
          : status !== null && !status.registered
            ? "Planner could not register this shortcut — another app may be using it."
            : "Opens the quick-add window from anywhere in Windows."}
      </p>
      {message && <p className="inline-error" role="alert">{message}</p>}
    </div>
  );
}
