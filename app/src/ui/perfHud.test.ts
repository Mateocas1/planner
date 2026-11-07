import assert from "node:assert/strict";
import { test } from "node:test";
import { FrameMeter, dueForRefresh, formatHud, frameStats, readPlannerDiag } from "./perfHud.ts";

test("frameStats of nothing is all zeros", () => {
  assert.deepEqual(frameStats([], 20), { count: 0, p95: 0, over: 0 });
});

test("frameStats takes the nearest-rank p95 and counts intervals strictly over the threshold", () => {
  const intervals = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.deepEqual(frameStats(intervals, 20), { count: 100, p95: 95, over: 80 });
  // Order does not matter and the input is left untouched.
  const shuffled = [16.7, 50, 16.7, 20, 16.7];
  assert.deepEqual(frameStats(shuffled, 20), { count: 5, p95: 50, over: 1 });
  assert.deepEqual(shuffled, [16.7, 50, 16.7, 20, 16.7]);
});

test("FrameMeter derives intervals from frame timestamps and ignores the first frame", () => {
  const meter = new FrameMeter();
  meter.tick(1000);
  assert.deepEqual(meter.snapshot(), { count: 0, p95: 0, over: 0 });
  meter.tick(1016);
  meter.tick(1032);
  meter.tick(1072); // 40 ms frame
  assert.deepEqual(meter.snapshot(), { count: 3, p95: 40, over: 1 });
});

test("FrameMeter drops gaps over a second (hidden or idle page) instead of counting them", () => {
  const meter = new FrameMeter();
  meter.tick(0);
  meter.tick(16);
  meter.tick(5016); // page was hidden
  meter.tick(5032);
  assert.deepEqual(meter.snapshot(), { count: 2, p95: 16, over: 0 });
});

test("FrameMeter keeps a rolling window for p95 but counts slow frames since reset", () => {
  const meter = new FrameMeter(4);
  let t = 0;
  meter.tick(t);
  for (const dt of [30, 30, 10, 10, 10, 10]) meter.tick((t += dt));
  // Window holds the last four intervals; both 30 ms frames are still counted.
  assert.deepEqual(meter.snapshot(), { count: 4, p95: 10, over: 2 });
  meter.reset();
  assert.deepEqual(meter.snapshot(), { count: 0, p95: 0, over: 0 });
  // The first frame after a reset only re-arms the clock.
  meter.tick(t + 500);
  assert.deepEqual(meter.snapshot(), { count: 0, p95: 0, over: 0 });
  meter.tick(t + 516);
  assert.deepEqual(meter.snapshot(), { count: 1, p95: 16, over: 0 });
});

test("dueForRefresh allows at most four updates per second", () => {
  assert.equal(dueForRefresh(1000, 1000), false);
  assert.equal(dueForRefresh(1249, 1000), false);
  assert.equal(dueForRefresh(1250, 1000), true);
  assert.equal(dueForRefresh(1000, Number.NEGATIVE_INFINITY), true);
});

test("formatHud prints p95 to one decimal and the slow-frame tally", () => {
  assert.equal(formatHud({ count: 120, p95: 17.24, over: 3 }), "p95 17.2 ms · >20 ms: 3 (since reset)");
  assert.equal(formatHud({ count: 0, p95: 0, over: 0 }), "p95 – · >20 ms: 0 (since reset)");
});

test("readPlannerDiag defaults to guard on, flat glass, no HUD", () => {
  assert.deepEqual(readPlannerDiag({}), { guard: "on", glass: "flat", fps: false });
  assert.deepEqual(readPlannerDiag({ __PLANNER_DIAG__: null }), { guard: "on", glass: "flat", fps: false });
});

test("readPlannerDiag accepts only the known values", () => {
  assert.deepEqual(readPlannerDiag({ __PLANNER_DIAG__: { guard: "off", glass: "blur", fps: true } }), {
    guard: "off",
    glass: "blur",
    fps: true,
  });
  assert.deepEqual(readPlannerDiag({ __PLANNER_DIAG__: { guard: "nope", glass: "<b>", fps: "1" } }), {
    guard: "on",
    glass: "flat",
    fps: false,
  });
  assert.deepEqual(readPlannerDiag({ __PLANNER_DIAG__: "off" }), { guard: "on", glass: "flat", fps: false });
});
