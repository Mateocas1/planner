import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CHAT_BASE_URL, toChatEvent } from "./tauriTransport.ts";
import type { ChatEvent } from "./types.ts";

test("the default base URL is the NaN OpenAI-compatible endpoint", () => {
  assert.equal(DEFAULT_CHAT_BASE_URL, "https://api.nan.builders/v1");
});

test("toChatEvent passes the contract events through", () => {
  const events: Array<unknown> = [
    { type: "reasoning" },
    { type: "delta", text: "Hello" },
    { type: "done" },
    { type: "cancelled" },
    { type: "error", code: "no_key", message: "No API key is saved." },
  ];
  const expected: ChatEvent[] = [
    { type: "reasoning" },
    { type: "delta", text: "Hello" },
    { type: "done" },
    { type: "cancelled" },
    { type: "error", code: "no_key", message: "No API key is saved." },
  ];
  assert.deepEqual(events.map(toChatEvent), expected);
});

test("toChatEvent drops payloads that are not contract events", () => {
  assert.equal(toChatEvent(null), null);
  assert.equal(toChatEvent("delta"), null);
  assert.equal(toChatEvent({}), null);
  assert.equal(toChatEvent({ type: "unknown" }), null);
  assert.equal(toChatEvent({ type: "delta" }), null);
  assert.equal(toChatEvent({ type: "delta", text: 42 }), null);
  assert.equal(toChatEvent({ type: "error", code: "no_key" }), null);
  assert.equal(toChatEvent({ type: "error", code: 5, message: "m" }), null);
});
