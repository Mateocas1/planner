/**
 * The capture inbox's run state machine (Ronda 8, S3, plan §3 and §5).
 *
 * Pure of the DOM, React and Firebase: `reduceCapture` is the state, and
 * `createCaptureController` is the only part with effects (a transport, a key
 * lookup, a timeout), all injected so node tests drive it with fakes and the
 * hook in `useCapture.ts` stays a thin wrapper.
 *
 * One run goes `idle → reading → proposals`. The machine NEVER creates a task:
 * it ends in `proposals`, and the sheet decides what to write. The assistant is
 * tried first (`stream()` over the chat transport, no tools, only the pasted
 * text and the date, via `buildCapturePrompt`; `complete()` has a 5 s read
 * timeout that would kill a reasoning model's first byte). Whenever the
 * assistant cannot answer, the on-device reader answers instead and the state
 * says why (`reason`), so the sheet can explain it: no key, web build, offline,
 * rejected key, rate limit, locked keyring, network or provider error,
 * timeout, or an unparseable reply. A model that finds nothing is a real
 * answer (`source: "assistant"`, no tasks), not a fallback.
 *
 * The pasted text and the model's reply are never logged: nothing here touches
 * `console`.
 */

import type { ChatErrorCode, ChatEvent, ChatTransport } from "../chat/types.ts";
import { readOnDevice } from "./heuristic.ts";
import { buildCapturePrompt } from "./prompt.ts";
import { parseCaptureReply, type CaptureProposal } from "./schema.ts";

/** Why the on-device reading answered instead of the assistant. */
export type CaptureFallbackReason =
  | "web" // no transport: the browser build
  | "offline" // the call was skipped
  | "no_key" // no API key stored
  | "unauthorized" // the provider rejected the key
  | "rate_limited"
  | "credential_store_unavailable" // OS keyring missing or locked
  | "network"
  | "provider" // any other provider failure or malformed stream
  | "timeout" // no answer within `timeoutMs`
  | "unparseable"; // the reply held no usable task

export type CaptureState =
  | { phase: "idle" }
  | { phase: "reading"; requestId: string }
  | {
      phase: "proposals";
      requestId: string;
      /** Who read the text. */
      source: "assistant" | "device";
      /** Why the device answered; null when the assistant did. */
      reason: CaptureFallbackReason | null;
      /** At most 8 validated proposals; empty means nothing task-like. */
      tasks: CaptureProposal[];
      /** The paste was longer than the cap and was cut before reading. */
      truncated: boolean;
      /** More valid items arrived than the sheet shows. */
      capped: boolean;
      /** Items of the assistant's reply that failed validation. */
      dropped: number;
    };

export const idleCapture: CaptureState = { phase: "idle" };

export type CaptureResult = Omit<Extract<CaptureState, { phase: "proposals" }>, "phase">;

export type CaptureAction =
  | { type: "begin"; requestId: string }
  | ({ type: "result" } & CaptureResult)
  | { type: "reset" };

export function reduceCapture(state: CaptureState, action: CaptureAction): CaptureState {
  switch (action.type) {
    case "begin":
      return { phase: "reading", requestId: action.requestId };
    case "result": {
      // Second line of defence: the controller already drops late events.
      if (state.phase !== "reading" || state.requestId !== action.requestId) return state;
      const { type: _type, ...result } = action;
      return { phase: "proposals", ...result };
    }
    case "reset":
      return state.phase === "idle" ? state : idleCapture;
  }
}

/** The fallback reason for a chat error code. */
export function reasonForError(code: ChatErrorCode | string | undefined): CaptureFallbackReason {
  switch (code) {
    case "no_key":
    case "unauthorized":
    case "rate_limited":
    case "credential_store_unavailable":
    case "network":
      return code;
    default:
      return "provider";
  }
}

export type CaptureDeps = {
  /** The chat transport, or null where none exists (the web build). */
  transport: ChatTransport | null;
  /** Whether an API key is stored. A throw is not a "no": the stream is tried
   * and reports the real error. */
  hasKey: () => Promise<boolean>;
  isOnline: () => boolean;
  now: () => Date;
  /** The profile zone: "today" is the planner's day. */
  timeZone: () => string;
  model: () => string;
  /** How long the assistant may take before the device answers. */
  timeoutMs: number;
  /** Test seams; default to the globals. */
  setTimeout?: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout> | undefined) => void;
};

export const CAPTURE_TIMEOUT_MS = 90_000;

export type CaptureController = {
  getState: () => CaptureState;
  subscribe: (listener: () => void) => () => void;
  /** Reads a paste. A run in flight is cancelled and superseded. */
  start: (text: string) => void;
  /** Stops the run in flight and returns to idle; the text is the sheet's. */
  cancel: () => void;
  /** Back to idle from any state, cancelling a run in flight. */
  reset: () => void;
};

let requestCounter = 0;
const nextRequestId = () => `capture-${++requestCounter}`;

export function createCaptureController(deps: CaptureDeps): CaptureController {
  const setTimer = deps.setTimeout ?? ((run, ms) => globalThis.setTimeout(run, ms));
  const clearTimer = deps.clearTimeout ?? (handle => globalThis.clearTimeout(handle));
  let state: CaptureState = idleCapture;
  const listeners = new Set<() => void>();
  /** The one run whose events count; any other id is superseded. */
  let active: { id: string; streaming: boolean; timer: ReturnType<typeof setTimeout> | undefined } | null = null;

  const dispatch = (action: CaptureAction) => {
    const next = reduceCapture(state, action);
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  /** Ends the active run's bookkeeping; the transport is told when it streams. */
  const retire = (cancelStream: boolean) => {
    const run = active;
    if (run === null) return;
    active = null;
    if (run.timer !== undefined) clearTimer(run.timer);
    if (cancelStream && run.streaming && deps.transport !== null) void deps.transport.cancel(run.id).catch(() => undefined);
  };

  const start = (raw: string) => {
    if (raw.trim() === "") return;
    retire(true);
    const id = nextRequestId();
    const run: NonNullable<typeof active> = { id, streaming: false, timer: undefined };
    active = run;
    dispatch({ type: "begin", requestId: id });
    const isCurrent = () => active === run;

    const now = deps.now();
    const timeZone = deps.timeZone();
    const prompt = buildCapturePrompt({ text: raw, now, timeZone });

    const finishWithDevice = (reason: CaptureFallbackReason) => {
      if (!isCurrent()) return;
      const reading = readOnDevice(raw, { now, timeZone });
      retire(false);
      dispatch({ type: "result", requestId: id, source: "device", reason, tasks: reading.tasks, truncated: reading.truncated, capped: reading.capped, dropped: 0 });
    };

    const finishWithReply = (reply: string) => {
      if (!isCurrent()) return;
      const parsed = parseCaptureReply(reply, { text: prompt.text, todayKey: prompt.todayKey });
      if (parsed.status === "unparseable") {
        finishWithDevice("unparseable");
        return;
      }
      retire(false);
      dispatch({ type: "result", requestId: id, source: "assistant", reason: null, tasks: parsed.tasks, truncated: prompt.truncated, capped: parsed.capped, dropped: parsed.dropped });
    };

    const transport = deps.transport;
    if (transport === null) return finishWithDevice("web");
    if (!deps.isOnline()) return finishWithDevice("offline");

    void (async () => {
      let keyed = true;
      try {
        keyed = await deps.hasKey();
      } catch {
        keyed = true;
      }
      if (!isCurrent()) return;
      if (!keyed) return finishWithDevice("no_key");

      let reply = "";
      run.streaming = true;
      run.timer = setTimer(() => {
        if (!isCurrent()) return;
        run.timer = undefined;
        // Cancel first, then answer: the `cancelled` event that follows
        // belongs to a retired run and is dropped.
        void transport.cancel(id).catch(() => undefined);
        run.streaming = false;
        finishWithDevice("timeout");
      }, deps.timeoutMs);

      const onEvent = (event: ChatEvent) => {
        if (!isCurrent()) return;
        switch (event.type) {
          case "delta":
            reply += event.text;
            return;
          case "done":
            return finishWithReply(reply);
          case "error":
            return finishWithDevice(reasonForError(event.code));
          case "cancelled":
            // Nobody cancels a live run except this controller, which retires
            // it first; an outside cancel is a provider-side abort.
            return finishWithDevice("provider");
          default:
            // `reasoning` only signals thinking; `tool_call` cannot happen
            // (no tools are passed) and would be inert anyway.
            return;
        }
      };

      try {
        await transport.stream({ id, model: deps.model(), messages: prompt.messages }, onEvent);
      } catch (error) {
        const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
        finishWithDevice(reasonForError(typeof code === "string" ? code : undefined));
        return;
      }
      // The contract resolves after the terminal event; resolving without one
      // is a malformed stream.
      finishWithDevice("provider");
    })();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start,
    cancel() {
      if (state.phase !== "reading") return;
      retire(true);
      dispatch({ type: "reset" });
    },
    reset() {
      retire(true);
      dispatch({ type: "reset" });
    },
  };
}
