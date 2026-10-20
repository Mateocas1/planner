import assert from "node:assert/strict";
import test from "node:test";
import { draggedEdge, dropLengthMinutes, dropStart, instantForEdge, minBlockMinutes, movedEdge, snapMinutes, stepMinutes } from "./grid.ts";

test("snapMinutes rounds to the grid's step and stays inside the day", () => {
  assert.equal(stepMinutes, 30);
  assert.equal(snapMinutes(0), 0);
  assert.equal(snapMinutes(14), 0);
  assert.equal(snapMinutes(15), 30);
  assert.equal(snapMinutes(44), 30);
  assert.equal(snapMinutes(46), 60);
  assert.equal(snapMinutes(-40), 0);
  assert.equal(snapMinutes(1500), 1440);
});

test("dragging the end edge up keeps the start and never shrinks below one step", () => {
  // 08:00-09:00, bottom edge dragged 35 minutes up: 08:00-08:30 after snapping.
  assert.deepEqual(movedEdge("end", -35, 480, 540), { start: 480, end: 510 });
  // Dragged far past the start: clamped at the minimum duration, not past it.
  assert.deepEqual(movedEdge("end", -600, 480, 540), { start: 480, end: 510 });
});

test("dragging the end edge down snaps to the step and stops at midnight", () => {
  assert.deepEqual(movedEdge("end", 95, 480, 540), { start: 480, end: 630 });
  assert.deepEqual(movedEdge("end", 2000, 480, 540), { start: 480, end: 1440 });
  // A block already at the minimum duration has no room left.
  assert.deepEqual(movedEdge("end", -600, 480, 510), { start: 480, end: 510 });
});

test("dragging the start edge moves only the start, inside the day and below the end", () => {
  assert.deepEqual(movedEdge("start", 95, 480, 660), { start: 570, end: 660 });
  // Past the end: clamped to one step before it.
  assert.deepEqual(movedEdge("start", 600, 480, 660), { start: 630, end: 660 });
  assert.deepEqual(movedEdge("start", 2000, 480, 660), { start: 630, end: 660 });
  assert.deepEqual(movedEdge("start", -1000, 480, 660), { start: 0, end: 660 });
});

test("keyboard resize uses the same one-step rule", () => {
  const grown = movedEdge("end", stepMinutes, 540, 600);
  assert.deepEqual(grown, { start: 540, end: 630 });
  assert.deepEqual(movedEdge("end", -stepMinutes, 540, 630), { start: 540, end: 600 });
  // At the minimum duration the key changes nothing, so nothing is written.
  assert.deepEqual(movedEdge("end", -stepMinutes, 540, 570), { start: 540, end: 570 });
  assert.equal(minBlockMinutes, stepMinutes);
});

test("a dragged edge follows the pointer without snapping, inside the day", () => {
  // Mid-drag the block keeps the pointer's minute: the step belongs to release.
  assert.deepEqual(draggedEdge("end", 95, 480, 540), { start: 480, end: 635 });
  assert.deepEqual(draggedEdge("start", -95, 480, 660), { start: 385, end: 660 });
  assert.deepEqual(draggedEdge("end", 2000, 480, 540), { start: 480, end: 1440 });
  assert.deepEqual(draggedEdge("start", -1000, 480, 660), { start: 0, end: 660 });
  // One step apart is the floor for the normal case.
  assert.deepEqual(draggedEdge("end", -600, 480, 540), { start: 480, end: 510 });
  assert.deepEqual(draggedEdge("start", 600, 480, 660), { start: 630, end: 660 });
});

test("a stored block shorter than one step can only grow, never invert", () => {
  // 08:00-08:10: neither edge may move in the direction that would snap it past
  // the other one, but both may grow the block.
  assert.deepEqual(draggedEdge("start", 30, 480, 490), { start: 480, end: 490 });
  assert.deepEqual(draggedEdge("start", -30, 480, 490), { start: 450, end: 490 });
  assert.deepEqual(draggedEdge("end", -30, 480, 490), { start: 480, end: 490 });
  assert.deepEqual(draggedEdge("end", 60, 480, 490), { start: 480, end: 550 });
});

test("a dropped task lands on the step with room for its default length", () => {
  assert.equal(dropStart(537), 540);
  assert.equal(dropStart(534), 540);
  assert.equal(dropStart(-90), 0);
  // 23:30 leaves no room for an hour, so the block starts an hour before midnight.
  assert.equal(dropStart(1410), 1440 - dropLengthMinutes);
});

test("edges become zoned instants, and a block may end at midnight of the next day", () => {
  assert.equal(instantForEdge("2026-03-02", 570, "UTC"), "2026-03-02T09:30:00+00:00");
  assert.equal(instantForEdge("2026-03-02", 1440, "UTC"), "2026-03-03T00:00:00+00:00");
  assert.equal(instantForEdge("2026-03-02", 1440.4, "UTC"), "2026-03-03T00:00:00+00:00");
  // São Paulo has no DST any more: 08:00 local is 08:00-03:00.
  assert.equal(instantForEdge("2026-03-02", 480, "America/Sao_Paulo"), "2026-03-02T08:00:00-03:00");
});
