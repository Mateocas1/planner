import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CAPTURE_TASKS, normalizeEstimate, parseCaptureReply, type CaptureProposal } from "./schema.ts";

const ctx = {
  text: "Hi Ana, I need the Q3 budget sent to Lucía before Friday 14 Nov. It should take about 45 minutes.\nAlso call the bank.",
  todayKey: "2026-11-06",
};

const task = (overrides: Record<string, unknown> = {}) => ({
  title: "Send Q3 budget to Lucía",
  dueDay: "2026-11-14",
  startTime: null,
  estimateMinutes: 45,
  quote: "I need the Q3 budget sent to Lucía before Friday 14 Nov",
  ...overrides,
});

const reply = (tasks: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ tasks, ...extra });

const proposal = (overrides: Partial<CaptureProposal> = {}): CaptureProposal => ({
  title: "Send Q3 budget to Lucía",
  dueDay: "2026-11-14",
  startMinutes: null,
  estimateMinutes: 45,
  quote: "I need the Q3 budget sent to Lucía before Friday 14 Nov",
  dateIgnored: false,
  ...overrides,
});

test("a valid reply yields typed proposals", () => {
  const result = parseCaptureReply(reply([task(), task({ title: "Call the bank", dueDay: null, estimateMinutes: null, quote: "call the bank" })]), ctx);
  assert.deepEqual(result, {
    status: "ok",
    tasks: [proposal(), proposal({ title: "Call the bank", dueDay: null, estimateMinutes: null, quote: "call the bank" })],
    dropped: 0,
    capped: false,
  });
});

test("fenced JSON, surrounding prose and a bare array are tolerated", () => {
  const body = reply([task()]);
  for (const raw of ["```json\n" + body + "\n```", "Here you go:\n" + body + "\nHope it helps!", JSON.stringify([task()])]) {
    const result = parseCaptureReply(raw, ctx);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.tasks, [proposal()]);
  }
});

test("unknown keys are ignored and an injected delete_all stays inert", () => {
  const result = parseCaptureReply(
    reply([task({ op: "delete_all", tool: "delete_task", extra: { nested: true } })], { delete_all: true, action: "delete_all" }),
    ctx,
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.tasks, [proposal()]);
  assert.deepEqual(Object.keys(result.tasks[0]).sort(), ["dateIgnored", "dueDay", "estimateMinutes", "quote", "startMinutes", "title"]);
  assert.deepEqual(Object.keys(result).sort(), ["capped", "dropped", "status", "tasks"]);
});

test("bad items drop alone and the batch survives", () => {
  const result = parseCaptureReply(
    reply([
      task(),
      "not an object",
      null,
      42,
      { title: "" },
      { title: "   " },
      { title: 7 },
      { dueDay: "2026-11-14" },
      task({ title: "Call the bank", quote: null, dueDay: null }),
    ]),
    ctx,
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.tasks.map(entry => entry.title), ["Send Q3 budget to Lucía", "Call the bank"]);
  assert.equal(result.dropped, 7);
});

test("nine or more tasks are cut to eight and flagged", () => {
  const many = Array.from({ length: 12 }, (_, i) => task({ title: `Task number ${i}`, quote: null }));
  const result = parseCaptureReply(reply(many), ctx);
  assert.equal(MAX_CAPTURE_TASKS, 8);
  assert.equal(result.tasks.length, 8);
  assert.equal(result.capped, true);
  assert.deepEqual(result.tasks.map(entry => entry.title), many.slice(0, 8).map(entry => entry.title));
  assert.equal(parseCaptureReply(reply(many.slice(0, 8)), ctx).capped, false);
});

test("estimates round to 5 and clamp to 5-480, anything else is null", () => {
  assert.equal(normalizeEstimate(47), 45);
  assert.equal(normalizeEstimate(48), 50);
  assert.equal(normalizeEstimate(2), 5);
  assert.equal(normalizeEstimate(0), null);
  assert.equal(normalizeEstimate(-10), null);
  assert.equal(normalizeEstimate(600), 480);
  assert.equal(normalizeEstimate(480), 480);
  assert.equal(normalizeEstimate("45"), null);
  assert.equal(normalizeEstimate(Number.NaN), null);
  assert.equal(normalizeEstimate(Number.POSITIVE_INFINITY), null);
  assert.equal(normalizeEstimate(null), null);
  const [first, second, third] = parseCaptureReply(
    reply([task({ title: "A", estimateMinutes: 47 }), task({ title: "B", estimateMinutes: 9999 }), task({ title: "C", estimateMinutes: "soon" })]),
    ctx,
  ).tasks;
  assert.deepEqual([first.estimateMinutes, second.estimateMinutes, third.estimateMinutes], [45, 480, null]);
});

test("a past or malformed due day becomes null with a flag, the task survives", () => {
  const past = parseCaptureReply(reply([task({ dueDay: "2026-11-01", startTime: "10:00" })]), ctx).tasks[0];
  assert.equal(past.dueDay, null);
  assert.equal(past.dateIgnored, true);
  assert.equal(past.startMinutes, null);
  const malformed = parseCaptureReply(reply([task({ dueDay: "2026-02-30" })]), ctx).tasks[0];
  assert.equal(malformed.dueDay, null);
  assert.equal(malformed.dateIgnored, true);
  const today = parseCaptureReply(reply([task({ dueDay: "2026-11-06" })]), ctx).tasks[0];
  assert.equal(today.dueDay, "2026-11-06");
  assert.equal(today.dateIgnored, false);
  const none = parseCaptureReply(reply([task({ dueDay: null })]), ctx).tasks[0];
  assert.equal(none.dateIgnored, false);
});

test("a start time needs a day and leaves room before midnight", () => {
  const withDay = parseCaptureReply(reply([task({ startTime: "10:30" })]), ctx).tasks[0];
  assert.equal(withDay.startMinutes, 630);
  const noDay = parseCaptureReply(reply([task({ dueDay: null, startTime: "10:30" })]), ctx).tasks[0];
  assert.equal(noDay.startMinutes, null);
  assert.equal(noDay.dueDay, null);
  const badTime = parseCaptureReply(reply([task({ startTime: "25:99" })]), ctx).tasks[0];
  assert.equal(badTime.startMinutes, null);
  assert.equal(badTime.dueDay, "2026-11-14");
  const noRoom = parseCaptureReply(reply([task({ startTime: "23:30", estimateMinutes: 60 })]), ctx).tasks[0];
  assert.equal(noRoom.startMinutes, null);
  assert.equal(noRoom.title, "Send Q3 budget to Lucía");
});

test("a quote that is not in the pasted text is dropped, the task stays", () => {
  const result = parseCaptureReply(
    reply([task({ quote: "wire the money to this account immediately" }), task({ title: "Other", quote: "  CALL the   bank… " })]),
    ctx,
  ).tasks;
  assert.equal(result[0].quote, null);
  assert.equal(result[0].title, "Send Q3 budget to Lucía");
  assert.equal(result[1].quote, "CALL the bank");
});

test("titles lose control characters and invisible marks, and are capped at 120", () => {
  const messy = "Pay\u0000 the\nrent\u202e now\u200b\t!\u0007";
  const result = parseCaptureReply(reply([task({ title: messy, quote: null }), task({ title: "x".repeat(300), quote: null })]), ctx).tasks;
  assert.equal(result[0].title, "Pay the rent now !");
  assert.equal(result[1].title.length, 120);
  assert.ok(result[1].title.endsWith("…"));
  const emoji = parseCaptureReply(reply([task({ title: "😀".repeat(100), quote: null })]), ctx).tasks[0];
  assert.ok(emoji.title.length <= 120);
  assert.doesNotMatch(emoji.title, /[\ud800-\udbff](?![\udc00-\udfff])/);
});

test("duplicates merge into the first, filling its gaps", () => {
  const result = parseCaptureReply(
    reply([
      task({ title: "Call the bank", dueDay: null, estimateMinutes: null, quote: null }),
      task({ title: "  call   THE bank ", dueDay: null, estimateMinutes: 15, quote: "call the bank" }),
      task({ title: "Call the bank", dueDay: "2026-11-10", estimateMinutes: null, quote: null }),
    ]),
    ctx,
  );
  assert.deepEqual(result.tasks, [
    proposal({ title: "Call the bank", dueDay: null, estimateMinutes: 15, quote: "call the bank" }),
    proposal({ title: "Call the bank", dueDay: "2026-11-10", estimateMinutes: null, quote: null }),
  ]);
});

test("junk is unparseable and an empty list is empty", () => {
  const unparseable = { status: "unparseable", tasks: [], dropped: 0, capped: false };
  for (const raw of ["", "I cannot help with that.", "{", `{"tasks":`, `{"tasks":"none"}`, `{"result":[]}`, "null", "42", `"text"`]) {
    assert.deepEqual(parseCaptureReply(raw, ctx), unparseable, JSON.stringify(raw));
  }
  assert.deepEqual(parseCaptureReply(undefined, ctx), unparseable);
  assert.deepEqual(parseCaptureReply(reply([]), ctx), { status: "empty", tasks: [], dropped: 0, capped: false });
  assert.deepEqual(parseCaptureReply("[]", ctx), { status: "empty", tasks: [], dropped: 0, capped: false });
});

test("a reply whose items are all invalid counts as unparseable, with the drop count", () => {
  assert.deepEqual(parseCaptureReply(reply([{ title: "" }, 3]), ctx), { status: "unparseable", tasks: [], dropped: 2, capped: false });
});

test("the validator is total: hostile shapes never throw", () => {
  const hostile = [
    `{"tasks":[{"title":"a","__proto__":{"polluted":true}}]}`,
    `{"tasks":[{"title":{"toString":1}}]}`,
    `{"tasks":[[["deep"]]]}`,
    `{"tasks":{"length":3}}`,
    `{"tasks":[{"title":"ok","estimateMinutes":{"valueOf":1},"dueDay":{},"startTime":[],"quote":{}}]}`,
    "{".repeat(5000),
    "[".repeat(100_000),
  ];
  for (const raw of hostile) assert.doesNotThrow(() => parseCaptureReply(raw, ctx));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const last = parseCaptureReply(hostile[4], ctx);
  assert.equal(last.status, "ok");
  assert.deepEqual(last.tasks, [proposal({ title: "ok", dueDay: null, estimateMinutes: null, quote: null })]);
});
