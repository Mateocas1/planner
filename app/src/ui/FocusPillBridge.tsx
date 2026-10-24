import { useCallback, useEffect, useRef } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { isTauri } from "../desktop.ts";
import { serializeSession } from "../domain/focus.ts";
import { pillEvents } from "./focusPillState.ts";
import type { FocusControls } from "./useFocusTimer.ts";

/**
 * The main window's half of the focus pill (task T8, spec S8.4).
 *
 * The pill is a separate Tauri window, so the session it shows has to travel:
 * this bridge publishes every session and label change (`pill://state`) and
 * applies the pill's pause/resume requests to the shell's one timer — the same
 * `FocusControls` the sidebar card and the palette use, so the pill can never
 * fork the session. The session itself still lives in shared localStorage
 * (`domain/focus.ts`); the events only carry the news, plus the task label
 * the pill cannot derive from a block id alone.
 *
 * Nothing renders. On the web (and on phones) this is a no-op.
 */
export function FocusPillBridge({ focus }: { focus: FocusControls }) {
  const { session, label } = focus;

  const publish = useCallback(() => {
    if (!isTauri()) return;
    void emit(pillEvents.state, {
      session: session === null ? null : serializeSession(session),
      label,
    }).catch(() => undefined);
  }, [session, label]);

  /* The pill asks once on load (`pill://request-state`) because it may finish
     loading after this window; every other update rides the session change. */
  useEffect(() => {
    if (!isTauri()) return;
    const unlistens: Array<() => void> = [];
    let disposed = false;
    const track = (unlisten: () => void) => {
      if (disposed) unlisten();
      else unlistens.push(unlisten);
    };
    void listen(pillEvents.pause, () => focusRef.current.pause()).then(track).catch(() => undefined);
    void listen(pillEvents.resume, () => focusRef.current.resume()).then(track).catch(() => undefined);
    void listen(pillEvents.requestState, () => publishRef.current()).then(track).catch(() => undefined);
    return () => {
      disposed = true;
      unlistens.forEach(unlisten => unlisten());
    };
  }, []);

  const focusRef = useRef(focus);
  focusRef.current = focus;
  const publishRef = useRef(publish);
  publishRef.current = publish;

  useEffect(publish, [publish]);

  return null;
}
