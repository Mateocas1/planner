import assert from "node:assert/strict";
import test from "node:test";
import { buildCommands, taskResultLimit, type PaletteContext, type PaletteDestination } from "./palette.ts";
import { createShortcutRouter } from "./shortcuts.ts";

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

/* F6b (distinctive roadmap F6 criterion 5): the palette lists the keyboard's
   actions with their key hints, and the hint is the key the router really
   answers with. */

const focusedTask: PaletteContext = { shortcuts: true, focusedTask: true, settingsCommands: [] };

/** The action rows of a query as [id, hint] pairs, so the assertions read the
 * hint without narrowing every command by hand. */
function actionHints(query: string, context: PaletteContext) {
  return buildCommands(query, tasks, destinations, [], context).flatMap(command =>
    command.kind === "action" ? [[command.id, "hint" in command ? command.hint : undefined]] : [],
  );
}

test("the empty query is the same list whatever the focus or the shortcut setting", () => {
  const navigate = [
    { kind: "navigate", id: "navigate-home", view: "home", label: "Go to Today" },
    { kind: "navigate", id: "navigate-tasks", view: "tasks", label: "Go to Tasks" },
    { kind: "navigate", id: "navigate-calendar", view: "calendar", label: "Go to Calendar" },
  ];
  assert.deepEqual(buildCommands("", tasks, destinations, [], focusedTask), navigate);
  assert.deepEqual(buildCommands("", tasks, destinations, [], { shortcuts: false, focusedTask: false }), navigate);
});

test("the actions carry the key the router answers with, and close the day has none", () => {
  assert.deepEqual(actionHints("complete", focusedTask), [["action-complete-task", "x"]]);
  assert.deepEqual(actionHints("tomorrow", focusedTask), [["action-move-tomorrow", "t"]]);
  assert.deepEqual(actionHints("now", focusedTask), [["action-now-mode", "n"]]);
  // the ritual has no key in the table, so its row is listed without a hint
  assert.deepEqual(actionHints("close", focusedTask), [["action-close-day", undefined]]);
});

test("each hint is the key that performs its action in the router", () => {
  const router = createShortcutRouter();
  const expected: Record<string, string> = {
    "action-complete-task": "complete",
    "action-move-tomorrow": "tomorrow",
    "action-now-mode": "now",
  };
  const hinted = ["complete", "tomorrow", "now"].flatMap(word => actionHints(word, focusedTask)).filter(([, hint]) => hint !== undefined);
  // the loop below proves nothing unless all three hinted rows are really checked
  assert.equal(hinted.length, Object.keys(expected).length);
  for (const [id, hint] of hinted) {
    const route = router.route({ key: String(hint) }, { dialogOpen: false, enabled: true, rowFocused: false, now: 0 });
    assert.deepEqual(route, { kind: "action", action: expected[String(id)] }, `hint ${String(hint)} for ${String(id)}`);
  }
});

test("the task actions are listed only while a task holds focus", () => {
  assert.deepEqual(actionHints("complete", { shortcuts: true, focusedTask: false }), []);
  assert.deepEqual(actionHints("tomorrow", { shortcuts: true, focusedTask: false }), []);
  // the palette's own actions do not depend on focus
  assert.deepEqual(actionHints("now", { shortcuts: true, focusedTask: false }), [["action-now-mode", "n"]]);
});

test("hints are absent when keyboard shortcuts are off, and the actions stay", () => {
  const off = { shortcuts: false, focusedTask: true };
  assert.deepEqual(actionHints("complete", off), [["action-complete-task", undefined]]);
  assert.deepEqual(actionHints("now", off), [["action-now-mode", undefined]]);
  for (const command of buildCommands("now", tasks, destinations, [], off)) {
    assert.equal("hint" in command, false, `no hint key on ${command.id}`);
  }
});
