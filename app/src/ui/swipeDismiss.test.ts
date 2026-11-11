import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMIT_DISTANCE_RATIO,
  FLICK_VELOCITY,
  MIN_COMMIT_DISTANCE,
  MOBILE_RADIUS_MAX,
  SCALE_SHRINK,
  SWIPE_SLOP,
  VELOCITY_STALE_MS,
  commitDistance,
  createVelocityTracker,
  dominantDirection,
  dragTransform,
  exitDurationMs,
  exitVector,
  progress,
  releaseDirection,
  rubberBand,
  shouldCommit,
  shouldDismiss,
  sheetRadius,
  sheetScale,
} from "./swipeDismiss.ts";

test("dominantDirection stays null inside the slop and picks the larger component's sector", () => {
  assert.equal(dominantDirection(0, 0), null);
  assert.equal(dominantDirection(4, 4), null);
  assert.equal(dominantDirection(SWIPE_SLOP - 1, 0), null);
  assert.equal(dominantDirection(0, SWIPE_SLOP - 1), null);
  // Horizontal wins ties below the horizontal axis; an exact diagonal-up
  // tie is the up sector: a ±45° up-left/up-right release never dismisses.
  assert.equal(dominantDirection(SWIPE_SLOP, SWIPE_SLOP), "right");
  assert.equal(dominantDirection(-SWIPE_SLOP, SWIPE_SLOP), "left");
  assert.equal(dominantDirection(SWIPE_SLOP, -SWIPE_SLOP), "up");
  assert.equal(dominantDirection(-SWIPE_SLOP, -SWIPE_SLOP), "up");
  assert.equal(dominantDirection(0, SWIPE_SLOP), "down");
  assert.equal(dominantDirection(0, -SWIPE_SLOP), "up");
  assert.equal(dominantDirection(SWIPE_SLOP + 10, 2), "right");
  assert.equal(dominantDirection(2, SWIPE_SLOP + 10), "down");
});

test("releaseDirection reads 45° sectors of the release vector: up is within ±45° of straight up", () => {
  // The up sector: the vertical component strictly dominates.
  assert.equal(releaseDirection(-10, -100), "up");
  assert.equal(releaseDirection(10, -100), "up");
  assert.equal(releaseDirection(0, -1), "up");
  // Exactly on the ±45° boundary the up sector wins (finding 5): an exact
  // diagonal-up release must never read as dismissible.
  assert.equal(releaseDirection(100, -100), "up");
  assert.equal(releaseDirection(-100, -100), "up");
  // The dismissible sectors.
  assert.equal(releaseDirection(-200, 120), "left");
  assert.equal(releaseDirection(200, 120), "right");
  assert.equal(releaseDirection(120, 200), "down");
});

test("shouldDismiss: a diagonal down-left release past the threshold dismisses", () => {
  const width = 400;
  const height = 600;
  // Dominant left, 200 px of travel against a 140 px threshold.
  assert.equal(shouldDismiss(-200, 120, 0, 0, width, height), true);
  // Dominant down (the travel that decides is the vertical one).
  assert.equal(shouldDismiss(-120, 250, 0, 0, width, height), true);
  // Diagonal down-right dismisses the same way.
  assert.equal(shouldDismiss(200, 120, 0, 0, width, height), true);
});

test("shouldDismiss: an up-dominant release never dismisses", () => {
  const width = 400;
  const height = 600;
  // Far past every distance threshold, and even with a violent flick behind
  // it: the up sector is not dismissible.
  assert.equal(shouldDismiss(0, -400, 0, -5, width, height), false);
  assert.equal(shouldDismiss(-100, -300, -2, -5, width, height), false);
  // An exact ±45° up-left diagonal is the up sector too: never dismisses,
  // whatever flick sits behind it.
  assert.equal(shouldDismiss(-100, -100, 0, 0, width, height), false);
  assert.equal(shouldDismiss(-100, -100, -3, -3, width, height), false);
  // Down-ties stay horizontal, where dismissing is the common intent.
  assert.equal(shouldDismiss(-300, 100, 0, 0, width, height), true);
});

test("shouldDismiss: a short diagonal snaps back", () => {
  const width = 400;
  const height = 600;
  // Slow, short, no flick: below both gates on the dominant axis.
  assert.equal(shouldDismiss(-50, 30, 0, 0, width, height), false);
  assert.equal(shouldDismiss(30, -50, 0, 0, width, height), false);
  // A flick on a short diagonal commits (the flick gate, unchanged).
  assert.equal(shouldDismiss(-60, 40, -2, 1, width, height), true);
  // A flick pointing against the drag is a pull-back, not a throw.
  assert.equal(shouldDismiss(-60, 40, 2, -1, width, height), false);
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
  // A full-viewport sheet (radius 0) rounds from 0 to the top of the band.
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

test("exitVector flies fully outside the viewport along the release vector", () => {
  const rect = { left: 300, top: 100, width: 400, height: 500 };
  const vw = 1280;
  const vh = 800;
  // Axis-aligned releases reduce to the old per-axis exit distances.
  assert.deepEqual(exitVector(-100, 0, rect, vw, vh), { x: -800, y: 0, distance: 700 });
  assert.deepEqual(exitVector(100, 0, rect, vw, vh), { x: 1080, y: 0, distance: 980 });
  assert.deepEqual(exitVector(0, 100, rect, vw, vh), { x: 0, y: 800, distance: 700 });
  // A 3-4-5 up-left vector: the sheet is fully outside once it clears ANY
  // one edge, so the flight ends at the smaller per-axis clearance -- the
  // left run (700 / 0.8 = 875) beats the vertical rise (600 / 0.6 = 1000).
  const upLeft = exitVector(-4, -3, rect, vw, vh);
  assert.ok(Math.abs(upLeft.distance - 875) < 1e-9);
  assert.ok(Math.abs(upLeft.x - -704) < 1e-6 && Math.abs(upLeft.y - -528) < 1e-6);
  assert.ok(rect.left + upLeft.x + rect.width <= 0, "fully past the left edge");
  // A 3-4-5 down-left vector: same rule, the left run (875) is shorter than
  // the down run (700 / 0.6 ≈ 1167).
  const downLeft = exitVector(-4, 3, rect, vw, vh);
  assert.equal(downLeft.distance, Math.min(700 / 0.8, 700 / 0.6));
  assert.ok(rect.left + downLeft.x + rect.width <= 0, "fully past the left edge");
});

test("exitVector takes the smallest clearance: a near-vertical release does not explode", () => {
  // A phone at rest (390×844 viewport, sheet filling it). Finding 1: the old
  // largest-t exit flew ~78,000 px for a (1,200) release, leaving after ~1%
  // of the flight -- the sheet is gone once it clears ANY edge, so the
  // vertical clearance is the whole flight.
  const rect = { left: 0, top: 0, width: 390, height: 844 };
  const vw = 390;
  const vh = 844;

  const near = exitVector(1, 200, rect, vw, vh);
  const nearUy = 200 / Math.hypot(1, 200);
  const nearClearance = vh / nearUy;
  // The exit distance is at most the vertical clearance along the vector.
  assert.ok(near.distance <= nearClearance + 1e-9, `distance ${near.distance} ≤ vertical clearance ${nearClearance}`);
  assert.ok(near.distance < 1000, `no explosion: ${near.distance}px, was ~78,000 before the fix`);
  // ...and the sheet really ends fully below the viewport.
  assert.ok(rect.top + near.y >= vh, "fully past the bottom edge");

  const near2 = exitVector(20, 200, rect, vw, vh);
  const near2Uy = 200 / Math.hypot(20, 200);
  const near2Clearance = vh / near2Uy;
  assert.ok(near2.distance <= near2Clearance + 1e-9, `distance ${near2.distance} ≤ vertical clearance ${near2Clearance}`);
  assert.ok(near2.distance < 1000, `no explosion: ${near2.distance}px, was ~3,900 before the fix`);
  assert.ok(rect.top + near2.y >= vh, "fully past the bottom edge");

  // The implied exit speed stays within ~2× the release speed: with the old
  // exploded distance the sheet left after ~3 ms of a ~1.4 s flight.
  const releaseSpeed = 2; // px/ms, a solid flick
  for (const exit of [near, near2]) {
    const implied = exit.distance / exitDurationMs(exit.distance, releaseSpeed);
    assert.ok(implied <= 2 * releaseSpeed, `implied ${implied} px/ms ≤ 2× release ${releaseSpeed}`);
  }
});

test("dragTransform is one composited string, never four props", () => {
  assert.equal(dragTransform(-120, 0, 0.97), "translate(-120px, 0px) scale(0.97, 0.97)");
});

test("velocityTracker reports velocity over its window and resets cleanly", () => {
  const tracker = createVelocityTracker(100);
  assert.equal(tracker.velocity("x", 0), 0);
  tracker.add(0, 0, 0);
  tracker.add(50, 0, 50);
  // Inside the window: 50 px over 50 ms.
  assert.equal(tracker.velocity("x", 50), 1);
  tracker.add(90, 0, 100);
  // The 0 ms sample is still inside the window (cutoff is exclusive): 90 px over 100 ms.
  assert.equal(tracker.velocity("x", 100), 0.9);
  tracker.add(95, 0, 140);
  // The 0 ms sample aged out of the 100 ms window: 95-50 px over 140-50 ms.
  assert.equal(tracker.velocity("x", 140), (95 - 50) / 90);
  tracker.reset();
  assert.equal(tracker.velocity("x", 140), 0);
  // A single sample has no velocity.
  tracker.add(5, 5, 10);
  assert.equal(tracker.velocity("y", 10), 0);
});

test("a flick followed by a hold releases with velocity 0 (stale samples)", () => {
  const tracker = createVelocityTracker(100);
  tracker.add(0, 0, 0);
  tracker.add(-30, 0, 15);
  tracker.add(-60, 0, 30); // a fast flick left: -60 px over 30 ms
  assert.equal(tracker.velocity("x", 30), -2);
  // Exactly at the stale bound the flick still counts (strictly greater is stale).
  assert.equal(tracker.velocity("x", 30 + VELOCITY_STALE_MS), -2);
  // One millisecond past it, the pointer had already stopped: no throw.
  assert.equal(tracker.velocity("x", 30 + VELOCITY_STALE_MS + 1), 0);
  // The 300 ms hold of the hesitant-release rule.
  assert.equal(tracker.velocity("x", 330), 0);
});
