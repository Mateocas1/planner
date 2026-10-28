import assert from "node:assert/strict";
import { test } from "node:test";
import { stepWithin } from "./numberStep.ts";

test("a step moves the draft and holds the bounds", () => {
  assert.equal(stepWithin("10", 1, 5, 60, 10), 11);
  assert.equal(stepWithin("5", -1, 5, 60, 10), 5);
  assert.equal(stepWithin("60", 1, 5, 60, 10), 60);
});

test("an empty draft steps from the fallback", () => {
  assert.equal(stepWithin("", 5, 5, 60, 10), 15);
});

test("a draft outside the range is pulled back into it by the step", () => {
  assert.equal(stepWithin("200", -1, 5, 60, 10), 60);
  assert.equal(stepWithin("1", 1, 5, 60, 10), 5);
});
