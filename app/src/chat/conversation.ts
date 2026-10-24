/**
 * The conversation controller (task C2): a pure reducer over the whole chat
 * panel state, unit-tested without React or a DOM. The `useChat` hook feeds it
 * transport events and performs the side effects the reducer only describes
 * (calling `transport.stream` / `transport.cancel`).
 *
 * Turn shape notes:
 * - An assistant turn keeps both the joined `text` and the `segments` the
 *   stream pacer emitted, one entry per reveal chunk, so the UI can animate
 *   the newly revealed words without re-parsing where they start.
 * - An error is panel state, not a turn: it renders inline under the thread
 *   with a Retry, and any partial answer above it stays.
 */

import type { ChatEvent, ChatErrorCode } from "./types.ts";

export type ChatTurn =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; text: string; segments: string[] };

export type ConversationPhase =
  /** Nothing in flight. */
  | "idle"
  /** A request was sent; no event has come back yet. */
  | "pending"
  /** The model signalled `reasoning`; its text is not shown. */
  | "reasoning"
  /** Answer text is arriving. */
  | "streaming";

export type ConversationState = {
  turns: ChatTurn[];
  phase: ConversationPhase;
  /** The in-flight request id, or null. Events for other ids are ignored. */
  requestId: string | null;
  error: { code: ChatErrorCode; message: string } | null;
};

export type ConversationAction =
  | { type: "send"; id: string; text: string }
  | { type: "event"; event: ChatEvent }
  | { type: "stop" }
  | { type: "retry"; id: string }
  | { type: "newChat" };

export const emptyConversation: ConversationState = { turns: [], phase: "idle", requestId: null, error: null };

/**
 * The text a Retry would send again: the last user turn, or null. */
export function lastUserText(state: ConversationState): string | null {
  for (let index = state.turns.length - 1; index >= 0; index--) {
    const turn = state.turns[index];
    if (turn.role === "user") return turn.text;
  }
  return null;
}

/**
 * Whether the conversation holds at least one real exchange: a user message
 * *and* a non-empty answer. An empty assistant turn (an error, a stop before
 * any text) is not an exchange — there is nothing to extract memories from.
 * End-of-conversation extraction (spec S5) only runs on a real exchange.
 */
export function hasExchange(turns: ChatTurn[]): boolean {
  return turns.some(turn => turn.role === "user") && turns.some(turn => turn.role === "assistant" && turn.text !== "");
}

/** Append text to the trailing assistant turn, keeping text and segments in step. */
function appendAssistantText(state: ConversationState, delta: string): ConversationState {
  const turns = state.turns.slice();
  const last = turns[turns.length - 1];
  if (last === undefined || last.role !== "assistant") return state;
  turns[turns.length - 1] = { ...last, text: last.text + delta, segments: [...last.segments, delta] };
  return { ...state, turns };
}

export function reduceConversation(state: ConversationState, action: ConversationAction): ConversationState {
  switch (action.type) {
    case "send": {
      const text = action.text.trim();
      if (text === "" || state.requestId !== null) return state;
      return {
        turns: [...state.turns, { id: `u${action.id}`, role: "user", text }],
        phase: "pending",
        requestId: action.id,
        error: null,
      };
    }
    case "event": {
      // Only the in-flight request's events apply: after a stop or an error the
      // transport may still flush a late delta, and it must not reopen the
      // thread or grow a turn the panel believes is finished.
      if (state.requestId === null) return state;
      const event = action.event;
      if (event.type === "reasoning") return { ...state, phase: "reasoning" };
      if (event.type === "delta") {
        // The first text morphs the waiting bubble into the answer bubble.
        const fresh = state.phase !== "streaming";
        const base = fresh
          ? { ...state, phase: "streaming" as const, turns: [...state.turns, { id: `a${state.requestId}`, role: "assistant" as const, text: "", segments: [] as string[] }] }
          : state;
        return appendAssistantText(base, event.text);
      }
      if (event.type === "done") return { ...state, phase: "idle", requestId: null };
      if (event.type === "cancelled") return { ...state, phase: "idle", requestId: null };
      if (event.type === "error") return { ...state, phase: "idle", requestId: null, error: { code: event.code, message: event.message } };
      return state;
    }
    case "stop": {
      // The hook has called `transport.cancel`; the panel goes idle at once so
      // the stop button hands back to send without waiting for the transport
      // to confirm, and a late `cancelled` event lands as a no-op above.
      if (state.requestId === null) return state;
      return { ...state, phase: "idle", requestId: null };
    }
    case "retry": {
      // Retry resends the last user turn under a fresh request id; the error
      // line and any partial answer it follows stay above until the reply
      // replaces the wait.
      const text = lastUserText(state);
      if (text === null || state.requestId !== null) return state;
      return {
        turns: [...state.turns, { id: `u${action.id}`, role: "user", text }],
        phase: "pending",
        requestId: action.id,
        error: null,
      };
    }
    case "newChat":
      return emptyConversation;
  }
}
