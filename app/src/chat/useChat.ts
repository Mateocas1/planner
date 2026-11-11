/**
 * The chat hook: wires the pure conversation reducer to a
 * `ChatTransport` and the stream pacer. This is the only place with side
 * effects — the reducer stays testable, the pacer stays injectable.
 *
 * Event flow: transport events for the *active* request id are dispatched to
 * the reducer, except `delta`, which goes through the pacer so the answer
 * reveals steadily; `done`/`cancelled`/`error` flush the pacer first so no
 * text is lost behind the terminal event. Events from a superseded request
 * (a new send, a stop, New chat) are dropped here — the reducer's
 * `requestId` guard is the second line of defence.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";
import { DEFAULT_CHAT_MODEL } from "./config.ts";
import { createAnswerCallGate, emptyConversation, hasExchange, lastUserText, reduceConversation, type ChatTurn, type ConversationState, type ToolCallStatus } from "./conversation.ts";
import { createPacer, type StreamPacer } from "./pacer.ts";
import { getChatReadExecutor, type ChatReadExecutor } from "./readTools.ts";
import { CHAT_TOOLS, isReadTool, toolResultContent } from "./tools.ts";
import type { ChatEvent, ChatMessage, ChatToolCall, ChatTransport } from "./types.ts";

export type ChatController = {
  state: ConversationState;
  send: (text: string) => void;
  stop: () => void;
  retry: () => void;
  newChat: () => void;
  /** Resolves one action card (the user confirmed, discarded, or the write
   * failed). Resolving never triggers a new model call. `result`
   * is the model-facing detail (ids, fields) that rides the `tool` message. */
  resolveToolCall: (callId: string, status: Exclude<ToolCallStatus, "pending">, outcome?: string, result?: string) => void;
};

let requestCounter = 0;
const nextRequestId = () => `r${++requestCounter}`;

/** How long a closed panel waits for activity before the conversation "ends"
 * and extraction may run. */
export const IDLE_EXTRACT_MS = 10 * 60 * 1000;

/**
 * The conversation as the OpenAI protocol needs it: every assistant turn that
 * proposed tool calls carries its `tool_calls`, and each proposed call is
 * answered by one `tool` message — pending, confirmed, failed or discarded —
 * so the next request stays valid even when the user sends a new message with
 * cards still open.
 */
export function buildMessages(systemPrompt: string, turns: ChatTurn[]): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
  for (const turn of turns) {
    if (turn.role === "user") {
      messages.push({ role: "user", content: turn.text });
      continue;
    }
    const hasCalls = turn.toolCalls !== undefined && turn.toolCalls.length > 0;
    if (turn.text === "" && !hasCalls) continue;
    const calls = turn.toolCalls ?? [];
    messages.push({
      role: "assistant",
      content: turn.text,
      ...(calls.length > 0 ? { toolCalls: calls.map(card => ({ id: card.callId, name: card.name, arguments: card.arguments })) } : {}),
    });
    for (const card of calls) {
      messages.push({ role: "tool", toolCallId: card.callId, content: toolResultContent(card) });
    }
  }
  return messages;
}

export function useChat(options: {
  transport: ChatTransport;
  buildSystemPrompt: () => string;
  /** The panel's open state: a close with ≥1 exchange starts the idle timer
   * whose expiry ends the conversation; a reopen cancels it and re-arms
   * extraction so the continued conversation can end again later. */
  panelOpen?: boolean;
  /** Called once per conversation end (New chat, the idle timer, unload)
   * with the transcript turns, before anything is cleared. */
  onConversationEnd?: (turns: ChatTurn[]) => void;
  idleExtractMs?: number;
  /** Runs a read tool call the model proposed (reads need no
   * confirmation). Takes precedence over the executor installed in the
   * `readTools` registry. */
  executeReadTool?: ChatReadExecutor;
}): ChatController {
  const { transport, buildSystemPrompt, panelOpen, onConversationEnd, idleExtractMs = IDLE_EXTRACT_MS } = options;
  const [state, dispatch] = useReducer(reduceConversation, emptyConversation);
  /** Mirrors `state` for building requests without stale closures. */
  const stateRef = useRef(state);
  stateRef.current = state;
  /** The request whose events and pacer are live; older ids are dropped. */
  const activeIdRef = useRef<string | null>(null);
  const pacerRef = useRef<StreamPacer | null>(null);
  /** Whether extraction already ran for the current conversation:
   * one extraction per end, never a duplicate batch for the same turns. */
  const extractedRef = useRef(false);

  // The conversation-end callback lives in a ref so the effects below never
  // need to re-arm because App re-created the closure.
  const onEndRef = useRef(onConversationEnd);
  onEndRef.current = onConversationEnd;

  /** Mirrors the read executor option so `startStream` never needs to depend
   * on it; the registry is the fallback (see readTools.ts). */
  const readExecutorRef = useRef<ChatReadExecutor | undefined>(options.executeReadTool);
  readExecutorRef.current = options.executeReadTool;

  /** Runs a proposed read at once and resolves its card with what came back:
   * no buttons, no user click. Resolution is a `toolCallResolved`
   * dispatch, so it applies even after the stream ended, and the reducer's
   * known-id guard drops it if the turn is already gone. */
  const runReadTool = useCallback((call: ChatToolCall) => {
    void (async () => {
      try {
        const execute = readExecutorRef.current ?? getChatReadExecutor();
        const outcome = execute === null
          ? ({ ok: false, error: "The assistant cannot read the planner right now." } as const)
          : await execute(call);
        if (outcome.ok) {
          dispatch({ type: "toolCallResolved", callId: call.id, status: "read", outcome: outcome.summary, result: outcome.result });
        } else {
          dispatch({ type: "toolCallResolved", callId: call.id, status: "failed", outcome: outcome.error });
        }
      } catch (error) {
        dispatch({
          type: "toolCallResolved",
          callId: call.id,
          status: "failed",
          outcome: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, []);

  /** Fires the end-of-conversation hook at most once per conversation, and
   * only when there is a real exchange to extract memories from. */
  const fireConversationEnd = useCallback(() => {
    if (extractedRef.current) return;
    const turns = stateRef.current.turns;
    if (!hasExchange(turns)) return;
    extractedRef.current = true;
    onEndRef.current?.(turns);
  }, []);

  // End on panel close + idle: closing with ≥1 exchange starts the
  // timer; the expiry ends the conversation. Reopening cancels the timer and
  // re-arms extraction, so a conversation continued after an idle extraction
  // can still end again with its new turns.

  const dispatchEvent = useCallback((event: ChatEvent) => {
    dispatch({ type: "event", event });
  }, []);

  const startStream = useCallback(
    (id: string, state: ConversationState) => {
      const pacer = createPacer({
        emit: text => dispatchEvent({ type: "delta", text }),
        now: () => performance.now(),
        schedule: callback => {
          const handle = requestAnimationFrame(() => callback());
          return () => cancelAnimationFrame(handle);
        },
      });
      pacerRef.current = pacer;
      activeIdRef.current = id;
      // The per-answer gate mirrors the reducer's cap/duplicate decisions for
      // this answer, so a read the reducer will drop never executes (finding
      // 5): the reducer may not have processed the earlier events yet.
      const answerCallGate = createAnswerCallGate();
      void transport.stream(
        { id, model: DEFAULT_CHAT_MODEL, messages: buildMessages(buildSystemPrompt(), state.turns), tools: CHAT_TOOLS },
        event => {
        if (activeIdRef.current !== id) return;
        if (event.type === "delta") {
          pacer.push(event.text);
          return;
        }
        if (event.type === "tool_call") {
          const proposed = answerCallGate(event.call.id);
          dispatchEvent(event);
          // Reads run at once — but only when the call actually renders
          // a card; writes wait for the user on their card.
          if (proposed && isReadTool(event.call.name)) runReadTool(event.call);
          return;
        }
        if (event.type === "done" || event.type === "cancelled" || event.type === "error") {
          // A terminal event must not overtake text still in the pacer; the
          // request is over, so late events for it are dropped above.
          pacer.flush();
          activeIdRef.current = null;
          pacerRef.current = null;
        }
        dispatchEvent(event);
      });
    },
    [buildSystemPrompt, dispatchEvent, transport],
  );

  const send = useCallback(
    (text: string) => {
      if (text.trim() === "" || stateRef.current.requestId !== null) return;
      const id = nextRequestId();
      dispatch({ type: "send", id, text });
      startStream(id, { ...stateRef.current, turns: [...stateRef.current.turns, { id: `u${id}`, role: "user", text: text.trim() }], phase: "pending", requestId: id, error: null });
    },
    [startStream],
  );

  const retry = useCallback(() => {
    const current = stateRef.current;
    const text = lastUserText(current);
    if (text === null || current.requestId !== null) return;
    const id = nextRequestId();
    dispatch({ type: "retry", id });
    startStream(id, { ...current, turns: [...current.turns, { id: `u${id}`, role: "user" as const, text }], phase: "pending", requestId: id, error: null });
  }, [startStream]);

  const stop = useCallback(() => {
    const id = activeIdRef.current;
    if (id === null) return;
    pacerRef.current?.flush();
    activeIdRef.current = null;
    pacerRef.current = null;
    dispatch({ type: "stop" });
    void transport.cancel(id);
  }, [transport]);

  const newChat = useCallback(() => {
    const id = activeIdRef.current;
    if (id !== null) {
      pacerRef.current?.flush();
      activeIdRef.current = null;
      pacerRef.current = null;
      void transport.cancel(id);
    }
    // "New chat" is a conversation end: extraction sees the turns before the
    // reset, and the next conversation starts unextracted.
    fireConversationEnd();
    extractedRef.current = false;
    dispatch({ type: "newChat" });
  }, [transport, fireConversationEnd]);

  const resolveToolCall = useCallback(
    (callId: string, status: Exclude<ToolCallStatus, "pending">, outcome?: string, result?: string) => {
      dispatch({ type: "toolCallResolved", callId, status, outcome, result });
    },
    [],
  );

  // The close/reopen transition drives the idle timer.
  const panelOpenRef = useRef(panelOpen);
  useEffect(() => {
    if (panelOpen === panelOpenRef.current) return undefined;
    const wasOpen = panelOpenRef.current;
    panelOpenRef.current = panelOpen;
    if (panelOpen || wasOpen !== true) return undefined;
    if (extractedRef.current || !hasExchange(stateRef.current.turns)) return undefined;
    const timer = window.setTimeout(fireConversationEnd, idleExtractMs);
    return () => window.clearTimeout(timer);
  }, [panelOpen, idleExtractMs, fireConversationEnd]);

  // Reopening after an idle extraction re-arms for the continued conversation.
  useEffect(() => {
    if (panelOpen === true && extractedRef.current) extractedRef.current = false;
  }, [panelOpen]);

  // Best-effort: an app quit with a live conversation extracts what it can.
  // The call is async and will usually not finish — it is a cheap effort, not
  // a guarantee.
  useEffect(() => {
    const onUnload = () => fireConversationEnd();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [fireConversationEnd]);

  return { state, send, stop, retry, newChat, resolveToolCall };
}
