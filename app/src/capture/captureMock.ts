/**
 * The capture inbox's mock transport: lets the sheet be built,
 * screenshotted and browser-tested without Rust or an API key, driven by the
 * dev query `?captureMock=<scenario>` (`useCapture.ts` reads it).
 *
 * Scenarios: `ok` replies with up to two tasks drawn from the pasted lines;
 * `nokey` has no key (the on-device reading answers); `error` and `ratelimit`
 * stream the matching failure; `junk` replies with prose; `empty` replies
 * with no tasks; `hang` never answers until cancelled. It reads the request it
 * receives (the fenced paste and the date line), so the replies line up with
 * whatever the test pasted.
 */

import type { ChatEvent, ChatRequest, ChatTransport } from "../chat/types.ts";

export type CaptureMockScenario = "ok" | "nokey" | "error" | "ratelimit" | "junk" | "empty" | "hang";

const SCENARIOS: readonly CaptureMockScenario[] = ["ok", "nokey", "error", "ratelimit", "junk", "empty", "hang"];

/** The scenario a `?captureMock=` value names; null when the query is absent,
 * and `ok` for an empty or unknown value. */
export function captureMockScenario(query: string | null): CaptureMockScenario | null {
  if (query === null) return null;
  return SCENARIOS.find(scenario => scenario === query) ?? "ok";
}

export type MockCaptureTransport = ChatTransport & { __lastStreamRequest: ChatRequest | null };

export type CaptureMock = {
  transport: MockCaptureTransport;
  hasKey: () => Promise<boolean>;
};

const JUNK_REPLY = "Sorry, I could not turn that into tasks. Please try again.";

/** The pasted lines and today's date, read back from the request's user message. */
function readRequest(request: ChatRequest): { lines: string[]; today: string } {
  const user = request.messages.find(message => message.role === "user")?.content ?? "";
  const today = /^Today is (\d{4}-\d{2}-\d{2})/.exec(user)?.[1] ?? "2026-01-01";
  const begin = /^BEGIN-(\S+)$/m.exec(user);
  const token = begin?.[1];
  const start = begin === null || begin.index === undefined ? -1 : user.indexOf("\n", begin.index) + 1;
  const end = token === undefined ? -1 : user.indexOf(`\nEND-${token}`, start);
  const pasted = start > 0 && end >= start ? user.slice(start, end) : "";
  const lines = pasted
    .split("\n")
    .map(line => line.trim())
    .filter(line => line !== "");
  return { lines, today };
}

function okReply(request: ChatRequest): string {
  const { lines, today } = readRequest(request);
  const tasks = lines.slice(0, 2).map(line => ({
    title: line.slice(0, 120),
    dueDay: today,
    startTime: null,
    estimateMinutes: 45,
    quote: line.slice(0, 160),
  }));
  return JSON.stringify({ tasks });
}

export function createCaptureMock(scenario: CaptureMockScenario = "ok", options: { stepMs?: number } = {}): CaptureMock {
  const stepMs = options.stepMs ?? 120;
  const timers = new Map<string, ReturnType<typeof setTimeout>[]>();
  /** Live terminal hooks per request id, so `cancel` can end a pending run. */
  const cancellers = new Map<string, () => void>();

  const clearTimers = (id: string) => {
    for (const timer of timers.get(id) ?? []) clearTimeout(timer);
    timers.delete(id);
  };

  const transport: MockCaptureTransport = {
    __lastStreamRequest: null,

    stream(request, onEvent) {
      transport.__lastStreamRequest = request;
      const { id } = request;
      return new Promise<void>(resolve => {
        let open = true;
        const finish = (event: ChatEvent) => {
          if (!open) return;
          open = false;
          clearTimers(id);
          cancellers.delete(id);
          onEvent(event);
          resolve();
        };
        cancellers.set(id, () => finish({ type: "cancelled" }));
        const at = (delay: number, run: () => void) => {
          const timer = setTimeout(() => {
            if (open) run();
          }, delay);
          timers.set(id, [...(timers.get(id) ?? []), timer]);
        };

        at(stepMs, () => onEvent({ type: "reasoning" }));
        if (scenario === "hang") return;
        if (scenario === "error") {
          at(stepMs * 2, () => finish({ type: "error", code: "provider", message: "The provider returned an error." }));
          return;
        }
        if (scenario === "ratelimit") {
          at(stepMs * 2, () => finish({ type: "error", code: "rate_limited", message: "Too many requests." }));
          return;
        }
        const body = scenario === "junk" ? JUNK_REPLY : scenario === "empty" ? '{"tasks":[]}' : okReply(request);
        const size = Math.max(1, Math.ceil(body.length / 4));
        let cursor = 0;
        let clock = stepMs * 2;
        while (cursor < body.length) {
          const text = body.slice(cursor, cursor + size);
          at(clock, () => onEvent({ type: "delta", text }));
          cursor += size;
          clock += stepMs;
        }
        at(clock, () => finish({ type: "done" }));
      });
    },

    async cancel(id) {
      cancellers.get(id)?.();
    },

    async complete() {
      throw new Error("The capture mock only streams.");
    },
  };

  return { transport, hasKey: async () => scenario !== "nokey" };
}
