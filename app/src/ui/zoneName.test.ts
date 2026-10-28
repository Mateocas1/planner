import assert from "node:assert/strict";
import test from "node:test";
import { zoneName } from "./zoneName.ts";

const winter = new Date("2026-01-15T12:00:00Z");
const summer = new Date("2026-07-15T12:00:00Z");

test("a zone reads as its long English name, not its IANA id", () => {
  assert.equal(zoneName("America/Sao_Paulo", "en-US", winter), "Brasilia Standard Time");
});

test("the name is localized", () => {
  assert.equal(zoneName("America/Sao_Paulo", "es", winter), "hora estándar de Brasilia");
});

test("the name follows daylight saving at the given instant", () => {
  assert.equal(zoneName("America/New_York", "en-US", summer), "Eastern Daylight Time");
  assert.equal(zoneName("America/New_York", "en-US", winter), "Eastern Standard Time");
});

test("an unknown zone falls back to the id", () => {
  assert.equal(zoneName("Not/AZone", "en-US", winter), "Not/AZone");
});
