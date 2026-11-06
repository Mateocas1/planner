import assert from "node:assert/strict";
import { test } from "node:test";
import { formatShortcutLabel, parseWindowRoute } from "./quickAddWindow.ts";

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
