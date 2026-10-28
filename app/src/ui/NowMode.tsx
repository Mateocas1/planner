import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { BlockView, TaskView } from "../data/store.ts";
import { setTaskCompleted } from "../data/tasks.ts";
import { currentAndNext } from "../domain/upNext.ts";
import { formatRemaining } from "../domain/focus.ts";
import { t } from "../i18n/index.ts";
import { CloseIcon } from "./icons.tsx";
import { formatDuration, timeLabel } from "./time.ts";
import { unlinkedBlockTitle, type FocusControls } from "./useFocusTimer.ts";
import { settle } from "./write.ts";
// The surface's own paint ships beside it (AGENTS.md: co-located styles).
import "./NowMode.css";

/**
 * Now mode: one block, full screen, and nothing else (distinctive roadmap F5).
 *
 * It answers the question the product exists for, at arm's length: what am I
 * doing, how much of it is left, and what comes next. Three rules shape it:
 *
 * 1. **The clock is the content.** The ring and the remaining time are read from
 *    the block's own instants on every tick, never counted, so a suspended tab
 *    that comes back shows the truth instead of a stale number.
 * 2. **One surface, one timer.** The focus controls drive the shell's hook
 *    (`useFocusTimer`), so starting here means the sidebar's card shows the same
 *    session: there is one timer in the app, not one per surface.
 * 3. **The device is borrowed, not taken.** Wake lock and fullscreen are
 *    feature-detected, requested once, and released on exit, on unmount and when
 *    the tab is hidden. If either API is missing the surface still works and
 *    says nothing about it (criterion 6).
 *
 * Escape, or the close button, leaves; both put focus back where it came from.
 */

/** The wake lock's state, published as `data-wake-lock` for the tests and for
 * anyone reading the DOM. */
type WakeState = "pending" | "held" | "denied" | "unavailable";

/** The fullscreen request's state, published the same way. "requested" means
 * the request resolved without the document entering (a stubbed or refused
 * request); "active" means the browser really put the element fullscreen. */
type FullscreenState = "pending" | "active" | "requested" | "denied" | "unavailable";

/** The subset of the Screen Wake Lock API this surface uses. */
type WakeLockApi = { request: (kind: "screen") => Promise<{ release: () => Promise<void> }> };

/** How long the surface sits untouched before its chrome steps back. */
const idleAfterMs = 30_000;

/** The last five minutes count in seconds: the digits are the point by then. */
const secondsBelowMs = 5 * 60_000;

const focusableSelector = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function NowMode({
  uid,
  blocks,
  tasks,
  timeZone,
  focus,
  onClose,
}: {
  uid: string;
  blocks: BlockView[];
  tasks: TaskView[];
  /** The profile zone: every wall-clock word here is a planner day. */
  timeZone: string;
  /** The shell's one timer. `null`-like when the surface has none (a phone). */
  focus: FocusControls;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [idle, setIdle] = useState(false);
  const [wake, setWake] = useState<WakeState>("pending");
  const [fullscreen, setFullscreen] = useState<FullscreenState>("pending");

  /* One tick a second: the ring moves per minute for most of a block and per
     second in the last five, and the remaining time is the surface's content,
     so it is never inferred from a coarser clock (the shell's Now card ticks
     every 30 s because it is one card among several). The tick pauses while
     the document is hidden (T12: the window went to the tray or is
     minimized) — nothing on the surface can move unseen, and coming back
     re-reads the clock at once so no stale number is ever shown. */
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const onVisibility = () => {
      const next = document.visibilityState !== "hidden";
      setVisible(next);
      if (next) setNowMs(Date.now());
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  useEffect(() => {
    if (!visible) return undefined;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [visible]);

  /* Idle chrome: after 30 s without input the buttons dissolve; any pointer,
     wheel or key brings them back. The timer restarts on every event, so the
     surface is never dimmed while the user is using it. */
  useEffect(() => {
    let timer = window.setTimeout(() => setIdle(true), idleAfterMs);
    const wakeChrome = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), idleAfterMs);
    };
    window.addEventListener("pointermove", wakeChrome);
    window.addEventListener("pointerdown", wakeChrome);
    window.addEventListener("wheel", wakeChrome, { passive: true });
    window.addEventListener("keydown", wakeChrome);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", wakeChrome);
      window.removeEventListener("pointerdown", wakeChrome);
      window.removeEventListener("wheel", wakeChrome);
      window.removeEventListener("keydown", wakeChrome);
    };
  }, []);

  /* The screen wake lock: held while the surface is visible and the tab is in
     front, released on hide and on unmount. A refused request is not an error
     the user can act on, so it is recorded and swallowed. */
  useEffect(() => {
    const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
    if (!api) {
      setWake("unavailable");
      return;
    }
    let sentinel: { release: () => Promise<void> } | null = null;
    let cancelled = false;
    const acquire = () => {
      if (document.visibilityState === "hidden") return;
      api.request("screen").then(
        next => {
          if (cancelled) {
            void next.release().catch(() => undefined);
            return;
          }
          sentinel = next;
          setWake("held");
        },
        () => setWake("denied"),
      );
    };
    const release = () => {
      const held = sentinel;
      sentinel = null;
      if (held) void held.release().catch(() => undefined);
    };
    acquire();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") release();
      else acquire();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      release();
    };
  }, []);

  /* Fullscreen. A browser that refuses (no user activation, a policy, an
     embedded frame) leaves the overlay exactly as usable, and the browser's own
     Escape out of fullscreen counts as leaving the surface: the user asked for
     the screen back, so the overlay closes with it. */
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof root.requestFullscreen !== "function") {
      setFullscreen("unavailable");
      return;
    }
    let cancelled = false;
    let active = false;
    void (async () => {
      try {
        await root.requestFullscreen({ navigationUI: "hide" });
        if (cancelled) return;
        active = document.fullscreenElement === root;
        setFullscreen(active ? "active" : "requested");
      } catch {
        if (!cancelled) setFullscreen("denied");
      }
    })();
    const onFullscreenChange = () => {
      if (active && document.fullscreenElement === null) onClose();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      cancelled = true;
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (document.fullscreenElement === root) void document.exitFullscreen?.().catch(() => undefined);
    };
  }, [onClose]);

  /* The page behind is covered, so it must not scroll under the surface: a
     wheel over the overlay would otherwise leave the reader somewhere else on
     the page they come back to. */
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  /* Focus moves into the surface and goes back to the control that opened it. */
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  /* Escape belongs to the surface while it is open. */
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [onClose]);

  const now = new Date(nowMs);
  /* "Now" is an instant, not a date: the running block and the next one come
     from the one rule the whole app shares (domain/upNext.ts). */
  const { current, next } = currentAndNext(blocks, nowMs, timeZone);

  const taskOf = (entry: BlockView | undefined) =>
    entry?.taskId === undefined ? undefined : tasks.find(candidate => candidate.id === entry.taskId);
  const nameOf = (entry: BlockView) => taskOf(entry)?.title ?? unlinkedBlockTitle();
  const task = taskOf(current);

  const start = current ? Date.parse(current.start) : 0;
  const end = current ? Date.parse(current.end) : 0;
  const total = end - start;
  const remainingMs = current ? Math.max(0, end - nowMs) : 0;
  const progress = total > 0 ? Math.min(1, Math.max(0, (nowMs - start) / total)) : 0;
  const remaining =
    remainingMs < secondsBelowMs
      ? t("now.left", { time: formatRemaining(remainingMs) })
      : t("now.left", { time: formatDuration(remainingMs / 60_000) });

  const nextLine = (entry: BlockView) => t("now.next", { time: timeLabel(new Date(entry.start), timeZone), name: nameOf(entry) });
  const upNext = next === undefined ? null : nextLine(next);
  const minutesToNext = next === undefined ? 0 : (Date.parse(next.start) - nowMs) / 60_000;

  const complete = (entry: TaskView) => {
    void settle(setTaskCompleted(uid, entry.id, true)).catch(() => undefined);
  };

  const timerLabel = focus.status === "paused" ? t("focus.resumeFocus") : focus.status === "running" ? t("focus.pauseFocus") : t("focus.startFocus");
  const runTimer = () => {
    if (focus.status === "paused") focus.resume();
    else if (focus.status === "running") focus.pause();
    else focus.startNext();
  };
  /* A phone runs no timer (the shell disables it), so the surface offers the
     controls only where the hook can act. */
  const hasTimer = focus.session !== null || focus.canStart;

  /* Tab is contained: the page behind is covered, so it must not be reachable. */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const at = document.activeElement;
    if (event.shiftKey && (at === first || at === rootRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && at === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={rootRef}
      className={`now-mode${idle ? " is-idle" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={t("now.title")}
      tabIndex={-1}
      data-wake-lock={wake}
      data-fullscreen={fullscreen}
      onKeyDown={onKeyDown}
    >
      <div className="now-chrome now-chrome-top">
        <button type="button" className="icon-button large now-close" aria-label={t("now.close")} onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      <div className="now-content">
        {current ? (
          <>
            <p className="now-kicker">{t("now.kicker")}</p>
            <div
              className="now-ring"
              role="progressbar"
              aria-label={t("now.progress")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
              style={{ "--progress": progress } as CSSProperties}
            >
              <span className="now-remaining">{remaining}</span>
            </div>
            <h2 className="now-headline">{nameOf(current)}</h2>
            <p className="now-up-next">{upNext ?? t("now.nothingElse")}</p>
          </>
        ) : (
          <>
            <p className="now-kicker">{t("now.freeNow")}</p>
            <h2 className="now-headline tabular">
              {next === undefined
                ? t("now.nothingElse")
                : t("now.nextIn", { time: timeLabel(new Date(next.start), timeZone), name: nameOf(next), duration: formatDuration(minutesToNext) })}
            </h2>
          </>
        )}
      </div>

      <footer className="now-chrome now-actions">
        {current && task && !task.completed && (
          <button type="button" className="button button-accent" onClick={() => complete(task)}>
            {t("now.markDone")}
          </button>
        )}
        {hasTimer && (
          <button type="button" className="button" onClick={runTimer}>
            {timerLabel}
          </button>
        )}
      </footer>
    </div>
  );
}
