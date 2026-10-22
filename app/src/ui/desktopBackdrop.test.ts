import assert from "node:assert/strict";
import { test } from "node:test";
import { syncBackdropClasses } from "./desktopBackdrop.ts";

/** Records classList calls so the sync decision can be asserted without a DOM. */
function fakeRoot() {
  const calls: Array<[string, boolean | string]> = [];
  return {
    calls,
    classList: {
      add: (name: string) => calls.push(["add", name]),
      toggle: (name: string, force: boolean) => {
        calls.push(["toggle", force]);
        return force;
      },
      remove: () => {},
    },
  };
}

test("syncBackdropClasses always marks the root as the desktop shell", () => {
  const root = fakeRoot();
  syncBackdropClasses(root as never, false);
  assert.deepEqual(root.calls, [["add", "desktop-shell"], ["toggle", false]]);
});

test("syncBackdropClasses turns the mica class on only when the backdrop applied", () => {
  const applied = fakeRoot();
  syncBackdropClasses(applied as never, true);
  assert.ok(applied.calls.some(([op, value]) => op === "toggle" && value === true));

  const failed = fakeRoot();
  syncBackdropClasses(failed as never, false);
  assert.ok(!failed.calls.some(([op, value]) => op === "toggle" && value === true));
});
