import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setDeviceLanguage } from "../i18n/index.ts";
import {
  buildListTasksResult,
  checkCompleteTask,
  checkCreateTask,
  checkDeleteTask,
  deleteTaskKeptNote,
  describeToolCall,
  type ChatToolContext,
} from "./tools.ts";

const context: ChatToolContext = {
  tasks: [{ id: "t1", title: "Write report", deadline: "2026-10-30", estimateMinutes: 45 }],
  blocks: [{ id: "b1", start: "2026-10-30T14:00:00.000Z", end: "2026-10-30T14:45:00.000Z", taskId: "t1" }],
  timeZone: "UTC",
  todayKey: "2026-10-28",
};

afterEach(() => setDeviceLanguage(null));

test("card descriptions are whole sentences in the current language", () => {
  const create = checkCreateTask('{"title":"Pay rent","estimateMinutes":30}', context.todayKey);
  assert.equal(create.ok && create.description, 'Create task "Pay rent" · 30 min');
  setDeviceLanguage("es");
  const spanish = checkCreateTask('{"title":"Pay rent","estimateMinutes":30}', context.todayKey);
  assert.equal(spanish.ok && spanish.description, 'Crear tarea «Pay rent» · 30 min');
  const done = checkCompleteTask('{"taskId":"t1","completed":false}', context);
  assert.equal(done.ok && done.description, 'Reabrir «Write report»');
});

test("plurals follow the language's rules", () => {
  setDeviceLanguage("es");
  const remove = checkDeleteTask('{"taskId":"t1"}', context);
  assert.match(remove.ok ? remove.description : "", /^Eliminar tarea «Write report» · vence .* · 45 min · y su 1 bloque de trabajo: /);
  assert.equal(deleteTaskKeptNote([], [{ id: "x" }, { id: "y" }]), ". Se crearon 2 bloques más vinculados a esta tarea después de la tarjeta y se mantuvieron");
  assert.equal(buildListTasksResult({ includeCompleted: false }, context).summary, "1 tarea encontrada.");
});

test("an invalid proposal keeps a neutral line in Spanish", () => {
  setDeviceLanguage("es");
  assert.equal(
    describeToolCall({ name: "create_task", arguments: "{" }, context),
    "El asistente propuso una acción, pero sus detalles no son válidos.",
  );
});
