import assert from "node:assert/strict";
import test from "node:test";
import {
  activateDistance,
  commitProgress,
  draggedOffset,
  edgeGuard,
  flickTravel,
  flickVelocity,
  isEdgeGuarded,
  pageTurnDecision,
  pointerVelocity,
  turnProgress,
  velocityWindowMs,
} from "./pageTurn.ts";

/**
 * The page-turn gesture's arithmetic (distinctive roadmap F3, "The page-turn
 * gesture"): a left drag or flick on Today closes the day, anything else puts
 * the page back. The component (ui/PageTurn.tsx) owns the pointer plumbing; it
 * asks this module two questions per release -- did that commit, and where
 * should the page have been under the finger -- so the thresholds can be moved
 * without a browser.
 *
 * No dates, timers or clock: samples carry the pointer's own timestamps.
 */

test("the day turns past 40% of the width and stays put below it", () => {
  const width = 1000;
  // 0.39 of a 1000 px page, released at rest: not enough travel.
  assert.equal(pageTurnDecision({ dx: -390, width, velocity: 0 }), "cancel");
  // 0.41: the page has been carried past the point of no return.
  assert.equal(pageTurnDecision({ dx: -410, width, velocity: 0 }), "commit");
  // Exactly 40% is the boundary, and it commits (>= , not >).
  assert.equal(pageTurnDecision({ dx: -400, width, velocity: 0 }), "commit");
});

test("a fast leftward flick commits well before the distance threshold", () => {
  // 60 px of a 1000 px page is 6%: the flick is what commits, not the travel.
  assert.equal(pageTurnDecision({ dx: -60, width: 1000, velocity: -0.9 }), "commit");
  // At the flick speed exactly, with the minimum travel, it still commits.
  assert.equal(pageTurnDecision({ dx: -flickTravel, width: 1000, velocity: -flickVelocity }), "commit");
});

test("a slow short drag cancels, and so does a flick without travel", () => {
  // 30 px on a phone (390 px) is 7.7%: released slowly, the page springs back.
  assert.equal(pageTurnDecision({ dx: -30, width: 390, velocity: -0.2 }), "cancel");
  // A flick needs 24 px of travel: 20 px is a jittery tap, not a gesture.
  assert.equal(pageTurnDecision({ dx: -20, width: 390, velocity: -2 }), "cancel");
});

test("a rightward drag never turns the day, however far it goes", () => {
  assert.equal(pageTurnDecision({ dx: 600, width: 390, velocity: 0 }), "cancel");
  assert.equal(pageTurnDecision({ dx: 600, width: 390, velocity: 2 }), "cancel");
});

test("progress is the leftward fraction of the page, clamped to 0..1", () => {
  assert.equal(turnProgress(-195, 390), 0.5);
  assert.equal(turnProgress(-390, 390), 1);
  assert.equal(turnProgress(-800, 390), 1);
  assert.equal(turnProgress(40, 390), 0);
  // A surface with no measured width cannot be half turned.
  assert.equal(turnProgress(-100, 0), 0);
  assert.equal(turnProgress(-100, -10), 0);
  assert.equal(commitProgress, 0.4);
});

test("rightward drags are clamped to 0 through a 0.2 rubber band", () => {
  assert.equal(draggedOffset(-120), -120);
  assert.equal(draggedOffset(0), 0);
  // The page moves a fifth of what the finger does into the wall.
  assert.equal(draggedOffset(100), 20);
  assert.equal(draggedOffset(500), 100);
});

test("a drag that starts near a screen edge belongs to the browser's back gesture", () => {
  assert.equal(edgeGuard, 16);
  assert.equal(isEdgeGuarded(4, 390), true);
  assert.equal(isEdgeGuarded(16, 390), true);
  assert.equal(isEdgeGuarded(17, 390), false);
  // The right edge is symmetric, and a viewport narrower than both guards
  // still leaves the middle free.
  assert.equal(isEdgeGuarded(386, 390), true);
  assert.equal(isEdgeGuarded(200, 390), false);
  assert.equal(isEdgeGuarded(0, 20), true);
});

test("activation needs 8 px of travel so a tap is never a drag", () => {
  assert.equal(activateDistance, 8);
});

test("release velocity is measured over the last 80 ms, leftward negative", () => {
  // Moving 60 px left in the last 60 ms: -1 px/ms.
  const samples = [
    { t: 0, x: 300 },
    { t: 900, x: 240 }, // older than the window: ignored
    { t: 1000, x: 180 },
    { t: 1060, x: 120 },
  ];
  assert.equal(velocityWindowMs, 80);
  assert.equal(pointerVelocity(samples, 1060), -1);
  // Rightward is positive.
  assert.equal(pointerVelocity([{ t: 1000, x: 100 }, { t: 1060, x: 160 }], 1060), 1);
});

test("a release with no usable samples has no velocity", () => {
  assert.equal(pointerVelocity([], 500), 0);
  assert.equal(pointerVelocity([{ t: 100, x: 50 }], 100), 0);
  // Two samples at the same instant cannot give a speed.
  assert.equal(pointerVelocity([{ t: 100, x: 50 }, { t: 100, x: 90 }], 100), 0);
  // Only pre-window samples: take the last one inside the window, alone.
  assert.equal(pointerVelocity([{ t: 0, x: 300 }, { t: 10, x: 200 }], 900), 0);
});
