/**
 * The chat hook (task C2): wires the pure conversation reducer to a
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

import { useCallback, useReducer, useRef } from "react";
import { DEFAULT_CHAT_MODEL } from "./config.ts";
import { emptyConversation, lastUserText, reduceConversation, type ConversationState } from "./conversation.ts";
import { createPacer, type StreamPacer } from "./pacer.ts";
import type { ChatEvent, ChatTransport } from "./types.ts";

export type ChatController = {
  state: ConversationState;
  send: (text: string) => void;
  stop: () => void;
  retry: () => void;
  newChat: () => void;
};

let requestCounter = 0;
const nextRequestId = () => `r${++requestCounter}`;

export function useChat(options: { transport: ChatTransport; buildSystemPrompt: () => string }): ChatController {
  const { transport, buildSystemPrompt } = options;
  const [state, dispatch] = useReducer(reduceConversation, emptyConversation);
  /** Mirrors `state` for building requests without stale closures. */
  const stateRef = useRef(state);
  stateRef.current = state;
  /** The request whose events and pacer are live; older ids are dropped. */
  const activeIdRef = useRef<string | null>(null);
  const pacerRef = useRef<StreamPacer | null>(null);

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
      const messages = [
        { role: "system" as const, content: buildSystemPrompt() },
        ...state.turns
          .filter(turn => turn.role !== "assistant" || turn.text !== "")
          .map(turn => ({ role: turn.role, content: turn.text })),
      ];
      void transport.stream({ id, model: DEFAULT_CHAT_MODEL, messages }, event => {
        if (activeIdRef.current !== id) return;
        if (event.type === "delta") {
          pacer.push(event.text);
          return;
        }
        // A terminal event must not overtake text still in the pacer.
        pacer.flush();
        dispatchEvent(event);
        if (activeIdRef.current === id) {
          activeIdRef.current = null;
          pacerRef.current = null;
        }
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
    dispatch({ type: "newChat" });
  }, [transport]);

  return { state, send, stop, retry, newChat };
}
