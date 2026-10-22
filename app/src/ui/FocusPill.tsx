import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  focusStorageKey,
  formatRemaining,
  pauseFocus,
  remainingMs,
  resumeFocus,
  serializeSession,
} from "../domain/focus.ts";
import {
  pillEvents,
  pillProgress,
  pillSnapshot,
  mainInForeground,
  pillVisibility,
  type MainWindowState,
  readPillEnabled,
  type PillSnapshot,
} from "./focusPillState.ts";
// The pill's own paint ships beside it (AGENTS.md: co-located styles).
import "./FocusPill.css";

/**
 * The mini floating focus timer pill (task T8, spec S8.4, S3).
 *
 * A second, tiny Tauri window (`pill`, created hidden by `src-tauri/pill.rs`)
 * loading this same bundle: `main.tsx` renders this component alone when the
 * window's initialization script has marked the page `__PILL__`. It renders
 * one compact focus surface — title, countdown, ring, pause, close — and owns
 * the window's visibility.
 *
 * State comes from the main window's timer through shared localStorage
 * (`focusStorageKey`, one origin, one source of truth): the pill recomputes
 * status and remaining from the stored instants once a second while on screen,
 * and listens for `pill://state` from the main window for instant updates and
 * the task label. Pause/resume from the pill rewrite that same entry and ask
 * the main window (which owns the session) to apply them for real; the main
 * window's canonical write echoes back and agrees. Rust owns the one fact the
 * page cannot know — whether the main window is in the foreground — via
 * `pill://main-focus`.
 *
 * The window is shown/hidden, never closed: × hides it for the current
 * session (until a new session starts), and Rust recreated it hidden at
 * startup, so nothing flashes before the first state arrives.
 *
 * Idle CPU (S3): the one-second interval exists only while the window is
 * visible and a session is live — hidden, the pill runs no timer at all and
 * wakes on events. No rAF loops anywhere; the ring glides on a CSS transition
 * of its own stroke.
 */

/** The countdown ring's geometry: viewBox 26, stroke radius 11, 2πr. */
const RING_CIRCUMFERENCE = 2 * Math.PI * 11;

/** Pause and close icons, on the app's 24 px stroke grid. */
function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8.2 5.5v13M15.8 5.5v13" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" fill="none" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 6.4v11.2L18 12z" fill="currentColor" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function FocusPill() {
  const [snapshot, setSnapshot] = useState<PillSnapshot | null>(() =>
    pillSnapshot(readStoredSession(), Date.now()),
  );
  const [label, setLabel] = useState("Focus");
  /** Null until Rust answers; treated as "main in front" (pill hidden). */
  const [mainFocused, setMainFocused] = useState<boolean | null>(null);
  const [enabled, setEnabled] = useState(() => readPillEnabled());
  const [hiddenByUser, setHiddenByUser] = useState(false);
  /** Replays the entrance each time the window appears (S3). */
  const [entrance, setEntrance] = useState(0);
  const shownRef = useRef(false);

  /* Rust lowers the WebView2 memory target while the pill is hidden. */
  const syncMemory = () => invoke("pill_visibility_changed");
  const now = Date.now();
  const visible = pillVisibility({ enabled, hiddenByUser, mainFocused: mainFocused !== false, session: snapshot?.session ?? null, now });
  const paused = snapshot?.status === "paused";

  /* The window follows the rule wherever it changes, and each appearance
     replays the short entrance. */
  useEffect(() => {
    const pill = getCurrentWindow();
    if (visible) {
      if (!shownRef.current) {
        shownRef.current = true;
        setEntrance(tick => tick + 1);
      }
      void pill.show().then(syncMemory).catch(() => undefined);
    } else {
      shownRef.current = false;
      void pill.hide().then(syncMemory).catch(() => undefined);
    }
  }, [visible]);

  /* One tick per second, and only while the pill is on screen with a live
     session: hidden, this effect owns no timer at all (S3 idle budget). */
  useEffect(() => {
    if (!visible || snapshot === null) return;
    const id = window.setInterval(() => {
      const next = pillSnapshot(readStoredSession(), Date.now());
      setSnapshot(next);
      setEnabled(readPillEnabled());
    }, 1000);
    return () => window.clearInterval(id);
  }, [visible, snapshot !== null]);

  /* A new session un-hides the pill the user closed (L15: "esconderla" lasts
     one session, not forever). startedAt is the session's identity. */
  const startedAtRef = useRef<number | null>(snapshot?.session.startedAt ?? null);
  useEffect(() => {
    const startedAt = snapshot?.session.startedAt ?? null;
    if (startedAt !== startedAtRef.current) {
      startedAtRef.current = startedAt;
      setHiddenByUser(false);
    }
  }, [snapshot?.session.startedAt]);

  /* Wire-up: the foreground fact from Rust, the session and label from the
     main window, and one request so a pill that loads late still gets the
     current session. */
  useEffect(() => {
    let disposed = false;
    const unlistens: Array<() => void> = [];
    const track = (unlisten: () => void) => {
      if (disposed) unlisten();
      else unlistens.push(unlisten);
    };

    void invoke<MainWindowState>("pill_main_focused")
      .then(main => setMainFocused(mainInForeground(main)))
      .catch(() => setMainFocused(false));
    void emit(pillEvents.requestState).catch(() => undefined);

    void listen<MainWindowState>(pillEvents.mainFocus, event => setMainFocused(mainInForeground(event.payload))).then(track).catch(() => undefined);
    void listen<{ session: string | null; label: string }>(pillEvents.state, event => {
      setLabel(event.payload.label);
      const next = event.payload.session === null ? null : pillSnapshot(event.payload.session, Date.now());
      setSnapshot(next);
    })
      .then(track)
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlistens.forEach(unlisten => unlisten());
    };
  }, []);

  /** Pause/resume on the shared session, then hand the write to the main
     window's timer (the canonical owner) via the bridge. */
  const togglePause = useCallback(() => {
    const current = pillSnapshot(readStoredSession(), Date.now());
    if (!current || current.status === "done") return;
    const stamp = Date.now();
    const next = current.status === "paused" ? resumeFocus(current.session, stamp) : pauseFocus(current.session, stamp);
    try {
      window.localStorage.setItem(focusStorageKey, serializeSession(next));
    } catch {
      /* the main window's write still lands */
    }
    const status = next.pausedAt !== undefined ? "paused" : "running";
    setSnapshot({ session: next, status, remaining: remainingMs(next, stamp) });
    void emit(next.pausedAt !== undefined ? pillEvents.pause : pillEvents.resume).catch(() => undefined);
  }, []);

  /** Click (not drag) on the body hands control back to the main window. */
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if ((event.target as HTMLElement).closest("button")) return;
    drag.current = { x: event.screenX, y: event.screenY, moved: false };
  }, []);
  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const state = drag.current;
    if (!state || state.moved) return;
    if (Math.hypot(event.screenX - state.x, event.screenY - state.y) > 5) {
      state.moved = true;
      void getCurrentWindow()
        .startDragging()
        .catch(() => undefined);
    }
  }, []);
  const onPointerUp = useCallback(() => {
    const state = drag.current;
    drag.current = null;
    if (state && !state.moved) void invoke("pill_focus_main").catch(() => undefined);
  }, []);

  if (snapshot === null) return null;
  const progress = pillProgress(snapshot.session, now);

  return (
    <div
      key={entrance}
      className={`focus-pill${paused ? " is-paused" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <svg className="focus-pill-ring" viewBox="0 0 26 26" aria-hidden="true" focusable="false">
        <circle className="focus-pill-ring-track" cx="13" cy="13" r="11" />
        <circle
          className="focus-pill-ring-fill"
          cx="13"
          cy="13"
          r="11"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress)}
        />
      </svg>
      <span className="focus-pill-title" title={label}>{label}</span>
      <span className="focus-pill-time">{formatRemaining(snapshot.remaining)}</span>
      <div className="focus-pill-actions">
        <button type="button" className="focus-pill-button" aria-label={paused ? "Resume focus" : "Pause focus"} onClick={togglePause}>
          {paused ? <PlayIcon /> : <PauseIcon />}
        </button>
        <button
          type="button"
          className="focus-pill-button"
          aria-label="Hide for this session"
          onClick={() => setHiddenByUser(true)}
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

function readStoredSession(): string | null {
  try {
    return window.localStorage.getItem(focusStorageKey);
  } catch {
    return null;
  }
}
