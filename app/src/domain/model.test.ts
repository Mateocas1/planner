import assert from "node:assert/strict";
import test from "node:test";
import { ASSUMED_ESTIMATE_MINUTES, MAX_ACTUAL_MINUTES, blockFields, createOccurrenceCompletion, createTask, createWorkBlock, estimateNote, expandOccurrences, formatEstimate, occurrenceId, parseActualMinutes, parseBlock, parseEstimate, requireActualMinutes, type Recurrence } from "./model.ts";

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

test("a task estimate is a whole number of minutes between 5 and 1440", () => {
  // the boundaries are inclusive: five minutes is the shortest estimate the
  // product accepts, a whole day the longest
  assert.deepEqual(createTask("t1", "Plan", undefined, 5), { id: "t1", title: "Plan", estimate: 5 });
  assert.deepEqual(createTask("t1", "Plan", "2026-02-03", 1440), { id: "t1", title: "Plan", deadline: "2026-02-03", estimate: 1440 });
  // no estimate stays absent, which is what every document written before it existed looks like
  assert.deepEqual(createTask("t1", "Plan"), { id: "t1", title: "Plan" });
  assert.deepEqual(createTask("t1", "Plan", "2026-02-03"), { id: "t1", title: "Plan", deadline: "2026-02-03" });
  for (const estimate of [0, 4, 1441, 4.5, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => createTask("t1", "Plan", undefined, estimate), /estimate/);
  }
  // a numeric string is not coerced: the stored field is a number or it is absent
  assert.throws(() => createTask("t1", "Plan", undefined, "60" as never), /estimate/);
});

test("a stored estimate reads back only when it is a valid whole number of minutes", () => {
  assert.equal(parseEstimate(45), 45);
  assert.equal(parseEstimate(5), 5);
  assert.equal(parseEstimate(1440), 1440);
  for (const value of [undefined, null, 0, 4, 1441, 4.5, "45", Number.NaN]) {
    assert.equal(parseEstimate(value), undefined);
  }
});

test("an estimate reads human, and a task without one shows the 60-minute assumption", () => {
  assert.equal(formatEstimate(60), "1h");
  assert.equal(formatEstimate(45), "45 min");
  assert.equal(formatEstimate(90), "1h 30m");
  assert.equal(formatEstimate(1440), "24h");
  // the copy the product shows for a task with no estimate of its own
  assert.equal(ASSUMED_ESTIMATE_MINUTES, 60);
  assert.equal(estimateNote(undefined), "Assumed 1h");
  assert.equal(estimateNote(45), "45 min");
  assert.equal(estimateNote(90), "1h 30m");
});

test("recorded minutes are a whole, non-negative count that a document may omit", () => {
  // what the focus timer accumulates: whole minutes only, because the stored
  // field is an integer counter incremented by Firestore, never a fraction
  assert.equal(requireActualMinutes(20), 20);
  assert.equal(requireActualMinutes(0), 0);
  assert.equal(requireActualMinutes(MAX_ACTUAL_MINUTES), MAX_ACTUAL_MINUTES);
  for (const minutes of [-1, 4.5, 999_999_999, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => requireActualMinutes(minutes), /actual/);
  }
  // a numeric string is not coerced: the stored field is a number or it is absent
  assert.throws(() => requireActualMinutes("20" as never), /actual/);

  assert.equal(parseActualMinutes(20), 20);
  assert.equal(parseActualMinutes(0), 0);
  // a task written before tracking existed carries no count, and a hand-edited
  // document holding junk reads as absent rather than breaking the surface
  for (const value of [undefined, null, -5, 12.5, "20", Number.NaN, MAX_ACTUAL_MINUTES + 1]) {
    assert.equal(parseActualMinutes(value), undefined);
  }
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

test("a work block may carry a title and its Google import source, both validated", () => {
  const source = { provider: "gcal" as const, calendarId: "primary", eventId: "evt1", updated: "2026-10-20T12:00:00.000Z" };
  assert.deepEqual(
    createWorkBlock("b1", "2026-02-03T09:00:00+05:30", "2026-02-03T10:00:00+05:30", undefined, { title: " Plan ", source }),
    { id: "b1", start: "2026-02-03T09:00:00+05:30", end: "2026-02-03T10:00:00+05:30", title: "Plan", source },
  );
  assert.deepEqual(
    createWorkBlock("b1", "2026-02-03T09:00:00Z", "2026-02-03T10:00:00Z", "t1", { title: "Plan", source: { ...source, recurringEventId: "series" } }),
    { id: "b1", start: "2026-02-03T09:00:00Z", end: "2026-02-03T10:00:00Z", taskId: "t1", title: "Plan", source: { ...source, recurringEventId: "series" } },
  );
  // Absent optional fields stay absent, which is what an old stored block looks like.
  assert.deepEqual(createWorkBlock("b1", "2026-02-03T09:00:00Z", "2026-02-03T10:00:00Z"), {
    id: "b1", start: "2026-02-03T09:00:00Z", end: "2026-02-03T10:00:00Z"
  });
  assert.deepEqual(createWorkBlock("b1", "2026-02-03T09:00:00Z", "2026-02-03T10:00:00Z", undefined, { source }), {
    id: "b1", start: "2026-02-03T09:00:00Z", end: "2026-02-03T10:00:00Z", source
  });
  for (const title of ["", "   "]) {
    assert.throws(() => createWorkBlock("b1", "2026-02-03T09:00:00Z", "2026-02-03T10:00:00Z", undefined, { title }), /title/);
  }
  const bad = [
    { ...source, provider: "other" },
    { ...source, calendarId: "" },
    { ...source, eventId: "" },
    { ...source, eventId: "a/b" },
    { ...source, updated: "2026-10-20T12:00:00" },
    { ...source, updated: "" },
    { ...source, recurringEventId: "" },
  ];
  for (const source of bad) {
    assert.throws(() => createWorkBlock("b1", "2026-02-03T09:00:00Z", "2026-02-03T10:00:00Z", undefined, { source: source as never }), /source/);
  }
});

test("a stored block round-trips through its document fields, title and source included", () => {
  const source = { provider: "gcal" as const, calendarId: "primary", eventId: "evt1", updated: "2026-10-20T12:00:00.000Z", recurringEventId: "series" };
  const block = createWorkBlock("b1", "2026-02-03T09:00:00+05:30", "2026-02-03T10:00:00+05:30", undefined, { title: "Plan", source });
  const stored = blockFields(block);
  assert.deepEqual(stored, {
    start: "2026-02-03T09:00:00+05:30",
    end: "2026-02-03T10:00:00+05:30",
    title: "Plan",
    source,
  });
  // What undo restores is the document that was deleted, field for field.
  assert.deepEqual(parseBlock("b1", stored), block);
  // A document written before titles and sources existed still reads, unchanged.
  const legacy = { start: "2026-02-03T09:00:00Z", end: "2026-02-03T10:00:00Z" };
  assert.deepEqual(parseBlock("b2", legacy), { id: "b2", start: legacy.start, end: legacy.end });
  assert.deepEqual(blockFields(parseBlock("b2", { ...legacy, taskId: "t1" })), { ...legacy, taskId: "t1" });
  // A malformed optional field is dropped, never handed to a surface as is.
  assert.deepEqual(parseBlock("b3", { ...legacy, title: "", source: { provider: "gcal", calendarId: "" } }), { id: "b3", start: legacy.start, end: legacy.end });
  assert.deepEqual(parseBlock("b4", { ...legacy, source: { provider: "other", calendarId: "c", eventId: "e", updated: "2026-10-20T12:00:00Z" } }), { id: "b4", start: legacy.start, end: legacy.end });
});
