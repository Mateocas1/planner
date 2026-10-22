import assert from "node:assert/strict";
import { test } from "node:test";
import { formatShortcutLabel, parseWindowRoute, shortcutFromEvent } from "./quickAddWindow.ts";

/** A minimal keydown stand-in: only the fields the capture reads. */
function key(code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) {
  return {
    code,
    ctrlKey: mods.ctrl === true,
    altKey: mods.alt === true,
    shiftKey: mods.shift === true,
    metaKey: mods.meta === true,
  };
}

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

test("shortcutFromEvent builds the accelerator the Rust parser reads", () => {
  assert.deepEqual(shortcutFromEvent(key("Space", { ctrl: true, alt: true })), {
    ok: true,
    accelerator: "ctrl+alt+Space",
  });
  assert.deepEqual(shortcutFromEvent(key("KeyJ", { ctrl: true, shift: true })), {
    ok: true,
    accelerator: "ctrl+shift+KeyJ",
  });
  assert.deepEqual(shortcutFromEvent(key("Digit1", { meta: true })), {
    ok: true,
    accelerator: "meta+Digit1",
  });
});

test("shortcutFromEvent rejects bare keys", () => {
  const bare = shortcutFromEvent(key("Space"));
  assert.equal(bare.ok, false);
  if (!bare.ok) assert.match(bare.error, /modifier/i);
  const letter = shortcutFromEvent(key("KeyA", { shift: true }));
  assert.equal(letter.ok, true); // Shift counts as a modifier
});

test("shortcutFromEvent rejects presses that are only a modifier", () => {
  for (const code of ["ControlLeft", "AltRight", "ShiftLeft", "MetaLeft"]) {
    const result = shortcutFromEvent(key(code, { ctrl: true }));
    assert.equal(result.ok, false, code);
  }
});

test("shortcutFromEvent rejects Escape (it closes the window)", () => {
  const result = shortcutFromEvent(key("Escape", { ctrl: true }));
  assert.equal(result.ok, false);
});

test("shortcutFromEvent rejects unidentified keys", () => {
  const result = shortcutFromEvent(key("Unidentified", { ctrl: true }));
  assert.equal(result.ok, false);
});

test("formatShortcutLabel is the wording the settings row shows", () => {
  assert.equal(formatShortcutLabel("ctrl+alt+Space"), "Ctrl+Alt+Space");
  assert.equal(formatShortcutLabel("ctrl+shift+KeyJ"), "Ctrl+Shift+J");
  assert.equal(formatShortcutLabel("meta+Digit1"), "Win+1");
  assert.equal(formatShortcutLabel("alt+F5"), "Alt+F5");
  assert.equal(formatShortcutLabel("ctrl+NumpadAdd"), "Ctrl+Num+");
});
