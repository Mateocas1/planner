import assert from "node:assert/strict";
import { test } from "node:test";
import { formatShortcutLabel, listenThenAnnounce, parseWindowRoute } from "./quickAddWindow.ts";

test("parseWindowRoute reads the #quickadd hash", () => {
  assert.equal(parseWindowRoute("", "#quickadd"), "quickadd");
  assert.equal(parseWindowRoute("", "#quickadd/extra"), "quickadd");
});

test("parseWindowRoute reads the window=quickadd search param", () => {
  assert.equal(parseWindowRoute("?window=quickadd", ""), "quickadd");
  assert.equal(parseWindowRoute("?theme=dark&window=quickadd", ""), "quickadd");
});

test("parseWindowRoute falls back to the main window", () => {
  assert.equal(parseWindowRoute("", ""), "main");
  assert.equal(parseWindowRoute("?window=other", "#main"), "main");
  assert.equal(parseWindowRoute("?window=quickadd=1", ""), "main");
});

test("formatShortcutLabel is the wording the settings row shows", () => {
  assert.equal(formatShortcutLabel("ctrl+alt+Space"), "Ctrl+Alt+Space");
  assert.equal(formatShortcutLabel("ctrl+shift+KeyJ"), "Ctrl+Shift+J");
  assert.equal(formatShortcutLabel("meta+Digit1", "windows"), "Win+1");
  assert.equal(formatShortcutLabel("alt+F5"), "Alt+F5");
  assert.equal(formatShortcutLabel("ctrl+NumpadAdd"), "Ctrl+Num+");
});

test("formatShortcutLabel names the meta key Super on Linux", () => {
  assert.equal(formatShortcutLabel("meta+Digit1", "linux"), "Super+1");
  assert.equal(formatShortcutLabel("ctrl+super+KeyJ", "linux"), "Ctrl+Super+J");
  assert.equal(formatShortcutLabel("super+KeyJ", "windows"), "Win+J");
});

test("listenThenAnnounce signals ready only after the listener is registered", async () => {
  const calls: string[] = [];
  const off = () => undefined;
  const result = await listenThenAnnounce(
    async () => {
      await Promise.resolve();
      calls.push("listen");
      return off;
    },
    async () => {
      calls.push("ready");
    },
  );
  assert.deepEqual(calls, ["listen", "ready"]);
  assert.equal(result, off);
});

test("listenThenAnnounce still signals ready when the listener fails", async () => {
  const calls: string[] = [];
  const result = await listenThenAnnounce(
    () => Promise.reject(new Error("no ipc")),
    async () => {
      calls.push("ready");
    },
  );
  // Rust reveals the window either way; a missing listener only costs the focus.
  assert.deepEqual(calls, ["ready"]);
  assert.equal(result, undefined);
});

test("listenThenAnnounce swallows a failed announcement", async () => {
  const result = await listenThenAnnounce(
    async () => "off",
    () => Promise.reject(new Error("no ipc")),
  );
  assert.equal(result, "off");
});
