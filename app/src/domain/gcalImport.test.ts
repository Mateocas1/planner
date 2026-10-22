import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarKey,
  importDocId,
  importedIds,
  planImport,
  selectHolidayTasks,
  type GcalEvent,
  type ImportPlanInput,
} from "./gcalImport.ts";

const primary = "primary";
const secondary = "abc123@group.calendar.google.com";
const updated = "2026-10-18T10:00:00.000Z";

/** A timed event shaped like the Calendar API's `events.list` items. */
function timed(over: Partial<GcalEvent> = {}): GcalEvent {
  return {
    id: "e1",
    status: "confirmed",
    summary: "Design review",
    updated,
    start: { dateTime: "2026-10-20T14:00:00+02:00", timeZone: "Europe/Madrid" },
    end: { dateTime: "2026-10-20T15:00:00+02:00", timeZone: "Europe/Madrid" },
    ...over,
  };
}

/** An all-day event: `date` values only, `end.date` exclusive. */
function allDay(over: Partial<GcalEvent> = {}): GcalEvent {
  return {
    id: "a1",
    status: "confirmed",
    summary: "Renew passport",
    updated,
    start: { date: "2026-10-27" },
    end: { date: "2026-10-28" },
    ...over,
  };
}

function plan(input: Partial<ImportPlanInput> & { events: GcalEvent[] }): ReturnType<typeof planImport> {
  return planImport({ calendarId: primary, timeZone: "Europe/Madrid", ...input });
}

test("a timed event keeps its offset instant verbatim and carries title and source", () => {
  const result = plan({ events: [timed()] });
  assert.equal(result.blocks.length, 1);
  assert.equal(result.tasks.length, 0);
  const block = result.blocks[0];
  assert.equal(block.id, `gcal_${calendarKey(primary)}_e1`);
  assert.equal(block.start, "2026-10-20T14:00:00+02:00");
  assert.equal(block.end, "2026-10-20T15:00:00+02:00");
  assert.equal(block.title, "Design review");
  assert.deepEqual(block.source, { provider: "gcal", calendarId: primary, eventId: "e1", updated });
  assert.equal(block.taskId, undefined);
  assert.equal(Date.parse(block.start), Date.parse("2026-10-20T12:00:00Z"));
});

test("an event on a DST day is an exact instant, whichever side of the switch it is", () => {
  const springForward = plan({
    events: [
      timed({ id: "before", start: { dateTime: "2026-03-29T01:30:00+01:00" }, end: { dateTime: "2026-03-29T02:30:00+01:00" } }),
      timed({ id: "after", start: { dateTime: "2026-03-29T04:00:00+02:00" }, end: { dateTime: "2026-03-29T05:00:00+02:00" } }),
    ],
  }).blocks;
  assert.deepEqual(springForward.map(block => Date.parse(block.start) - Date.parse(block.end)), [-3_600_000, -3_600_000]);
  assert.equal(Date.parse(springForward[1].start), Date.parse("2026-03-29T02:00:00Z"));
  // Same wall clock on the two sides of the switch is two different instants.
  assert.notEqual(Date.parse(springForward[0].start), Date.parse("2026-03-29T01:30:00Z"));
});

test("a dateTime without an offset is read as wall time in the event's own zone", () => {
  const events = [
    timed({ id: "ny", start: { dateTime: "2026-10-20T09:00:00", timeZone: "America/New_York" }, end: { dateTime: "2026-10-20T10:00:00", timeZone: "America/New_York" } }),
    // No event zone: the profile zone is the fallback.
    timed({ id: "fallback", start: { dateTime: "2026-10-20T09:00:00" }, end: { dateTime: "2026-10-20T10:00:00" } }),
  ];
  const blocks = plan({ events }).blocks;
  assert.equal(blocks[0].start, "2026-10-20T09:00:00-04:00");
  assert.equal(blocks[1].start, "2026-10-20T09:00:00+02:00");
  assert.equal(Date.parse(blocks[0].start), Date.parse("2026-10-20T13:00:00Z"));
});

test("an all-day event becomes a task with that date as its deadline, never a block", () => {
  const result = plan({ events: [allDay()] });
  assert.equal(result.blocks.length, 0);
  assert.equal(result.tasks.length, 1);
  assert.deepEqual(result.tasks[0], { id: `gcal_${calendarKey(primary)}_a1`, title: "Renew passport", deadline: "2026-10-27" });
});

test("a multi-day all-day event is one task dated from its first day", () => {
  const result = plan({ events: [allDay({ id: "trip", summary: "Trip to Lisbon", start: { date: "2026-11-02" }, end: { date: "2026-11-06" } })] });
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].deadline, "2026-11-02");
});

test("cancelled events and events the user declined are skipped and counted", () => {
  const result = plan({
    events: [
      timed({ id: "cancelled", status: "cancelled" }),
      timed({ id: "declined", attendees: [{ self: true, responseStatus: "declined" }] }),
      timed({ id: "tentative", attendees: [{ self: true, responseStatus: "tentative" }] }),
    ],
  });
  assert.deepEqual(result.blocks.map(block => block.source?.eventId), ["tentative"]);
  assert.equal(result.skipped.cancelled, 1);
  assert.equal(result.skipped.declined, 1);
});

test("working location, out of office and focus time events are skipped and counted", () => {
  const result = plan({
    events: [
      allDay({ id: "wfh", summary: "Home", eventType: "workingLocation" }),
      allDay({ id: "ooo", summary: "Vacation", eventType: "outOfOffice" }),
      timed({ id: "focus", summary: "Focus", eventType: "focusTime" }),
      allDay({ id: "default", eventType: "default" }),
    ],
  });
  assert.deepEqual(result.skipped.workingLocation, 1);
  assert.deepEqual(result.skipped.outOfOffice, 1);
  assert.deepEqual(result.skipped.focusTime, 1);
  assert.deepEqual(result.tasks.map(task => task.id), [`gcal_${calendarKey(primary)}_default`]);
});

test("recurring instances are independent blocks that keep their series id", () => {
  const events = [
    timed({ id: "s1_20261020T120000Z", recurringEventId: "s1" }),
    timed({ id: "s1_20261027T120000Z", recurringEventId: "s1", start: { dateTime: "2026-10-27T14:00:00+01:00" }, end: { dateTime: "2026-10-27T15:00:00+01:00" } }),
  ];
  const blocks = plan({ events }).blocks;
  assert.equal(new Set(blocks.map(block => block.id)).size, 2);
  assert.deepEqual(blocks.map(block => block.source?.recurringEventId), ["s1", "s1"]);
  assert.deepEqual(blocks.map(block => block.start), ["2026-10-20T14:00:00+02:00", "2026-10-27T14:00:00+01:00"]);
});

test("re-importing the same events writes nothing", () => {
  const events = [timed(), allDay()];
  const first = plan({ events });
  const second = plan({
    events,
    existing: {
      blockIds: first.blocks.map(block => block.id),
      taskIds: first.tasks.map(task => task.id),
      eventIds: first.blocks.flatMap(block => block.source === undefined ? [] : [block.source.eventId]),
    },
  });
  assert.equal(second.blocks.length, 0);
  assert.equal(second.tasks.length, 0);
  assert.equal(second.skipped.imported, 2);
});

test("an event already imported under another document id is deduped by event id", () => {
  const result = plan({ events: [timed()], existing: { eventIds: ["e1"], blockIds: ["hand-made-doc"] } });
  assert.equal(result.blocks.length, 0);
  assert.equal(result.skipped.imported, 1);
});

test("ids are deterministic per calendar and event, and safe as document ids", () => {
  assert.equal(calendarKey(primary), calendarKey(primary));
  assert.notEqual(calendarKey(primary), calendarKey(secondary));
  assert.equal(importDocId(primary, "e1"), importDocId(primary, "e1"));
  assert.equal(importDocId(primary, "e1"), `gcal_${calendarKey(primary)}_e1`);
  for (const calendarId of [primary, secondary, "me@example.com", "", "../../etc"]) {
    const key = calendarKey(calendarId);
    assert.match(key, /^[a-z0-9][a-z0-9-]*$/, `${calendarId} produced ${key}`);
    assert.ok(key.length <= 40, `${calendarId} produced a ${key.length}-character key`);
    const id = importDocId(calendarId, "e1");
    assert.doesNotMatch(id, /[/.]/);
    assert.ok(id.length < 200);
  }
  // Same events in, same plan out: the ids never depend on ordering or a clock.
  const events = [timed(), allDay()];
  assert.deepEqual(plan({ events }), plan({ events }));
});

test("an item that is not an object is skipped as unusable instead of throwing", () => {
  const junk = [null, 5, "event", ["id"], true] as unknown as GcalEvent[];
  const result = plan({ events: junk });
  assert.deepEqual(result.blocks, []);
  assert.deepEqual(result.tasks, []);
  assert.equal(result.skipped.unusable, junk.length);
});

test("a response whose items are not a list imports nothing and does not throw", () => {
  const result = plan({ events: { items: [{ id: "e1" }] } as unknown as GcalEvent[] });
  assert.deepEqual(result.blocks, []);
  assert.deepEqual(result.tasks, []);
  assert.deepEqual(result.skipped, { cancelled: 0, declined: 0, workingLocation: 0, outOfOffice: 0, focusTime: 0, imported: 0, unusable: 0 });
});

test("a non-string summary is no title, not a crash", () => {
  const result = plan({
    events: [
      timed({ id: "numeric-summary", summary: 5 as unknown as string }),
      timed({ id: "object-summary", summary: { text: "Design review" } as unknown as string }),
    ],
  });
  assert.deepEqual(result.blocks.map(block => block.title), [undefined, undefined]);
  assert.equal(result.skipped.unusable, 0);
});

test("a null attendee entry is not an answer and does not crash the mapper", () => {
  const result = plan({
    events: [
      timed({ id: "null-attendee", attendees: [null] as unknown as GcalEvent["attendees"] }),
      timed({
        id: "among-attendees",
        attendees: [null, { self: true, responseStatus: "declined" }] as unknown as GcalEvent["attendees"],
      }),
    ],
  });
  assert.deepEqual(result.blocks.map(block => block.source?.eventId), ["null-attendee"]);
  assert.equal(result.skipped.declined, 1);
  assert.equal(result.skipped.unusable, 0);
});

test("a null or non-object edge, id or status is unusable, never a crash", () => {
  const result = plan({
    events: [
      timed({ id: "null-start", start: null as unknown as GcalEvent["start"] }),
      timed({ id: "null-end", end: null as unknown as GcalEvent["end"] }),
      timed({ id: "numeric-start", start: 5 as unknown as GcalEvent["start"] }),
      timed({ id: "string-end", end: "2026-10-20T15:00:00+02:00" as unknown as GcalEvent["end"] }),
      timed({ id: 7 as unknown as string }),
      timed({ id: "object-status", status: { value: "confirmed" } as unknown as string }),
    ],
  });
  assert.deepEqual(result.blocks, []);
  assert.equal(result.skipped.unusable, 6);
});

test("events the mapper cannot use are counted, never partially imported", () => {
  const result = plan({
    events: [
      { id: "no-times", summary: "Broken", updated },
      timed({ id: "no-end", end: undefined }),
      timed({ id: "no-updated", updated: undefined }),
      timed({ id: "bad-id/with-slash" }),
      allDay({ id: "untitled", summary: "   " }),
      timed({ id: "bad-zone", start: { dateTime: "2026-10-20T09:00:00", timeZone: "Not/AZone" }, end: { dateTime: "2026-10-20T10:00:00" } }),
    ],
  });
  assert.equal(result.blocks.length, 0);
  assert.equal(result.tasks.length, 0);
  assert.equal(result.skipped.unusable, 6);
});

test("a timed event without a summary is still a block", () => {
  const blocks = plan({ events: [timed({ summary: undefined })] }).blocks;
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].title, undefined);
});

test("imported ids are the gcal blocks and the gcal-prefixed tasks", () => {
  const ids = importedIds(
    [
      { id: "b1", source: { provider: "gcal" } },
      { id: "b2", source: { provider: "other" } },
      { id: "b3" },
    ],
    [{ id: "gcal_primary-1_a1" }, { id: "manual-2" }],
  );
  assert.deepEqual(ids, { blockIds: ["b1"], taskIds: ["gcal_primary-1_a1"] });
});

const holidayCalendar = "es.ar#holiday@group.v.calendar.google.com";

/** An all-day event shaped like Google's holiday-calendar items. */
function holiday(over: Partial<GcalEvent> = {}): GcalEvent {
  return {
    id: "20261207_60o30dr56or30c1g60o30dr4ck",
    status: "confirmed",
    summary: "Puente turístico",
    description: "Día no laborable",
    updated,
    start: { date: "2026-12-07" },
    end: { date: "2026-12-08" },
    ...over,
  };
}

test("an event of a Google holiday calendar becomes a classified day label, never a task or block", () => {
  const result = plan({
    calendarId: holidayCalendar,
    events: [
      holiday(),
      holiday({ id: "20261208_a", summary: "Inmaculada Concepción de María", description: "Feriado", start: { date: "2026-12-08" } }),
      holiday({ id: "20261031_b", summary: "Halloween", description: "Observancia", start: { date: "2026-10-31" } }),
    ],
  });
  assert.equal(result.tasks.length, 0);
  assert.equal(result.blocks.length, 0);
  assert.deepEqual(result.holidays.map(item => [item.date, item.kind, item.title]), [
    ["2026-12-07", "nonWorking", "Puente turístico"],
    ["2026-12-08", "public", "Inmaculada Concepción de María"],
    ["2026-10-31", "observance", "Halloween"],
  ]);
  assert.equal(result.holidays[0].id, `gcal_${calendarKey(holidayCalendar)}_20261207_60o30dr56or30c1g60o30dr4ck`);
  assert.deepEqual(result.holidays[0].source, { provider: "gcal", calendarId: holidayCalendar, eventId: "20261207_60o30dr56or30c1g60o30dr4ck" });
});

test("the same all-day event in a normal calendar is still a task", () => {
  const result = plan({ calendarId: secondary, events: [holiday()] });
  assert.equal(result.holidays.length, 0);
  assert.equal(result.tasks.length, 1);
});

test("holiday re-import is idempotent and an old holiday task does not block the label", () => {
  const first = plan({ calendarId: holidayCalendar, events: [holiday()] });
  const again = plan({ calendarId: holidayCalendar, events: [holiday()], existing: { holidayIds: first.holidays.map(item => item.id) } });
  assert.equal(again.holidays.length, 0);
  assert.equal(again.skipped.imported, 1);
  // An earlier import stored the event as a task: the label is still planned.
  const legacy = plan({ calendarId: holidayCalendar, events: [holiday()], existing: { taskIds: first.holidays.map(item => item.id) } });
  assert.equal(legacy.holidays.length, 1);
  assert.equal(legacy.tasks.length, 0);
});

test("a holiday event without a title or a date is unusable, a cancelled one is skipped", () => {
  const result = plan({
    calendarId: holidayCalendar,
    events: [holiday({ id: "a", summary: "" }), holiday({ id: "b", start: { date: "2026-02-30" } }), holiday({ id: "c", status: "cancelled" })],
  });
  assert.equal(result.holidays.length, 0);
  assert.equal(result.skipped.unusable, 2);
  assert.equal(result.skipped.cancelled, 1);
});

test("cleanup selects only the tasks whose id carries a listed holiday calendar's key", () => {
  const calendars = [{ id: primary }, { id: secondary }, { id: holidayCalendar }, { id: "en.usa#holiday@group.v.calendar.google.com" }];
  const tasks = [
    { id: `gcal_${calendarKey(holidayCalendar)}_20261207_a`, title: "Puente turístico" },
    { id: `gcal_${calendarKey("en.usa#holiday@group.v.calendar.google.com")}_20261225_b`, title: "Christmas Day" },
    // Same title and date as a holiday, but from a normal calendar.
    { id: `gcal_${calendarKey(secondary)}_x1`, title: "Puente turístico" },
    { id: `gcal_${calendarKey(primary)}_a1`, title: "Renew passport" },
    // A user's own task: Firestore-minted id, same title as a holiday.
    { id: "kJ3x9QmZpT0aLw2vB7nC", title: "Puente turístico" },
    // The holiday calendar's key without the separator is not a match.
    { id: `gcal_${calendarKey(holidayCalendar)}x_oops`, title: "No" },
  ];
  assert.deepEqual(selectHolidayTasks(tasks, calendars).map(task => task.id), [tasks[0].id, tasks[1].id]);
  // A holiday calendar the account does not list proves nothing.
  assert.deepEqual(selectHolidayTasks(tasks, [{ id: primary }, { id: secondary }]), []);
  assert.deepEqual(selectHolidayTasks([], calendars), []);
});
