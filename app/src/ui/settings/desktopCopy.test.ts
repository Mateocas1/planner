import assert from "node:assert/strict";
import test from "node:test";
import { copyFamily, quickAddUnregisteredCause } from "../../desktop.ts";
import { setDeviceLanguage } from "../../i18n/index.ts";
import {
  notificationsDescription,
  quickAddDescription,
  quickAddUnregisteredNote,
  startupChangeError,
  startupLabel,
  startupReadError,
  systemSectionTitle,
} from "./desktopCopy.ts";

test("copyFamily keeps Windows and Linux and folds the rest into other", () => {
  assert.equal(copyFamily("windows"), "windows");
  assert.equal(copyFamily("linux"), "linux");
  assert.equal(copyFamily("macos"), "other");
  assert.equal(copyFamily("other"), "other");
});

test("the Desktop tab names Windows only on Windows", () => {
  assert.equal(systemSectionTitle("windows"), "Windows");
  assert.equal(systemSectionTitle("linux"), "Linux");
  assert.equal(systemSectionTitle("macos"), "This computer");
  assert.equal(startupLabel("windows"), "Open Planner when I sign in to Windows");
  assert.equal(startupLabel("linux"), "Open Planner when I log in");
  for (const platform of ["linux", "macos", "other"] as const) {
    for (const line of [
      systemSectionTitle(platform),
      startupLabel(platform),
      startupReadError(platform),
      startupChangeError(platform),
      notificationsDescription(platform),
      quickAddDescription(platform),
    ]) {
      assert.doesNotMatch(line, /Windows/, `${platform}: ${line}`);
    }
  }
  assert.match(startupReadError("windows"), /^Windows /);
  assert.match(notificationsDescription("windows"), /^Windows /);
  assert.match(quickAddDescription("windows"), /Windows\.$/);
});

test("the Desktop tab copy follows the language", () => {
  setDeviceLanguage("es");
  try {
    assert.equal(startupLabel("windows"), "Abrir Planner al iniciar sesión en Windows");
    assert.equal(startupLabel("linux"), "Abrir Planner al iniciar sesión");
    assert.equal(systemSectionTitle("other"), "Este equipo");
    assert.equal(notificationsDescription("linux"), "Notificaciones del escritorio, en este equipo.");
  } finally {
    setDeviceLanguage(null);
  }
});

test("an unregistered quick-add chord under Wayland points at the compositor", () => {
  const wayland = "Wayland: bind this chord in the compositor to `planner --quickadd`.";
  assert.equal(quickAddUnregisteredCause(wayland), "compositor");
  assert.equal(quickAddUnregisteredCause("HotKey already registered"), "refused");
  assert.equal(quickAddUnregisteredCause(null), "refused");
  assert.equal(quickAddUnregisteredCause(undefined), "refused");
  assert.match(quickAddUnregisteredNote(wayland), /^On Wayland, your compositor owns global shortcuts\./);
  assert.match(quickAddUnregisteredNote("HotKey already registered"), /another app may be using it/);
});

test("a failed Hyprland bind sync gets its own cause and note", () => {
  const write = "Hyprland bind not written: the chord is saved, but the compositor still binds the previous one.";
  const reload = "Hyprland reload failed: the chord is saved, but Hyprland did not reload.";
  assert.equal(quickAddUnregisteredCause(write), "bindWrite");
  assert.equal(quickAddUnregisteredCause(reload), "reload");
  assert.equal(quickAddUnregisteredNote(reload), "Saved, but Hyprland did not reload. Run `hyprctl reload`.");
  assert.match(quickAddUnregisteredNote(write), /^Saved, but Planner could not write its Hyprland bind file\./);
  setDeviceLanguage("es");
  try {
    assert.equal(quickAddUnregisteredNote(reload), "Guardado, pero Hyprland no se recargó. Para aplicarlo, ejecutar `hyprctl reload`.");
    assert.match(quickAddUnregisteredNote(write), /^Guardado, pero Planner no pudo escribir/);
  } finally {
    setDeviceLanguage(null);
  }
});
