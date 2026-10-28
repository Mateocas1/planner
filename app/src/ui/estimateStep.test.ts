import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ESTIMATE_MINUTES, MIN_ESTIMATE_MINUTES } from "../domain/model.ts";
import { digitsOnly, parseDraft, stepEstimate } from "./estimateStep.ts";

test("the first step from an empty field starts at the 60-minute assumption", () => {
  assert.equal(stepEstimate(undefined, 5), 65);
  assert.equal(stepEstimate(undefined, -5), 55);
  assert.equal(stepEstimate(undefined, 30), 90);
});

test("an off-grid value snaps to the 5-minute grid before stepping", () => {
  assert.equal(stepEstimate(47, 5), 50);
  assert.equal(stepEstimate(47, -5), 45);
  assert.equal(stepEstimate(50, 5), 55);
  assert.equal(stepEstimate(47, 30), 75);
  assert.equal(stepEstimate(47, -30), 20);
});

test("stepping clamps to the domain bounds", () => {
  assert.equal(stepEstimate(MIN_ESTIMATE_MINUTES, -5), MIN_ESTIMATE_MINUTES);
  assert.equal(stepEstimate(10, -30), MIN_ESTIMATE_MINUTES);
  assert.equal(stepEstimate(MAX_ESTIMATE_MINUTES, 5), MAX_ESTIMATE_MINUTES);
  assert.equal(stepEstimate(1430, 30), MAX_ESTIMATE_MINUTES);
});

test("digitsOnly strips everything that is not a digit", () => {
  assert.equal(digitsOnly("1e5 m-"), "15");
  assert.equal(digitsOnly(""), "");
});

test("parseDraft maps an empty draft to undefined and digits to a number", () => {
  assert.equal(parseDraft(""), undefined);
  assert.equal(parseDraft("30"), 30);
  assert.equal(parseDraft("0"), 0);
});
