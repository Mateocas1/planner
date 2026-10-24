import assert from "node:assert/strict";
import test from "node:test";
import { isTauri } from "./desktop.ts";

test("isTauri is true only when the Tauri internals are injected", () => {
  assert.equal(isTauri({}), false);
  assert.equal(isTauri({ __TAURI_INTERNALS__: {} }), true);
});
