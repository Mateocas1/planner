import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CAPTURE_KEY_ERROR,
  CAPTURE_MODIFIER_ERROR,
  acceleratorLabel,
  acceleratorOf,
  captureFromEvent,
  findConflict,
  fixedInAppShortcuts,
  getBinding,
  keycaps,
  matchesEvent,
  parseAccelerator,
  rebindableShortcuts,
  sameCombo,
  setBinding,
  type Accelerator,
  type RebindableShortcutId,
} from "./shortcutRegistry.ts";

/** The defaults every conflict test starts from. */
const defaults: Record<RebindableShortcutId, Accelerator> = Object.fromEntries(
  rebindableShortcuts.map(shortcut => [shortcut.id, shortcut.defaultAccelerator]),
) as Record<RebindableShortcutId, Accelerator>;

const press = (code: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) =>
  captureFromEvent({ code, ctrlKey: mods.ctrl ?? false, altKey: mods.alt ?? false, shiftKey: mods.shift ?? false, metaKey: mods.meta ?? false });

describe("parseAccelerator / acceleratorOf / keycaps", () => {
  it("round-trips the defaults", () => {
    for (const shortcut of rebindableShortcuts) {
      const combo = parseAccelerator(shortcut.defaultAccelerator);
      assert.ok(combo !== null, shortcut.id);
      assert.equal(acceleratorOf(combo), shortcut.defaultAccelerator);
    }
  });

  it("reads the Rust side's printed case and normalizes modifiers", () => {
    const combo = parseAccelerator("Ctrl+Alt+Space");
    assert.deepEqual(combo, { ctrl: true, alt: true, shift: false, meta: false, code: "Space" });
    assert.equal(acceleratorOf(combo!), "ctrl+alt+Space");
  });

  it("rejects strings that are not accelerators", () => {
    assert.equal(parseAccelerator(""), null);
    assert.equal(parseAccelerator("KeyK"), null);
    assert.equal(parseAccelerator("ctrl"), null);
    assert.equal(parseAccelerator("ctrl+alt"), null); // key must come last
    assert.equal(parseAccelerator("KeyK+ctrl"), null);
    assert.equal(parseAccelerator("ctrl+ctrl+KeyK"), null);
  });

  it("formats keycaps in press order", () => {
    assert.deepEqual(keycaps("ctrl+alt+Space"), ["Ctrl", "Alt", "Space"]);
    assert.deepEqual(keycaps("ctrl+KeyK"), ["Ctrl", "K"]);
    assert.deepEqual(keycaps("ctrl+Comma"), ["Ctrl", ","]);
    assert.deepEqual(keycaps("meta+Digit1"), ["Win", "1"]);
  });

  it("prints the platform's modifier, matching the help sheet", () => {
    assert.deepEqual(keycaps("ctrl+KeyK", true), ["⌘", "K"]);
    assert.deepEqual(keycaps("ctrl+KeyK", false), ["Ctrl", "K"]);
    assert.deepEqual(keycaps("meta+KeyK", true), ["⌘", "K"]);
    assert.deepEqual(keycaps("meta+KeyK", false), ["Win", "K"]);
  });

  it("labels accelerators the way messages quote them", () => {
    assert.equal(acceleratorLabel("ctrl+alt+Space"), "Ctrl+Alt+Space");
    assert.equal(acceleratorLabel("ctrl+Comma"), "Ctrl+,");
  });
});

describe("captureFromEvent", () => {
  it("accepts Ctrl/Alt/Cmd chords and serializes the DOM code", () => {
    assert.deepEqual(press("KeyK", { ctrl: true }), { ok: true, accelerator: "ctrl+KeyK" });
    assert.deepEqual(press("Space", { ctrl: true, alt: true }), { ok: true, accelerator: "ctrl+alt+Space" });
    assert.deepEqual(press("KeyJ", { meta: true }), { ok: true, accelerator: "meta+KeyJ" });
  });

  it("refuses a press without Ctrl/Alt/Cmd — Shift alone would swallow capitals", () => {
    const bare = press("KeyK");
    assert.equal(bare.ok, false);
    if (!bare.ok) assert.equal(bare.error, CAPTURE_MODIFIER_ERROR);
    const shifted = press("KeyK", { shift: true });
    assert.equal(shifted.ok, false);
    if (!shifted.ok) assert.equal(shifted.error, CAPTURE_MODIFIER_ERROR);
  });

  it("refuses a lone modifier and an unusable key", () => {
    const lone = press("ControlLeft", { ctrl: true });
    assert.equal(lone.ok, false);
    if (!lone.ok) assert.equal(lone.error, CAPTURE_MODIFIER_ERROR);
    const unknown = press("Unidentified", { ctrl: true });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.error, CAPTURE_KEY_ERROR);
  });
});

describe("findConflict", () => {
  it("rejects a chord another rebindable shortcut already holds", () => {
    const conflict = findConflict("ctrl+KeyK", { bindings: defaults, setting: "chat", desktop: false });
    assert.equal(conflict?.kind, "rebindable");
    if (conflict?.kind === "rebindable") {
      assert.equal(conflict.holder, "palette");
      assert.equal(conflict.message, "Already used by Command palette. Pick a different combination.");
    }
  });

  it("never conflicts with itself", () => {
    assert.equal(findConflict("ctrl+KeyK", { bindings: defaults, setting: "palette", desktop: false }), null);
  });

  it("sees through Ctrl-vs-Cmd when comparing chords", () => {
    const bindings = { ...defaults, palette: "ctrl+KeyK" };
    assert.equal(findConflict("meta+KeyK", { bindings, setting: "chat", desktop: false })?.kind, "rebindable");
    assert.ok(sameCombo(parseAccelerator("ctrl+KeyK")!, parseAccelerator("meta+KeyK")!));
  });

  it("rejects the fixed in-app chord Ctrl+Comma", () => {
    const conflict = findConflict("ctrl+Comma", { bindings: defaults, setting: "palette", desktop: false });
    assert.equal(conflict?.kind, "fixed");
    if (conflict?.kind === "fixed") assert.equal(conflict.message, "Ctrl+, is reserved for Settings.");
  });

  it("can never collide with the single-key in-app shortcuts: they have no modifiers", () => {
    // Every rebindable chord carries Ctrl/Alt/Cmd, so a plain letter from
    // shortcutHelp (j, k, x, t, c, b, n, ?) is never equal to one: the registry
    // compares chords, and a chord always has a command modifier. Proven by
    // `sameCombo` on a no-modifier combo: no chord can equal it.
    const letter = { ctrl: false, alt: false, shift: false, meta: false, code: "KeyJ" };
    for (const chord of ["ctrl+KeyK", "ctrl+alt+Space", "meta+KeyK", "alt+Comma"]) {
      assert.equal(sameCombo(parseAccelerator(chord)!, letter), false);
    }
    assert.ok(fixedInAppShortcuts.every(entry => parseAccelerator(entry.accelerator) !== null));
  });

  it("rejects browser-reserved chords on the web", () => {
    for (const code of ["KeyW", "KeyT", "KeyN", "KeyR", "KeyL"]) {
      const conflict = findConflict(`ctrl+${code}`, { bindings: defaults, setting: "palette", desktop: false });
      assert.equal(conflict?.kind, "reserved", code);
      if (conflict?.kind === "reserved") {
        assert.equal(conflict.message, `${acceleratorLabel(`ctrl+${code}`)} is reserved by your browser/system.`);
      }
    }
    // Shifted variants are reserved too, and Cmd counts as the command modifier.
    assert.equal(findConflict("ctrl+shift+KeyT", { bindings: defaults, setting: "palette", desktop: false })?.kind, "reserved");
    assert.equal(findConflict("meta+KeyW", { bindings: defaults, setting: "palette", desktop: false })?.kind, "reserved");
  });

  it("rejects OS-reserved chords on desktop only", () => {
    // Win-key combos and Alt+F4 / Ctrl+Alt+Delete are desktop reservations.
    assert.equal(findConflict("meta+KeyM", { bindings: defaults, setting: "palette", desktop: false }), null);
    assert.equal(findConflict("meta+KeyM", { bindings: defaults, setting: "palette", desktop: true })?.kind, "reserved");
    assert.equal(findConflict("alt+KeyM", { bindings: defaults, setting: "palette", desktop: false }), null);
    assert.equal(findConflict("alt+F4", { bindings: defaults, setting: "palette", desktop: true })?.kind, "reserved");
    assert.equal(findConflict("ctrl+alt+Delete", { bindings: defaults, setting: "palette", desktop: true })?.kind, "reserved");
  });

  it("lets ordinary chords through", () => {
    assert.equal(findConflict("ctrl+alt+KeyK", { bindings: defaults, setting: "palette", desktop: true }), null);
    assert.equal(findConflict("alt+Comma", { bindings: defaults, setting: "chat", desktop: true }), null);
  });
});

describe("bindings storage (localStorage)", () => {
  /** A minimal localStorage stand-in: the registry only calls getItem/setItem. */
  function fakeStorage() {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
      clear: () => void map.clear(),
      key: () => null,
      length: 0,
    };
  }

  it("installStorage", () => {
    // @ts-expect-error -- the test environment provides the storage surface
    globalThis.window = { localStorage: fakeStorage(), dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} };
  });

  it("reads the default when nothing is stored", () => {
    assert.equal(getBinding("palette"), "ctrl+KeyK");
    assert.equal(getBinding("chat"), "ctrl+KeyJ");
  });

  it("persists a rebind and clears it back to the default", () => {
    assert.equal(setBinding("palette", "ctrl+alt+KeyP"), null);
    assert.equal(getBinding("palette"), "ctrl+alt+KeyP");
    assert.equal(setBinding("palette", null), null);
    assert.equal(getBinding("palette"), "ctrl+KeyK");
  });

  it("writes nothing on a conflict", () => {
    const before = getBinding("chat");
    const conflict = setBinding("chat", "ctrl+KeyK");
    assert.equal(conflict?.kind, "rebindable");
    assert.equal(getBinding("chat"), before);
  });

  it("stores nothing when the value equals the default", () => {
    assert.equal(setBinding("chat", "ctrl+KeyJ"), null);
    assert.equal(getBinding("chat"), "ctrl+KeyJ");
  });
});

describe("matchesEvent (live listeners)", () => {
  const event = (code: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) => ({
    code,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
    metaKey: mods.meta ?? false,
  });

  it("matches the exact chord", () => {
    assert.equal(matchesEvent("ctrl+KeyK", event("KeyK", { ctrl: true })), true);
    assert.equal(matchesEvent("ctrl+alt+Space", event("Space", { ctrl: true, alt: true })), true);
  });

  it("counts Cmd as the command modifier on a Mac", () => {
    assert.equal(matchesEvent("ctrl+KeyK", event("KeyK", { meta: true })), true);
  });

  it("refuses extra or missing modifiers and other keys", () => {
    assert.equal(matchesEvent("ctrl+KeyK", event("KeyK", { ctrl: true, shift: true })), false);
    assert.equal(matchesEvent("ctrl+KeyK", event("KeyK", { ctrl: true, alt: true })), false);
    assert.equal(matchesEvent("ctrl+KeyK", event("KeyJ", { ctrl: true })), false);
    assert.equal(matchesEvent("ctrl+KeyK", event("KeyK")), false);
  });
});
