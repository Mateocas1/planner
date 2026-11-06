import assert from "node:assert/strict";
import test from "node:test";
import { setDeviceLanguage } from "../i18n/index.ts";
import { toChatEvent } from "./tauriTransport.ts";
import type { ChatEvent } from "./types.ts";

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

test("toChatEvent localizes a credential-store-unavailable error", () => {
  const raw = { type: "error", code: "credential_store_unavailable", message: "the stored key could not be read: dbus" };
  try {
    setDeviceLanguage("es");
    const event = toChatEvent(raw);
    assert.equal(event?.type, "error");
    assert.equal(event?.type === "error" && event.code, "credential_store_unavailable");
    assert.match(event?.type === "error" ? event.message : "", /llavero del sistema/);
  } finally {
    setDeviceLanguage(null);
  }
});
