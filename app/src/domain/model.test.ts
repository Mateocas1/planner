import assert from "node:assert/strict";
import test from "node:test";
import { createOccurrenceCompletion, createTask, createWorkBlock, expandOccurrences, occurrenceId, type Recurrence } from "./model.ts";

test("occurrence identity is stable for a series and UTC date", () => {
  assert.equal(occurrenceId("series-a", "2026-02-03"), "series-a:2026-02-03");
});

test("tasks retain a trimmed title and independent date-only deadline", () => {
  assert.deepEqual(createTask("t1", " Plan ", "2026-02-03"), {
    id: "t1", title: "Plan", deadline: "2026-02-03"
  });
  assert.throws(() => createTask("t1", " "));
  assert.throws(() => createTask("t1", "Plan", "2026-02-30"));
});

test("work blocks require a positive explicit-zone ISO instant and may link a task", () => {
  assert.deepEqual(createWorkBlock("b1", "2026-02-03T09:00:00+05:30", "2026-02-03T10:00:00+05:30", "t1"), {
    id: "b1", start: "2026-02-03T09:00:00+05:30", end: "2026-02-03T10:00:00+05:30", taskId: "t1"
  });
  for (const value of ["2026-02-03T09:00:00", "2026-02-30T09:00:00Z", "2026-02-03T24:00:00Z", "2026-02-03T09:00:00+24:00"]) {
    assert.throws(() => createWorkBlock("b1", value, "2026-03-31T10:00:00Z"), /ISO/);
  }
  assert.throws(() => createWorkBlock("b1", "2026-02-03T10:00:00Z", "2026-02-03T10:00:00Z"), /positive/);
  assert.throws(() => createWorkBlock("b1", "2026-02-03T11:00:00Z", "2026-02-03T10:00:00Z"), /positive/);
});

test("daily expansion stays inside its bounded UTC date range", () => {
  assert.deepEqual(expandOccurrences({ seriesId: "d", frequency: "daily", anchorDate: "2026-02-01" }, "2026-02-02", "2026-02-03"), [
    { id: "d:2026-02-02", date: "2026-02-02" }, { id: "d:2026-02-03", date: "2026-02-03" }
  ]);
});

test("a completion is an independent record for only one occurrence", () => {
  const recurrence = { seriesId: "d", frequency: "daily" as const, anchorDate: "2026-02-01" };
  const occurrences = expandOccurrences(recurrence, "2026-02-01", "2026-02-02");
  const completion = createOccurrenceCompletion(occurrences[0].id, "2026-02-01T12:00:00.123Z");
  assert.deepEqual(completion, { occurrenceId: "d:2026-02-01", completedAt: "2026-02-01T12:00:00.123Z" });
  assert.notEqual(completion.occurrenceId, occurrences[1].id);
  assert.deepEqual(recurrence, { seriesId: "d", frequency: "daily", anchorDate: "2026-02-01" });
  assert.throws(() => createOccurrenceCompletion("bad-id", "2026-02-01T12:00:00Z"));
});

test("expansion rejects a recurrence frequency that is not daily, weekly or monthly", () => {
  const invalid = { seriesId: "x", frequency: "yearly", anchorDate: "2026-02-01" } as unknown as Recurrence;
  assert.throws(() => expandOccurrences(invalid, "2026-02-01", "2026-02-08"), /frequency/);
});

test("weekly expansion aligns to its anchor, not the lower bound", () => {
  assert.deepEqual(expandOccurrences({ seriesId: "w", frequency: "weekly", anchorDate: "2026-02-01" }, "2026-02-03", "2026-02-17").map(({ date }) => date), [
    "2026-02-08", "2026-02-15"
  ]);
  assert.deepEqual(expandOccurrences({ seriesId: "old", frequency: "weekly", anchorDate: "1900-01-01" }, "2026-02-03", "2026-02-17").map(({ date }) => date), [
    "2026-02-09", "2026-02-16"
  ]);
  assert.throws(() => expandOccurrences({ seriesId: "w", frequency: "weekly", anchorDate: "2026-02-01" }, "2026-02-02", "2026-02-01"));
  assert.equal(expandOccurrences({ seriesId: "d", frequency: "daily", anchorDate: "2026-01-01" }, "2026-01-01", "2027-01-01").length, 366);
  assert.throws(() => expandOccurrences({ seriesId: "d", frequency: "daily", anchorDate: "2026-01-01" }, "2026-01-01", "2027-01-02"));
});

test("monthly expansion keeps the anchor day and skips months that lack it", () => {
  assert.deepEqual(expandOccurrences({ seriesId: "m", frequency: "monthly", anchorDate: "2026-01-15" }, "2026-01-01", "2026-06-30").map(({ date }) => date), [
    "2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15", "2026-05-15", "2026-06-15"
  ]);
  assert.deepEqual(expandOccurrences({ seriesId: "m", frequency: "monthly", anchorDate: "2026-01-31" }, "2026-01-01", "2026-12-31").map(({ date }) => date), [
    "2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31", "2026-08-31", "2026-10-31", "2026-12-31"
  ]);
  assert.deepEqual(expandOccurrences({ seriesId: "m", frequency: "monthly", anchorDate: "2024-02-29" }, "2024-02-01", "2024-12-31").map(({ date }) => date), [
    "2024-02-29", "2024-03-29", "2024-04-29", "2024-05-29", "2024-06-29", "2024-07-29", "2024-08-29", "2024-09-29", "2024-10-29", "2024-11-29", "2024-12-29"
  ]);
  assert.deepEqual(expandOccurrences({ seriesId: "m", frequency: "monthly", anchorDate: "2024-02-29" }, "2026-01-01", "2026-12-31").map(({ date }) => date), [
    "2026-01-29", "2026-03-29", "2026-04-29", "2026-05-29", "2026-06-29", "2026-07-29", "2026-08-29", "2026-09-29", "2026-10-29", "2026-11-29", "2026-12-29"
  ]);
  assert.equal(expandOccurrences({ seriesId: "m", frequency: "monthly", anchorDate: "2024-02-29" }, "2025-02-01", "2025-02-28").length, 0);
  assert.deepEqual(expandOccurrences({ seriesId: "m", frequency: "monthly", anchorDate: "2024-02-29" }, "2028-01-01", "2028-12-31").map(({ date }) => date)[1], "2028-02-29");
});

test("monthly expansion respects the anchor, the range bounds and the window limit", () => {
  assert.deepEqual(expandOccurrences({ seriesId: "m", frequency: "monthly", anchorDate: "2026-03-31" }, "2026-04-01", "2026-09-30").map(({ date }) => date), [
    "2026-05-31", "2026-07-31", "2026-08-31"
  ]);
  assert.deepEqual(expandOccurrences({ seriesId: "m", frequency: "monthly", anchorDate: "2026-06-15" }, "2026-01-01", "2026-12-31").map(({ date }) => date), [
    "2026-06-15", "2026-07-15", "2026-08-15", "2026-09-15", "2026-10-15", "2026-11-15", "2026-12-15"
  ]);
  assert.equal(expandOccurrences({ seriesId: "m", frequency: "monthly", anchorDate: "2026-01-31" }, "2026-01-01", "2027-01-01").length, 7);
  assert.throws(() => expandOccurrences({ seriesId: "m", frequency: "monthly", anchorDate: "2026-01-01" }, "2026-01-01", "2027-01-02"), /window/);
  assert.throws(() => expandOccurrences({ seriesId: "m", frequency: "monthly", anchorDate: "2026-01-01" }, "2026-02-01", "2026-01-01"));
});
