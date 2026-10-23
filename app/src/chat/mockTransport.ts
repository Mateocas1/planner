/**
 * The mock transport (task C2): lets the panel be built, screenshotted and
 * browser-tested without Rust or an API key. Streams a canned Markdown answer
 * with realistic timing — a short connect, ~1.2 s of `reasoning`, then bursty
 * `delta` chunks (1–30 characters, 20–250 ms apart) — so the stream pacer has
 * real bursts to smooth. `?chatMock=error` streams the failure path instead.
 */

import type { ChatEvent, ChatRequest, ChatTransport } from "./types.ts";

const CANNED_ANSWER = `Here's where your day stands.

You have **two blocks** left, and the *Deep Work* session on the chat panel is next. The shutdown ritual opens at **18:30**.

- 14:00–15:30 · Deep Work — chat panel
- 16:00–16:45 · Review the inbox

If you want to plan tomorrow, just ask with \`plan tomorrow\` — details in [the planner guide](https://example.com/planner-guide).`;

export type MockScenario = "answer" | "error";

export function createMockTransport(scenario: MockScenario = "answer"): ChatTransport {
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

  return {
    stream(request, onEvent) {
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
      // C3 uses `complete` for memory extraction; the mock returns the canned
      // answer so a miswired extraction is visible instead of silent.
      void request;
      return CANNED_ANSWER;
    },
  };
}
