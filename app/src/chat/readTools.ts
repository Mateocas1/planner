/**
 * Where the chat's read tools actually run (ronda4 T4, S4). Reads execute the
 * moment the model proposes them — no confirmation card, no user click — so
 * their executor lives with the chat surface's live data, not with the
 * panel's confirm flow.
 *
 * The executor is installed through this tiny registry instead of a
 * `ChatPanel` prop because `ChatPanel.tsx` is owned by a parallel worker
 * (r4-chatmotion) and its `useChat` call site must not gain options in this
 * task. The hook takes an `executeReadTool` option first and falls back to
 * the registry; integration can move the executor to a prop and drop this
 * module without changing behavior.
 */

import type { ChatToolCall } from "./types.ts";

/** What one read produced: a short user-facing `summary` (the card's outcome
 * line) and the model-facing `result` (the data lines that ride the `tool`
 * message). A failed read (bad arguments, no session) returns `error`. */
export type ChatReadOutcome = { ok: true; summary: string; result: string } | { ok: false; error: string };

export type ChatReadExecutor = (call: ChatToolCall) => Promise<ChatReadOutcome>;

let executor: ChatReadExecutor | null = null;

/** Installs (or clears, with null) the live read executor. Called by the
 * chat surface on mount; one executor at a time, like the one chat surface
 * an app mounts. */
export function setChatReadExecutor(next: ChatReadExecutor | null): void {
  executor = next;
}

export function getChatReadExecutor(): ChatReadExecutor | null {
  return executor;
}
