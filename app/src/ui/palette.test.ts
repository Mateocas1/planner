import assert from "node:assert/strict";
import test from "node:test";
import { buildCommands, taskResultLimit, type PaletteDestination } from "./palette.ts";

const destinations: PaletteDestination[] = [
  { id: "home", label: "Go to Today" },
  { id: "tasks", label: "Go to Tasks" },
  { id: "calendar", label: "Go to Calendar" },
];

const tasks = [
  { id: "t2", title: "Buy milk" },
  { id: "t1", title: "Buy a bike" },
  { id: "t3", title: "Water the plants" },
];

test("an empty query offers the destinations and never a create row", () => {
  assert.deepEqual(buildCommands("", tasks, destinations), [
    { kind: "navigate", id: "navigate-home", view: "home", label: "Go to Today" },
    { kind: "navigate", id: "navigate-tasks", view: "tasks", label: "Go to Tasks" },
    { kind: "navigate", id: "navigate-calendar", view: "calendar", label: "Go to Calendar" },
  ]);
  // whitespace is not a title: Enter must not create a blank task
  assert.equal(buildCommands("   ", tasks, destinations).some(command => command.kind === "create"), false);
});

test("a typed query makes create the first row, with the trimmed title", () => {
  const commands = buildCommands("  Buy milk  ", tasks, destinations);
  assert.deepEqual(commands[0], { kind: "create", id: "create", title: "Buy milk" });
});

test("tasks match by title, case-insensitively, sorted, and capped", () => {
  assert.deepEqual(
    buildCommands("buy", tasks, destinations).filter(command => command.kind === "task"),
    [
      { kind: "task", id: "task-t1", taskId: "t1", label: "Buy a bike" },
      { kind: "task", id: "task-t2", taskId: "t2", label: "Buy milk" },
    ],
  );
  const many = Array.from({ length: taskResultLimit + 3 }, (_, index) => ({ id: `m${index}`, title: `Task ${index}` }));
  assert.equal(buildCommands("task", many, destinations).filter(command => command.kind === "task").length, taskResultLimit);
});

test("a query names a destination after the tasks, never before the create row", () => {
  assert.deepEqual(
    buildCommands("cal", [], destinations).map(command => command.id),
    ["create", "navigate-calendar"],
  );
  assert.deepEqual(
    buildCommands("buy", tasks, destinations).map(command => command.id),
    ["create", "task-t1", "task-t2"],
  );
});

test("the palette offers the shutdown ritual for a query that names it, and nowhere else", () => {
  // F3 criterion 3's other entry point: `Close the day`, matched on its own
  // words rather than on the label, like every other one-shot command.
  const close = buildCommands("close", [], destinations).filter(command => command.kind === "action");
  assert.deepEqual(close, [
    { kind: "action", id: "action-close-day", action: "close-day", label: "Close the day", keywords: ["close", "shutdown", "day", "ritual"] },
  ]);
  assert.deepEqual(
    buildCommands("shutdown", [], destinations).filter(command => command.kind === "action").map(command => command.id),
    ["action-close-day"],
  );
  // An empty palette still offers the destinations only, and a query that names
  // something else never drags the ritual in.
  assert.equal(buildCommands("", [], destinations).some(command => command.kind === "action"), false);
  assert.equal(buildCommands("water", tasks, destinations).some(command => command.kind === "action"), false);
});
