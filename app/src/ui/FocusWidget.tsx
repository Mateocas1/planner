import { motion } from "motion/react";
import { formatRemaining, type FocusStatus } from "../domain/focus.ts";
import { dur, easeOut, spring } from "./motion.ts";
import type { FocusControls } from "./useFocusTimer.ts";
// The timer's own paint ships beside it (AGENTS.md: co-located styles).
import "./FocusWidget.css";

/**
 * The focus timer's surface in the sidebar (value roadmap §3: "▶ Focus starts
 * the timer"; "an always-on timer only when a block is running").
 *
 * Two pieces:
 *
 * - `FocusStartButton` is the ▶ on an Up next row. Instead of a glyph on its own
 *   line it sits at the end of the row it focuses, and its accessible name names
 *   the block, so a row is focusable by pointer and by screen reader alike.
 * - `FocusWidget` is the live card: the block's name, the countdown, and
 *   Pause/Resume and Stop. One timer, one card, and it takes the row's place in
 *   Up next instead of repeating it.
 *
 * The countdown is *recomputed* from the session's instants by the hook, so the
 * digits are plain text here: nothing in this file animates a number.
 */

/** The ▶ glyph: a filled triangle, drawn on the app's 24 px grid. */
export function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="focus-play" focusable="false">
      <path d="M9 6.4v11.2L18 12z" fill="currentColor" />
    </svg>
  );
}

/** The ▶ at the end of an Up next row. */
export function FocusStartButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="focus-start" aria-label={`Focus: ${label}`} onClick={onClick}>
      <PlayIcon />
    </button>
  );
}

/** What an assistive technology hears when the state changes, never per tick. */
function announcement(status: FocusStatus | null): string {
  if (status === "paused") return "Focus paused";
  if (status === "done") return "Focus done";
  return "Focus running";
}

export function FocusWidget({ focus }: { focus: FocusControls }) {
  const { status, remaining, label } = focus;
  const paused = status === "paused";
  const done = status === "done";
  return (
    <motion.div
      className="side-card focus-card"
      role="group"
      aria-label="Focus timer"
      initial={{ opacity: 0, transform: "translateY(-4px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      exit={{ opacity: 0, transform: "translateY(-4px)", transition: { duration: dur.pop, ease: easeOut } }}
      transition={spring.snappy}
    >
      <p className="focus-line">
        <span className="focus-title" title={label}>{label}</span>
        <span className={`focus-time${paused ? " is-paused" : ""}${done ? " is-done" : ""}`}>
          {done ? "Done" : formatRemaining(remaining)}
        </span>
      </p>
      <p className="sr-only" aria-live="polite">{announcement(status)}</p>
      <div className="focus-actions">
        {!done && (
          <button type="button" className="focus-action" onClick={paused ? focus.resume : focus.pause}>
            {paused ? "Resume" : "Pause"}
          </button>
        )}
        <button type="button" className="focus-action" onClick={focus.stop}>Stop</button>
      </div>
    </motion.div>
  );
}
