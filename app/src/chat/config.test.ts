import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CHAT_MODEL, chatPanelVisible, mockMode } from "./config.ts";

test("the default model is the NaN deepseek flash the user named", () => {
  assert.equal(DEFAULT_CHAT_MODEL, "deepseek-v4-flash");
});

test("the panel renders in a signed-in desktop shell regardless of the query (review #2)", () => {
  assert.equal(chatPanelVisible({ desktop: true, dev: false, mockQuery: null, signedIn: true }), true);
  assert.equal(chatPanelVisible({ desktop: true, dev: false, mockQuery: "1", signedIn: true }), true);
});

test("the panel never renders on a signed-out desktop sign-in screen (review #2)", () => {
  assert.equal(chatPanelVisible({ desktop: true, dev: false, mockQuery: null, signedIn: false }), false);
});

test("the panel renders on the web only while developing with ?chatMock (account-free)", () => {
  assert.equal(chatPanelVisible({ desktop: false, dev: true, mockQuery: "1", signedIn: false }), true, "the dev mock is account-free");
  assert.equal(chatPanelVisible({ desktop: false, dev: true, mockQuery: null, signedIn: true }), false);
  assert.equal(chatPanelVisible({ desktop: false, dev: false, mockQuery: "1", signedIn: true }), false, "a production web build never renders the panel");
});

test("?chatMock=error asks the mock transport for the failure scenario", () => {
  assert.equal(mockMode("error"), "error");
  assert.equal(mockMode("1"), "answer");
  assert.equal(mockMode(null), "answer");
});
