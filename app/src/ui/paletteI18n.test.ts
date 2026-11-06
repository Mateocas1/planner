import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setDeviceLanguage } from "../i18n/index.ts";
import { actionCommands, buildCommands, focusCommands, themeCommands } from "./palette.ts";
import { shortcutHelpFor } from "./shortcuts.ts";

afterEach(() => setDeviceLanguage(null));

test("palette rows and the help table follow the language, English unchanged", () => {
  assert.equal(themeCommands[1].label, "Theme: Light");
  assert.equal(shortcutHelpFor(false)[0].title, "Move");
  setDeviceLanguage("es");
  assert.equal(themeCommands[1].label, "Tema: Claro");
  assert.equal(shortcutHelpFor(false)[0].title, "Moverse");
  assert.equal(shortcutHelpFor(false)[4].entries[0].label, "Paleta de comandos");
  assert.equal(focusCommands({ canStart: true, status: null })[0].label, "Iniciar enfoque en el siguiente bloque");
});

test("a Spanish query finds the Spanish keyword, and the create row is a whole sentence", () => {
  setDeviceLanguage("es");
  const rows = buildCommands("semanal", [], [], [], { shortcuts: false, focusedTask: false });
  assert.equal(rows[0].kind, "action");
  assert.equal(rows[0].kind === "action" && rows[0].label, "Revisión semanal");
  assert.equal(actionCommands.length, 6);
});

test("the group ids stay the English slugs", () => {
  setDeviceLanguage("es");
  assert.deepEqual(shortcutHelpFor(false).map(group => group.id), ["move", "act-on-the-focused-row", "create", "go", "anywhere"]);
});

test("Capture follows the language: Spanish words find it, English unchanged", () => {
  const capture = () => actionCommands.find(command => command.action === "capture");
  assert.equal(capture()?.label, "Capture");
  setDeviceLanguage("es");
  assert.equal(capture()?.label, "Capturar");
  const rows = buildCommands("pegar", [], [], [], { shortcuts: false, focusedTask: false });
  assert.equal(rows[0].kind === "action" && rows[0].id, "action-capture");
});
