import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CHAT_MODEL, buildSystemPrompt, chatPanelVisible, mockMode } from "./config.ts";

test("the default model is the NaN deepseek flash the user named", () => {
  assert.equal(DEFAULT_CHAT_MODEL, "deepseek-v4-flash");
});

test("buildSystemPrompt returns a short non-empty prompt (C3 replaces the stub)", () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.length > 0);
  assert.ok(prompt.length < 1000);
});

test("the panel renders in the desktop shell regardless of the query", () => {
  assert.equal(chatPanelVisible({ desktop: true, dev: false, mockQuery: null }), true);
  assert.equal(chatPanelVisible({ desktop: true, dev: false, mockQuery: "1" }), true);
});

test("the panel renders on the web only while developing with ?chatMock", () => {
  assert.equal(chatPanelVisible({ desktop: false, dev: true, mockQuery: "1" }), true);
  assert.equal(chatPanelVisible({ desktop: false, dev: true, mockQuery: null }), false);
  assert.equal(chatPanelVisible({ desktop: false, dev: false, mockQuery: "1" }), false, "a production web build never renders the panel");
});

test("?chatMock=error asks the mock transport for the failure scenario", () => {
  assert.equal(mockMode("error"), "error");
  assert.equal(mockMode("1"), "answer");
  assert.equal(mockMode(null), "answer");
});
