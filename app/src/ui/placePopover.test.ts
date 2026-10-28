import assert from "node:assert/strict";
import test from "node:test";
import { placePopover, POPOVER_GAP, POPOVER_MARGIN, type PlaceInput } from "./placePopover.ts";

/** A 1366x768 desktop viewport and a 200x36 trigger, overridable per case. */
const base = (over: Partial<PlaceInput> = {}): PlaceInput => ({
  trigger: { left: 600, top: 300, width: 200, height: 36 },
  size: { width: 300, height: 400 },
  viewport: { left: 0, top: 0, width: 1366, height: 768 },
  align: "start",
  ...over,
});

test("opens below the trigger when it fits, one gap away", () => {
  const out = placePopover(base());
  assert.equal(out.placement, "below");
  assert.equal(out.top, 300 + 36 + POPOVER_GAP);
  assert.equal(out.slid, false);
  // room = viewport bottom - margin - popover top
  assert.equal(out.maxHeight, 768 - POPOVER_MARGIN - out.top);
});

test("flips above when below is too short but above fits", () => {
  const out = placePopover(base({ trigger: { left: 600, top: 600, width: 200, height: 36 } }));
  assert.equal(out.placement, "above");
  assert.equal(out.top, 600 - POPOVER_GAP - 400);
  assert.equal(out.maxHeight, 600 - POPOVER_GAP - POPOVER_MARGIN);
});

test("below wins when both sides fit", () => {
  const out = placePopover(base({ size: { width: 300, height: 100 } }));
  assert.equal(out.placement, "below");
});

test("when neither side fits it takes the side with more room and slides inside the margin", () => {
  // 844x390 landscape phone: 366px of usable height, popover wants 450.
  const out = placePopover(
    base({
      viewport: { left: 0, top: 0, width: 844, height: 390 },
      trigger: { left: 400, top: 250, width: 200, height: 36 },
      size: { width: 300, height: 450 },
    }),
  );
  assert.equal(out.slid, true);
  assert.equal(out.maxHeight, 390 - 2 * POPOVER_MARGIN);
  assert.equal(out.top, POPOVER_MARGIN);
  assert.equal(out.placement, "above"); // 238px above vs 92px below
});

test("a popover that is shorter than the usable height but fits on neither side slides, overlapping the trigger", () => {
  const out = placePopover(
    base({
      viewport: { left: 0, top: 0, width: 1366, height: 600 },
      trigger: { left: 600, top: 280, width: 200, height: 36 },
      size: { width: 300, height: 400 },
    }),
  );
  // room below 600-12-322 = 266, above 280-6-12 = 262: both short of 400
  assert.equal(out.slid, true);
  assert.equal(out.placement, "below");
  assert.equal(out.top, 600 - POPOVER_MARGIN - 400);
  assert.equal(out.maxHeight, 600 - 2 * POPOVER_MARGIN);
  assert.ok(out.top < 280 + 36); // overlaps the trigger, accepted
});

test("end alignment lines the popover's end edge up with the trigger's", () => {
  const out = placePopover(base({ align: "end" }));
  assert.equal(out.left, 600 + 200 - 300);
});

test("start alignment lines the start edges up", () => {
  assert.equal(placePopover(base({ align: "start" })).left, 600);
});

test("horizontal position clamps to the margins on both sides", () => {
  const right = placePopover(base({ trigger: { left: 1300, top: 100, width: 60, height: 36 } }));
  assert.equal(right.left, 1366 - POPOVER_MARGIN - 300);
  const left = placePopover(base({ align: "end", trigger: { left: 20, top: 100, width: 60, height: 36 } }));
  assert.equal(left.left, POPOVER_MARGIN);
});

test("a popover wider than the viewport sticks to the start margin", () => {
  const out = placePopover(
    base({ viewport: { left: 0, top: 0, width: 300, height: 700 }, size: { width: 400, height: 100 } }),
  );
  assert.equal(out.left, POPOVER_MARGIN);
});

test("a panned visual viewport shifts the clamp box", () => {
  const out = placePopover(
    base({
      viewport: { left: 50, top: 200, width: 390, height: 400 },
      trigger: { left: 60, top: 220, width: 100, height: 36 },
      size: { width: 332, height: 100 },
    }),
  );
  assert.equal(out.left, 50 + POPOVER_MARGIN);
  assert.ok(out.top >= 200 + POPOVER_MARGIN);
});

test("max-height is the room on the chosen side, never negative", () => {
  const out = placePopover(
    base({
      viewport: { left: 0, top: 0, width: 1366, height: 60 },
      trigger: { left: 600, top: 10, width: 200, height: 36 },
    }),
  );
  assert.ok(out.maxHeight >= 0);
});

test("origin is the trigger's edge point relative to the popover", () => {
  // below, end-aligned: the grow-from point is the trigger's end edge, top of the popover
  const below = placePopover(base({ align: "end" }));
  assert.equal(below.originX, 300);
  assert.equal(below.originY, 0);
  // above, start-aligned: start edge, bottom of the popover
  const above = placePopover(
    base({ trigger: { left: 600, top: 600, width: 200, height: 36 }, align: "start" }),
  );
  assert.equal(above.originX, 0);
  assert.equal(above.originY, 400);
});

test("origin follows a horizontal clamp and stays inside the popover box", () => {
  // end-aligned trigger at the left edge: the popover is pushed right, the anchor stays at the trigger's end edge
  const out = placePopover(base({ align: "end", trigger: { left: 20, top: 100, width: 60, height: 36 } }));
  assert.equal(out.left, POPOVER_MARGIN);
  assert.equal(out.originX, 20 + 60 - POPOVER_MARGIN);
  // a trigger far away from a clamped popover clamps the origin into the box
  const far = placePopover(base({ trigger: { left: 1300, top: 100, width: 60, height: 36 } }));
  assert.ok(far.originX >= 0 && far.originX <= 300);
});

test("origin after a slide points at the trigger edge clamped into the box", () => {
  const out = placePopover(
    base({
      viewport: { left: 0, top: 0, width: 1366, height: 600 },
      trigger: { left: 600, top: 280, width: 200, height: 36 },
      size: { width: 300, height: 400 },
    }),
  );
  assert.ok(out.originY >= 0 && out.originY <= 400);
});
