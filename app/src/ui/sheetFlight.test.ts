import assert from "node:assert/strict";
import test from "node:test";
import { bodyBlurFlight, handoffActive } from "./sheetFlight.ts";

test("without the handoff the body pulls focus from the given radius to zero", () => {
  assert.deepEqual(bodyBlurFlight(8, false), [{ filter: "blur(8px)" }, { filter: "blur(0px)" }]);
  assert.deepEqual(bodyBlurFlight(4, false), [{ filter: "blur(4px)" }, { filter: "blur(0px)" }]);
});

test("under the compositor handoff the body flight carries no filter at all", () => {
  assert.equal(bodyBlurFlight(8, true), null);
  assert.equal(bodyBlurFlight(4, true), null);
});

test("a zero radius needs no blur animation either", () => {
  assert.equal(bodyBlurFlight(0, false), null);
});

test("the handoff is read from the root attribute the guard sets", () => {
  const root = (marked: boolean) => ({ hasAttribute: (name: string) => marked && name === "data-compositor-handoff" });
  assert.equal(handoffActive(root(true)), true);
  assert.equal(handoffActive(root(false)), false);
});
