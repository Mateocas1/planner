import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setDeviceLanguage, t } from "./index.ts";
import { unplacedNotice, type Unplaced } from "../planning/place.ts";
import { overcommitNote } from "../planning/capacity.ts";
import { estimateNote } from "../domain/model.ts";

afterEach(() => setDeviceLanguage(null));

const unplaced = (title: string): Unplaced => ({ task: { id: title, title, estimate: 30 } }) as unknown as Unplaced;

test("planning copy: English keeps its wording", () => {
  assert.equal(unplacedNotice([unplaced("Report")]), "1 task didn't fit today: Report. Plan tomorrow?");
  assert.equal(t("plan.apply", { count: 3 }), "Apply 3 blocks");
  assert.equal(estimateNote(undefined), "Assumed 1h");
});

test("planning copy: Spanish plurals and whole-sentence templates", () => {
  setDeviceLanguage("es");
  assert.equal(unplacedNotice([unplaced("Informe")]), "1 tarea no cupo hoy: Informe. ¿Planificar mañana?");
  assert.equal(unplacedNotice([unplaced("A"), unplaced("B")]), "2 tareas no cupieron hoy: A, B. ¿Planificar mañana?");
  assert.equal(t("plan.apply", { count: 1 }), "Aplicar 1 bloque");
  assert.equal(t("plan.apply", { count: 2 }), "Aplicar 2 bloques");
  assert.equal(estimateNote(undefined), "Se asume 1h");
  assert.match(overcommitNote({ deadline: "2026-10-30", overMinutes: 60 } as Parameters<typeof overcommitNote>[0]), /^Sobran 1h para /);
});
