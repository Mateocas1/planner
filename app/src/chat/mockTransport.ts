/**
 * The mock transport (task C2): lets the panel be built, screenshotted and
 * browser-tested without Rust or an API key. Streams a canned Markdown answer
 * with realistic timing — a short connect, ~1.2 s of `reasoning`, then bursty
 * `delta` chunks (1–30 characters, 20–250 ms apart) — so the stream pacer has
 * real bursts to smooth. `?chatMock=error` streams the failure path instead.
 */

import { browserTimeZone } from "../data/profile.ts";
import { dateKey } from "../ui/time.ts";
import type { ChatEvent, ChatRequest, ChatTransport } from "./types.ts";

/**
 * What the mock's extraction (`complete`) replies with (spec S5): strict JSON
 * ops the panel applies to the in-memory backend, so a second conversation's
 * system prompt carries the note. The browser test reads the recorded
 * requests through `globalThis.__chatMockTransport`.
 */
export const CANNED_EXTRACTION = JSON.stringify({
  ops: [{ op: "upsert", topicKey: "planning-style", title: "Prefers short answers", content: "The user prefers short, concrete answers with times in their own timezone." }],
});

/** The mock transport plus the request recording the browser tests read. */
export type MockChatTransport = ChatTransport & {
  __lastStreamRequest: ChatRequest | null;
  __lastCompleteRequest: ChatRequest | null;
};

const CANNED_ANSWER = `Here's where your day stands.

You have **two blocks** left, and the *Deep Work* session on the chat panel is next. The shutdown ritual opens at **18:30**.

- 14:00–15:30 · Deep Work — chat panel
- 16:00–16:45 · Review the inbox

If you want to plan tomorrow, just ask with \`plan tomorrow\` — details in [the planner guide](https://example.com/planner-guide).`;

export type MockScenario = "answer" | "error" | "tools" | "agent-read" | "agent-edit" | "agent-delete" | "agent-holiday" | "agent-memory";

export function createMockTransport(scenario: MockScenario = "answer"): MockChatTransport {
  /** Pending timers per request id, so `cancel` stops the whole chain. */
  const timers = new Map<string, ReturnType<typeof setTimeout>[]>();
  /** The live `onEvent` per request id, so cancel can emit the terminal event. */
  const listeners = new Map<string, (event: ChatEvent) => void>();

  const clearTimers = (id: string) => {
    for (const timer of timers.get(id) ?? []) clearTimeout(timer);
    timers.delete(id);
  };

  const schedule = (id: string, delayMs: number, run: () => void) => {
    const timer = setTimeout(() => {
      const pending = timers.get(id);
      if (pending === undefined) return; // cancelled while queued
      timers.set(id, pending.filter(t => t !== timer));
      run();
    }, delayMs);
    const pending = timers.get(id) ?? [];
    pending.push(timer);
    timers.set(id, pending);
  };

  const chunkPlan = (text: string): Array<{ text: string; gapMs: number }> => {
    const chunks: Array<{ text: string; gapMs: number }> = [];
    let cursor = 0;
    while (cursor < text.length) {
      const size = 1 + Math.floor(Math.random() * 30);
      chunks.push({ text: text.slice(cursor, cursor + size), gapMs: 20 + Math.floor(Math.random() * 230) });
      cursor += size;
    }
    return chunks;
  };

  const transport: MockChatTransport = {
    __lastStreamRequest: null,
    __lastCompleteRequest: null,

    stream(request, onEvent) {
      transport.__lastStreamRequest = request;
      exposeMock(transport);
      const { id } = request;
      listeners.set(id, onEvent);
      return new Promise<void>(resolve => {
        const emit = (event: ChatEvent) => {
          if (listeners.get(id) !== onEvent) return;
          onEvent(event);
        };
        let clock = 90; // a short connect before the first event
        schedule(id, clock, () => emit({ type: "reasoning" }));
        clock += 500;
        schedule(id, clock, () => emit({ type: "reasoning" }));
        if (scenario === "error") {
          clock += 450;
          schedule(id, clock, () => {
            clearTimers(id);
            emit({ type: "error", code: "network", message: "The planner could not reach the model service. Check your connection and try again." });
            listeners.delete(id);
            resolve();
          });
          return;
        }
        clock += 700; // ≈1.2 s of reasoning before the first word
        if (scenario.startsWith("agent-")) {
          // ronda4 agentic flow. `agent-read` proposes one read (it runs
          // without confirmation); `agent-edit` proposes a create at a time
          // first and, once that card is confirmed, uses the created task's
          // id from the tool result to move it — the exact behavior the S4
          // diagnosis found missing.
          for (const chunk of chunkPlan("On it.")) {
            clock += chunk.gapMs;
            const text = chunk.text;
            schedule(id, clock, () => emit({ type: "delta", text }));
          }
          const today = dateKey(new Date(), browserTimeZone);
          let call: { id: string; name: string; args: string };
          if (scenario === "agent-read") {
            call = { id: "call_read", name: "list_tasks", args: JSON.stringify({ includeCompleted: true }) };
          } else if (scenario === "agent-memory") {
            // First call saves a note; once its card is confirmed, the
            // follow-up call forgets it by the topic key from the tool
            // result — the model-side counterpart of the memory tools.
            const remembered = request.messages.map(message => message.content).find(content => content.includes("(topic ")) ?? "";
            const topicKey = /\(topic ([\w-]+)\)/.exec(remembered)?.[1];
            call = topicKey === undefined
              ? { id: "call_remember", name: "remember", args: JSON.stringify({ title: "Prefers morning planning", content: "The user plans their day before 09:00." }) }
              : { id: "call_forget", name: "forget", args: JSON.stringify({ topicKey }) };
          } else if (scenario === "agent-delete" || scenario === "agent-holiday") {
            // The id comes from the planner context, exactly like the real
            // model's: the seeded row must already be visible to the request.
            const system = request.messages[0]?.content ?? "";
            const pattern = scenario === "agent-delete" ? /\[([\w-]+)\] Delete me/ : /\[([\w-]+)\] [^\n]*Independence/;
            const foundId = pattern.exec(system)?.[1];
            call = foundId === undefined
              ? { id: "call_none", name: "list_tasks", args: "{}" }
              : scenario === "agent-delete"
                ? { id: "call_delete", name: "delete_task", args: JSON.stringify({ taskId: foundId }) }
                : { id: "call_hide", name: "hide_holiday", args: JSON.stringify({ holidayId: foundId }) };
          } else {
            const createResult = request.messages.map(message => message.content).find(content => content.includes("Created task id=")) ?? "";
            const createdId = /id=([\w-]+)/.exec(createResult)?.[1];
            call = createdId === undefined
              ? { id: "call_create", name: "create_task", args: JSON.stringify({ title: "Water the plants", day: today, startTime: "14:00", estimateMinutes: 30 }) }
              : { id: "call_move", name: "move_task", args: JSON.stringify({ taskId: createdId, day: today, startTime: "16:00" }) };
          }
          clock += 250;
          schedule(id, clock, () => emit({ type: "tool_call", call: { id: call.id, name: call.name, arguments: call.args } }));
          clock += 120;
          schedule(id, clock, () => {
            clearTimers(id);
            emit({ type: "done" });
            listeners.delete(id);
            resolve();
          });
          return;
        }
        if (scenario === "tools") {
          // R1 (spec S1): the mock proposes two planner changes — one dated
          // today (the confirm test's visible task), one undated (the discard
          // test's invisible one). Tool calls bypass the pacer: they are
          // discrete events, not text.
          for (const chunk of chunkPlan("Here's what I can do for you:")) {
            clock += chunk.gapMs;
            const text = chunk.text;
            schedule(id, clock, () => emit({ type: "delta", text }));
          }
          const today = dateKey(new Date(), browserTimeZone);
          const calls: Array<{ id: string; name: string; args: string }> = [
            { id: "call_confirm", name: "create_task", args: JSON.stringify({ title: "Water the plants", day: today, estimateMinutes: 30 }) },
            { id: "call_discard", name: "create_task", args: JSON.stringify({ title: "Return library books" }) },
          ];
          for (const call of calls) {
            clock += 250;
            const event: ChatEvent = { type: "tool_call", call: { id: call.id, name: call.name, arguments: call.args } };
            schedule(id, clock, () => emit(event));
          }
          clock += 120;
          schedule(id, clock, () => {
            clearTimers(id);
            emit({ type: "done" });
            listeners.delete(id);
            resolve();
          });
          return;
        }
        for (const chunk of chunkPlan(CANNED_ANSWER)) {
          clock += chunk.gapMs;
          const text = chunk.text;
          schedule(id, clock, () => emit({ type: "delta", text }));
        }
        clock += 120;
        schedule(id, clock, () => {
          clearTimers(id);
          emit({ type: "done" });
          listeners.delete(id);
          resolve();
        });
      });
    },

    cancel(id) {
      clearTimers(id);
      const onEvent = listeners.get(id);
      if (onEvent === undefined) return Promise.resolve();
      listeners.delete(id);
      onEvent({ type: "cancelled" });
      return Promise.resolve();
    },

    async complete(request) {
      // C3a uses `complete` for memory extraction: the mock replies with
      // canned ops and records the request so tests can assert on it.
      transport.__lastCompleteRequest = request;
      exposeMock(transport);
      return CANNED_EXTRACTION;
    },
  };

  return transport;
}

/**
 * Exposes the mock instance that is actually in use (both ChatSurface and
 * ChatPanel can create one; only the wired one ever streams). Late exposure
 * — on first use, not on creation — is what keeps the global pointing at the
 * right instance.
 */
function exposeMock(transport: MockChatTransport) {
  (globalThis as { __chatMockTransport?: unknown }).__chatMockTransport = transport;
}
