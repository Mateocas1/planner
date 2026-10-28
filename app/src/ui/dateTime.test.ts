import assert from "node:assert/strict";
import { test } from "node:test";
import { joinLocal, setLocalDate, setLocalTime, splitLocal } from "./dateTime.ts";

test("splitLocal reads the date and the clock of a local value", () => {
  assert.deepEqual(splitLocal("2026-03-04T09:30"), { date: "2026-03-04", time: "09:30" });
});

test("splitLocal of an empty or half-formed value gives empty parts", () => {
  assert.deepEqual(splitLocal(""), { date: "", time: "" });
  assert.deepEqual(splitLocal("2026-03-04"), { date: "2026-03-04", time: "" });
});

test("joinLocal needs both parts and zero-pads the clock", () => {
  assert.equal(joinLocal("2026-03-04", 9 * 60 + 5), "2026-03-04T09:05");
  assert.equal(joinLocal("", 60), "");
});

test("setLocalTime accepts the typed forms parseClock reads", () => {
  assert.equal(setLocalTime("2026-03-04T09:00", "14:15"), "2026-03-04T14:15");
  assert.equal(setLocalTime("2026-03-04T09:00", "930"), "2026-03-04T09:30");
  assert.equal(setLocalTime("2026-03-04T09:00", "7"), "2026-03-04T07:00");
});

test("setLocalTime refuses text that is not a time of day and keeps the value", () => {
  assert.equal(setLocalTime("2026-03-04T09:00", "later"), null);
  assert.equal(setLocalTime("2026-03-04T09:00", "24:00"), null);
  assert.equal(setLocalTime("2026-03-04T09:00", "9:75"), null);
});

test("setLocalDate keeps the clock; picking a date on an empty value starts at midnight", () => {
  assert.equal(setLocalDate("2026-03-04T09:30", "2026-03-06"), "2026-03-06T09:30");
  assert.equal(setLocalDate("", "2026-03-06"), "2026-03-06T00:00");
  assert.equal(setLocalDate("2026-03-04T09:30", ""), "");
});

test("setLocalTime on a value with no day takes the fallback day, or stays empty without one", () => {
  assert.equal(setLocalTime("", "10:00", "2026-03-04"), "2026-03-04T10:00");
  assert.equal(setLocalTime("", "10:00"), "");
});
