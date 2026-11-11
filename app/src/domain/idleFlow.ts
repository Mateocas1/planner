/**
 * The decisions of the idle-away flow without React:
 * what a stop records after a confirmed away, the books of away spans, and the
 * confirm / keep handlers. `ui/useIdleAway.ts` and `ui/useFocusTimer.ts` call
 * these and add only state and effects, so every data-safety rule below is
 * unit-tested through the same functions the app runs.
 *
 * - Keep, the close control and Escape call `keepAway`, which has no way to
 *   write: it takes no storage and no write function.
 * - `confirmAway` is the only function that can reach storage or the task
 *   counter, and it marks the applied ledger only after the value was used
 *   (the pending entry stored, or the subtract call issued) — a refused or
 *   failed attempt leaves the ledger clean.
 */

import type { FocusSession } from "./focus.ts";
import {
  appliedKeyOf,
  awayMinutesOf,
  clampSubtraction,
  clipAwaySpan,
  isApplied,
  markApplied,
  savePendingSubtraction,
  type AwaySpan,
  type KeyValueStorage,
} from "./idle.ts";

/** The minutes a stop writes once a confirmed away is taken out. */
export function minutesToRecord(trackedMinutes: number, awayMinutes: number): number {
  return Math.max(0, trackedMinutes - Math.max(0, awayMinutes));
}

/* ---------------------------- the span books ----------------------- */

/** The session's closed, still-unanswered spans, plus one absence in progress. */
export type AwayBooks = { spans: AwaySpan[]; openFrom: number | null };

export function emptyBooks(): AwayBooks {
  return { spans: [], openFrom: null };
}

/** The user went idle at `fromMs`; an absence already open keeps its start. */
export function openAway(books: AwayBooks, fromMs: number): AwayBooks {
  return books.openFrom === null ? { ...books, openFrom: fromMs } : books;
}

/**
 * Closes the open absence at `endMs`, clipped to the session's focused time:
 * a session paused at `pausedAt` ends the span there, so paused time never
 * counts as away however late the pause is observed.
 */
export function closeAway(books: AwayBooks, session: FocusSession, endMs: number): AwayBooks {
  if (books.openFrom === null) return books;
  const clipped = clipAwaySpan({ from: books.openFrom, to: endMs }, session, endMs);
  return { spans: clipped === null ? books.spans : [...books.spans, clipped], openFrom: null };
}

/** Answered spans leave the books; an absence in progress stays open. */
function spendSpans(books: AwayBooks): AwayBooks {
  return { spans: [], openFrom: books.openFrom };
}

/** Keep / × / Escape: the spans are spent and nothing is written. */
export function keepAway(books: AwayBooks): AwayBooks {
  return spendSpans(books);
}

/* ---------------------------- confirm ------------------------------ */

/** What the confirm handler needs to know about the prompt. */
export type AwayPromptSnapshot = {
  key: string;
  sessionKey: string;
  taskId?: string;
  minutes: number;
  recorded: number | null;
};

export type ConfirmDeps = {
  storage: KeyValueStorage;
  /** Issues the task counter decrement; undefined when there is no signed-in
   * user to write for. May throw synchronously (invalid input). */
  write: ((taskId: string, minutes: number) => void) | undefined;
};

export type ConfirmResult = {
  /** The spans are spent whatever the outcome: a confirmed prompt never returns. */
  books: AwayBooks;
  /** `pending`: folded into the running session's stop write; `written`: the
   * subtraction was issued; `none`: nothing to subtract or already applied. */
  outcome: "pending" | "written" | "none";
  minutes: number;
};

/** Subtract, once. */
export function confirmAway(
  books: AwayBooks,
  prompt: AwayPromptSnapshot,
  taskActualMinutes: number,
  deps: ConfirmDeps,
): ConfirmResult {
  const spent = spendSpans(books);
  const minutes = clampSubtraction(prompt.minutes, prompt.recorded, taskActualMinutes);
  if (minutes < 1 || isApplied(prompt.key, deps.storage)) return { books: spent, outcome: "none", minutes: 0 };
  if (prompt.recorded === null) {
    // The session has not reported: its stop write consumes the entry.
    savePendingSubtraction(prompt.sessionKey, minutes, deps.storage);
    markApplied(prompt.key, deps.storage);
    return { books: spent, outcome: "pending", minutes };
  }
  if (deps.write === undefined || prompt.taskId === undefined) return { books: spent, outcome: "none", minutes: 0 };
  deps.write(prompt.taskId, minutes);
  markApplied(prompt.key, deps.storage);
  return { books: spent, outcome: "written", minutes };
}

export { appliedKeyOf, awayMinutesOf };
