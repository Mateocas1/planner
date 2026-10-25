import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMIT_DISTANCE_RATIO,
  FLICK_VELOCITY,
  MIN_COMMIT_DISTANCE,
  MOBILE_RADIUS_MAX,
  SCALE_SHRINK,
  SWIPE_SLOP,
  commitDistance,
  createVelocityTracker,
  dragTransform,
  exitDistance,
  exitDurationMs,
  lockDirection,
  progress,
  rubberBand,
  shouldCommit,
  sheetRadius,
  sheetScale,
} from "./swipeDismiss.ts";

test("lockDirection stays null inside the slop and locks to the axis that gets there first", () => {
  assert.equal(lockDirection(0, 0), null);
  assert.equal(lockDirection(4, 4), null);
  assert.equal(lockDirection(SWIPE_SLOP - 1, 0), null);
  assert.equal(lockDirection(0, SWIPE_SLOP - 1), null);
  // Horizontal wins ties: dismissing is far more common than scrolling.
  assert.equal(lockDirection(SWIPE_SLOP, SWIPE_SLOP), "right");
  assert.equal(lockDirection(-SWIPE_SLOP, SWIPE_SLOP), "left");
  assert.equal(lockDirection(SWIPE_SLOP, -SWIPE_SLOP), "right");
  assert.equal(lockDirection(0, SWIPE_SLOP), "down");
  assert.equal(lockDirection(0, -SWIPE_SLOP), "up");
  assert.equal(lockDirection(SWIPE_SLOP + 10, 2), "right");
  assert.equal(lockDirection(2, SWIPE_SLOP + 10), "down");
});

test("commitDistance is a fraction of the sheet size with a floor", () => {
  assert.equal(commitDistance(400), 400 * COMMIT_DISTANCE_RATIO);
  assert.ok(commitDistance(100) >= MIN_COMMIT_DISTANCE);
  assert.equal(commitDistance(100), MIN_COMMIT_DISTANCE);
});

test("progress clamps to 0..1 against the commit distance", () => {
  assert.equal(progress(0, 400), 0);
  assert.equal(progress(-5, 400), 0);
  assert.equal(progress(commitDistance(400), 400), 1);
  assert.equal(progress(10_000, 400), 1);
  assert.ok(progress(commitDistance(400) / 2, 400) > 0.49 && progress(commitDistance(400) / 2, 400) < 0.51);
});

test("rubberBand follows 1:1 at the start, resists, and never passes its limit", () => {
  const dimension = 400;
  const limit = dimension * 0.55;
  // Slope 1 at the origin: the sheet is attached to the finger at first.
  assert.ok(rubberBand(2, dimension) <= 2);
  assert.ok(rubberBand(2, dimension) > 1.9);
  // Monotonically increasing, concave: equal 40 px spans gain less the further out.
  assert.ok(rubberBand(20, dimension) < rubberBand(60, dimension));
  assert.ok(rubberBand(60, dimension) - rubberBand(20, dimension) > rubberBand(100, dimension) - rubberBand(60, dimension));
  // The asymptote: a huge drag approaches but never reaches the limit.
  assert.ok(rubberBand(10_000, dimension) < limit);
  assert.ok(rubberBand(1_000_000, dimension) > limit * 0.99);
  // Nothing dragged downward past the start bands back below zero.
  assert.equal(rubberBand(0, dimension), 0);
  assert.equal(rubberBand(-5, dimension), 0);
});

test("sheetScale shrinks slightly with progress and clamps", () => {
  assert.equal(sheetScale(0), 1);
  assert.equal(sheetScale(1), 1 - SCALE_SHRINK);
  assert.equal(sheetScale(2), 1 - SCALE_SHRINK);
  assert.equal(sheetScale(-1), 1);
  assert.ok(sheetScale(0.5) > sheetScale(1));
  assert.ok(sheetScale(0.5) < 1);
});

test("sheetRadius grows from the resting radius toward the mobile ceiling", () => {
  // A full-viewport sheet (S1: radius 0) rounds from 0 to the top of the band.
  assert.equal(sheetRadius(0, 0), 0);
  assert.equal(sheetRadius(0, 1), MOBILE_RADIUS_MAX);
  assert.ok(sheetRadius(0, 1) >= 24 && sheetRadius(0, 1) <= 28);
  // The phone sheets rest at --r-sheet (26 px) and only gain the last curvature.
  assert.ok(sheetRadius(26, 1) > 26);
  assert.equal(sheetRadius(26, 0), 26);
  // Clamped.
  assert.equal(sheetRadius(26, 5), MOBILE_RADIUS_MAX);
  assert.equal(sheetRadius(26, -1), 26);
});

test("shouldCommit on distance past the threshold or a same-direction flick", () => {
  const dimension = 400;
  const threshold = commitDistance(dimension);
  // Distance gate.
  assert.equal(shouldCommit(threshold - 1, 0, dimension), false);
  assert.equal(shouldCommit(threshold, 0, dimension), true);
  // Flick gate: short but fast, in the drag's direction.
  assert.equal(shouldCommit(30, FLICK_VELOCITY, dimension), true);
  assert.equal(shouldCommit(30, FLICK_VELOCITY - 0.01, dimension), false);
  // A flick from inside the slop is a tap, not a throw.
  assert.equal(shouldCommit(10, 5, dimension), false);
  // A release decelerating against the drag never commits by velocity.
  assert.equal(shouldCommit(30, -FLICK_VELOCITY, dimension), false);
  assert.equal(shouldCommit(30, 0, dimension), false);
});

test("exitDurationMs inherits the release velocity and clamps to the budget", () => {
  // A flick at 2 px/ms over 300 px: 150 ms, straight from the velocity.
  assert.equal(exitDurationMs(300, 2), 150);
  // A dead release still leaves at MIN_EXIT_SPEED, clamped to the max budget.
  assert.equal(exitDurationMs(10_000, 0), 300);
  // Tiny remaining distance never drops below the floor.
  assert.equal(exitDurationMs(1, 5), 120);
});

test("exitDistance reaches fully outside the viewport along the locked direction", () => {
  const rect = { left: 300, top: 100, width: 400, height: 500 };
  const vw = 1280;
  const vh = 800;
  assert.equal(exitDistance("left", rect, vw, vh), 700); // left + width
  assert.equal(exitDistance("right", rect, vw, vh), 980); // vw - left
  assert.equal(exitDistance("down", rect, vw, vh), 700); // vh - top
});

test("dragTransform is one composited string, never four props", () => {
  assert.equal(dragTransform(-120, 0, 0.97), "translate(-120px, 0px) scale(0.97, 0.97)");
});

test("velocityTracker reports velocity over its window and resets cleanly", () => {
  const tracker = createVelocityTracker(100);
  assert.equal(tracker.velocity("x"), 0);
  tracker.add(0, 0, 0);
  tracker.add(50, 0, 50);
  // Inside the window: 50 px over 50 ms.
  assert.equal(tracker.velocity("x"), 1);
  tracker.add(90, 0, 100);
  // The 0 ms sample is still inside the window (cutoff is exclusive): 90 px over 100 ms.
  assert.equal(tracker.velocity("x"), 0.9);
  tracker.add(95, 0, 140);
  // The 0 ms sample aged out of the 100 ms window: 95-50 px over 140-50 ms.
  assert.equal(tracker.velocity("x"), (95 - 50) / 90);
  tracker.reset();
  assert.equal(tracker.velocity("x"), 0);
  // A single sample has no velocity.
  tracker.add(5, 5, 10);
  assert.equal(tracker.velocity("y"), 0);
});
