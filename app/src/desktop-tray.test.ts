import assert from "node:assert/strict";
import test from "node:test";
import type { BlockView, TaskView } from "./data/store.ts";
import type { FocusSession } from "./domain/focus.ts";
import {
  NOTHING_UP_NEXT,
  SIGNED_OUT_UP_NEXT,
  TRAY_HEARTBEAT_MS,
  TRAY_PUSH_MIN_GAP_MS,
  focusFraction,
  focusLine,
  liveTrayPayload,
  signedOutTrayPayload,
  trayPushDecision,
  upNextLabel,
  type TrayPayload,
} from "./desktop-tray.ts";

const zone = "UTC";
const iso = (value: string) => Date.parse(value);

function block(id: string, start: string, end: string, taskId?: string): BlockView {
  return { id, start, end, ...(taskId === undefined ? {} : { taskId }), pending: false };
}

function task(id: string, title: string): TaskView {
  return { id, title, completed: false, pending: false };
}

/** A session over 14:00–15:00 on the day every fixture uses. */
function session(over: Partial<FocusSession> = {}): FocusSession {
  return {
    blockId: "b1",
    endAt: iso("2026-10-22T15:00:00Z"),
    startedAt: iso("2026-10-22T14:00:00Z"),
    pausedMs: 0,
    ...over,
  };
}

function payload(over: Partial<TrayPayload> = {}): TrayPayload {
  return { upNext: NOTHING_UP_NEXT, focus: null, progress: null, ...over };
}

const deepWork = task("t1", "Deep work");
const run1400 = block("b1", "2026-10-22T14:00:00Z", "2026-10-22T15:00:00Z", "t1");
const next1600 = block("b2", "2026-10-22T16:00:00Z", "2026-10-22T17:00:00Z", "t1");

test("the running block takes the tray line with its start time", () => {
  const label = upNextLabel([next1600, run1400], [deepWork], zone, iso("2026-10-22T14:30:00Z"));
  assert.equal(label, "Up next: Deep work · 14:00");
});

test("without a running block the line names the next block still to start today", () => {
  const inBetween = upNextLabel([run1400, next1600], [deepWork], zone, iso("2026-10-22T15:30:00Z"));
  assert.equal(inBetween, "Up next: Deep work · 16:00");
  const beforeAll = upNextLabel([run1400, next1600], [deepWork], zone, iso("2026-10-22T13:00:00Z"));
  assert.equal(beforeAll, "Up next: Deep work · 14:00");
});

test("a block with no task keeps the product's word for it", () => {
  const label = upNextLabel([next1600], [], zone, iso("2026-10-22T13:00:00Z"));
  assert.equal(label, "Up next: Work block · 16:00");
});

test("a day with nothing left says so, and tomorrow's block does not count", () => {
  const tomorrow = block("b3", "2026-10-23T09:00:00Z", "2026-10-23T10:00:00Z", "t1");
  assert.equal(upNextLabel([run1400], [deepWork], zone, iso("2026-10-22T20:00:00Z")), NOTHING_UP_NEXT);
  assert.equal(upNextLabel([tomorrow], [deepWork], zone, iso("2026-10-22T20:00:00Z")), NOTHING_UP_NEXT);
});

test("the focus line counts whole minutes, rounding up and never reaching zero", () => {
  assert.equal(focusLine(18 * 60_000), "Focus: 18 min left");
  assert.equal(focusLine(18 * 60_000 + 1), "Focus: 19 min left");
  assert.equal(focusLine(30_000), "Focus: 1 min left");
});

test("the progress fraction is elapsed over the planned span", () => {
  const now = iso("2026-10-22T14:30:00Z");
  assert.equal(focusFraction(session(), now), 0.5);
  assert.equal(focusFraction(session(), iso("2026-10-22T16:00:00Z")), 1);
});

test("a pause freezes the progress fraction where the pause began", () => {
  const paused = session({ pausedAt: iso("2026-10-22T14:40:00Z") });
  const frozen = focusFraction(paused, iso("2026-10-22T14:40:00Z"));
  assert.equal(focusFraction(paused, iso("2026-10-22T14:55:00Z")), frozen);
  assert.ok(frozen > 0.6 && frozen < 0.7);
});

test("the first payload always goes", () => {
  assert.deepEqual(trayPushDecision(null, payload(), 1_000, null), { push: true });
});

test("a changed payload waits out the 10 s gap, and goes once the gap is over", () => {
  const sent = payload({ upNext: "Up next: Deep work · 14:00" });
  const next = payload({ upNext: "Up next: Deep work · 16:00" });
  assert.deepEqual(trayPushDecision(sent, next, 13_000, 10_000), { push: false, retryInMs: 7_000 });
  // Exactly at the boundary the push goes now (the cap is "at most", not "after").
  assert.deepEqual(trayPushDecision(sent, next, 20_000, 10_000), { push: true });
});

test("an unchanged payload outside a session is never resent", () => {
  const sent = payload();
  assert.deepEqual(trayPushDecision(sent, payload(), TRAY_HEARTBEAT_MS + 1, 0), { push: false, retryInMs: null });
});

test("while focus runs an unchanged payload is resent once a minute", () => {
  const running = payload({ focus: "Focus: 18 min left", progress: { status: "normal", fraction: 0.5 } });
  assert.deepEqual(trayPushDecision(running, running, 30_000, 0), { push: false, retryInMs: null });
  assert.deepEqual(trayPushDecision(running, running, TRAY_HEARTBEAT_MS, 0), { push: true });
});

test("no session means no focus line and no taskbar progress", () => {
  const data = { blocks: [run1400], tasks: [deepWork], timeZone: zone, session: null };
  const live = liveTrayPayload(data, iso("2026-10-22T14:30:00Z"));
  assert.equal(live.focus, null);
  assert.equal(live.progress, null);
  assert.equal(live.upNext, "Up next: Deep work · 14:00");
});

test("a running session words the line and marks the bar normal", () => {
  const data = { blocks: [run1400], tasks: [deepWork], timeZone: zone, session: session() };
  const live = liveTrayPayload(data, iso("2026-10-22T14:42:00Z"));
  assert.equal(live.focus, "Focus: 18 min left");
  assert.deepEqual(live.progress, { status: "normal", fraction: 0.7 });
});

test("a finished session drops the line and the bar", () => {
  const data = { blocks: [run1400], tasks: [deepWork], timeZone: zone, session: session() };
  const live = liveTrayPayload(data, iso("2026-10-22T15:00:00Z"));
  assert.equal(live.focus, null);
  assert.equal(live.progress, null);
});

test("a paused session keeps its line and marks the bar paused", () => {
  const data = { blocks: [run1400], tasks: [deepWork], timeZone: zone, session: session({ pausedAt: iso("2026-10-22T14:42:00Z") }) };
  const live = liveTrayPayload(data, iso("2026-10-22T14:42:00Z"));
  assert.equal(live.focus, "Focus: 18 min left");
  assert.equal(live.progress?.status, "paused");
});

test("signing out says so and carries nothing else", () => {
  assert.deepEqual(signedOutTrayPayload(), { upNext: SIGNED_OUT_UP_NEXT, focus: null, progress: null });
});
