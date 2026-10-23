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

import { MAX_TOOL_CALLS_PER_ANSWER } from "./tools.ts";
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

/**
 * Appends one stream piece (text delta or a tool call) to the trailing
 * assistant turn, opening the turn when the stream has not created one yet —
 * text and tool calls both open it.
 */
function appendAssistantTurn(state: ConversationState, apply: (turn: ChatTurn & { role: "assistant" }) => ChatTurn): ConversationState {
  const turns = state.turns.slice();
  const last = turns[turns.length - 1];
  if (last !== undefined && last.role === "assistant") {
    turns[turns.length - 1] = apply(last);
    return { ...state, turns };
  }
  const turn: ChatTurn & { role: "assistant" } = { id: `a${state.requestId ?? ""}`, role: "assistant", text: "", segments: [] };
  turns.push(apply(turn));
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
      if (event.type === "tool_call") {
        // A tool call renders as an action card inside the answer (spec S1):
        // it opens the assistant turn like a delta does, and the card stays
        // pending until the user acts — resolving one never re-opens a stream.
        const fresh = state.phase !== "streaming";
        const base = fresh ? { ...state, phase: "streaming" as const } : state;
        return appendAssistantTurn(base, turn => {
          const toolCalls = turn.toolCalls ?? [];
          if (toolCalls.length >= MAX_TOOL_CALLS_PER_ANSWER) {
            // Extras are dropped with a note (spec S1); the card never renders.
            return { ...turn, callsDropped: (turn.callsDropped ?? 0) + 1 };
          }
          const call = event.call;
          return {
            ...turn,
            toolCalls: [...toolCalls, { callId: call.id, name: call.name, arguments: call.arguments, status: "pending" as const }],
          };
        });
      }
      if (event.type === "delta") {
        // The first piece morphs the waiting bubble into the answer bubble.
        const fresh = state.phase !== "streaming";
        const base = fresh ? { ...state, phase: "streaming" as const } : state;
        return appendAssistantTurn(base, turn => ({
          ...turn,
          text: turn.text + event.text,
          segments: [...turn.segments, event.text],
        }));
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
    case "toolCallResolved": {
      // The user acted on one card. Unknown ids (a turn already cleared by
      // New chat) change nothing; a matching card updates in place.
      const known = state.turns.some(
        turn => turn.role === "assistant" && turn.toolCalls?.some(card => card.callId === action.callId) === true,
      );
      if (!known) return state;
      return {
        ...state,
        turns: state.turns.map(turn => {
          if (turn.role !== "assistant" || turn.toolCalls === undefined) return turn;
          if (!turn.toolCalls.some(card => card.callId === action.callId)) return turn;
          return {
            ...turn,
            toolCalls: turn.toolCalls.map(card =>
              card.callId === action.callId
                ? { ...card, status: action.status, ...(action.outcome === undefined ? {} : { outcome: action.outcome }) }
                : card,
            ),
          };
        }),
      };
    }
  }
}
