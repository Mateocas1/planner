import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../desktop.ts";
import {
  acceleratorLabel,
  captureFromEvent,
  keycaps,
  MODIFIER_CODES,
  rebindableShortcut,
  setBinding,
  useShortcutBinding,
} from "./shortcutRegistry.ts";
import "./ShortcutRecorder.css";

/**
 * The shortcut recorder (design brief §5, spec S2): one row control for a
 * rebindable shortcut. Idle it shows keycaps; pressed it listens for one
 * keydown in the capture phase — the view's own Escape and the shell's
 * shortcuts never see the captured keys — with modifier-only presses waiting,
 * Escape cancelling and blur cancelling. A chord that would shadow another
 * shortcut, a fixed in-app chord or one the browser or OS keeps is refused
 * with a red line under the row and the chip returns to its old value; a
 * saved chord shows a quiet check for 1.6 s.
 *
 * Two storages, one row: palette and chat go through the registry's
 * localStorage (`setBinding`, which runs the conflict check and is the same
 * source the live listeners read, so a rebind is live the moment it lands);
 * quick-add goes to Rust (`quickadd_set_shortcut`), which validates,
 * re-registers live, persists the choice and rolls back to the previous
 * shortcut when the OS refuses the new one — that error copy is shown as-is,
 * with what was kept.
 */

const QUICKADD_DEFAULT = rebindableShortcut("quickAdd").defaultAccelerator;
const QUICKADD_STATUS_ERROR = "The hotkey control is not available in this build.";

type QuickAddStatus = { shortcut: string; registered: boolean; error: string | null };

export function ShortcutRecorder({ id, desktop }: { id: "palette" | "chat" | "quickAdd"; desktop: boolean }) {
  const shortcut = rebindableShortcut(id);
  const isQuickAdd = id === "quickAdd";
  // The registry is the live truth for palette and chat (the listeners read
  // it too); quick-add's truth lives in Rust and is fetched once.
  const localBinding = useShortcutBinding(id as "palette" | "chat");
  const [quickAddStatus, setQuickAddStatus] = useState<QuickAddStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isQuickAdd || !desktop) return undefined;
    invoke<QuickAddStatus>("quickadd_get_config")
      .then(setQuickAddStatus)
      .catch(() => setMessage(QUICKADD_STATUS_ERROR));
    return undefined;
  }, [isQuickAdd, desktop]);

  useEffect(() => {
    if (!saved) return undefined;
    const timer = window.setTimeout(() => setSaved(false), 1600);
    return () => window.clearTimeout(timer);
  }, [saved]);

  /** Saves one chord. Palette and chat are validated by the registry (a
   * conflict comes back as a message and nothing is written); quick-add is
   * validated and registered by Rust, which rolls back on a refusal. */
  const commit = (accelerator: string | null) => {
    setMessage(null);
    if (isQuickAdd) {
      const next = accelerator ?? QUICKADD_DEFAULT;
      invoke<QuickAddStatus>("quickadd_set_shortcut", { shortcut: next })
        .then(status => {
          setQuickAddStatus(status);
          setSaved(true);
        })
        .catch(cause => {
          // The Rust side already rolled back to the previous shortcut; say
          // what was kept, the way the brief asks.
          const reason = cause instanceof Error ? cause.message : "Planner could not register that combination.";
          const current = quickAddStatus?.shortcut ?? QUICKADD_DEFAULT;
          setMessage(`${reason} Kept ${acceleratorLabel(current)}.`);
        });
      return;
    }
    const refused = setBinding(id, accelerator);
    if (refused !== null) setMessage(refused.message);
    else setSaved(true);
  };

  // Recording: one keydown, capture phase, so neither the view's Escape nor
  // the shell's shortcuts acts on the captured keys.
  useEffect(() => {
    if (!recording) return undefined;
    const onKey = (event: KeyboardEvent) => {
      // A modifier alone is not a choice yet: recording keeps waiting for the
      // key that completes the chord, exactly as the brief specifies.
      if (MODIFIER_CODES.has(event.code)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(false);
        chipRef.current?.focus();
        return;
      }
      setRecording(false);
      chipRef.current?.focus();
      const capture = captureFromEvent(event);
      if (!capture.ok) {
        setMessage(capture.error);
        return;
      }
      commit(capture.accelerator);
    };
    const onBlur = () => setRecording(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- commit reads only state setters and quickAddStatus
  }, [recording, isQuickAdd, quickAddStatus]);

  if (shortcut.desktopOnly && !desktop) return null;

  const current = isQuickAdd ? quickAddStatus?.shortcut ?? QUICKADD_DEFAULT : localBinding;
  const caps = keycaps(current);
  const isDefault = current === shortcut.defaultAccelerator;
  const unavailable = isQuickAdd && quickAddStatus !== null && !quickAddStatus.registered;

  return (
    <div className="shortcut-recorder" data-recording={recording ? "true" : undefined}>
      <button
        ref={chipRef}
        type="button"
        className="shortcut-chip"
        aria-label={`${shortcut.label} shortcut: ${recording ? "press the new combination, Escape to cancel" : caps.join(" + ")}`}
        aria-live="polite"
        data-recording={recording ? "true" : undefined}
        onClick={() => {
          setMessage(null);
          setRecording(true);
        }}
        onBlur={() => setRecording(false)}
      >
        {recording ? <span className="shortcut-chip-recording">Press keys…</span> : caps.map(cap => <kbd key={cap}>{cap}</kbd>)}
      </button>
      {!isDefault && (
        <button type="button" className="link-button shortcut-restore" onClick={() => commit(null)}>
          Restore default
        </button>
      )}
      {saved && <span className="shortcut-saved" role="status">✓ Saved</span>}
      {recording && (
        <p className="settings-row-desc" aria-live="polite">
          Recording — press the new combination, Escape to cancel.
        </p>
      )}
      {unavailable && !recording && (
        <p className="settings-row-desc">Planner could not register this shortcut — another app may be using it.</p>
      )}
      {message && <p className="inline-error shortcut-conflict" role="alert">{message}</p>}
    </div>
  );
}
