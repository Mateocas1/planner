/**
 * Where a popover goes, as a pure function of boxes (no DOM), so every branch
 * is unit-tested. `usePopover` measures, calls this, and writes the result to
 * the element as `left`, `top`, `--pop-max-h`, `--pop-ox` and `--pop-oy`.
 *
 * The popover lives in the top layer with `position: fixed`, so every number
 * here is in layout-viewport CSS px. The viewport box is the *visual* viewport
 * (it shrinks for the on-screen keyboard and moves when the page is panned).
 *
 * Block axis: below the trigger if the popover fits there, else above, else on
 * whichever side has more room and slid along the axis until it sits inside the
 * margin (overlapping the trigger is acceptable; a popover that cannot be seen
 * is not). A popover taller than the whole usable height is capped to it and
 * its body scrolls. Inline axis: the popover's end edge meets the trigger's end
 * edge (the form controls are right-aligned in their rows), then it is clamped
 * to the margins.
 */

/** Space between the trigger and the popover, in px. */
export const POPOVER_GAP = 6;
/** Space kept between the popover and the viewport edge, in px. */
export const POPOVER_MARGIN = 12;

export type Box = { left: number; top: number; width: number; height: number };

export type PlaceInput = {
  trigger: Box;
  /** The popover's natural size (not capped by `maxHeight`). */
  size: { width: number; height: number };
  /** The visual viewport. */
  viewport: Box;
  align: "start" | "end";
  gap?: number;
  margin?: number;
};

export type Placement = {
  left: number;
  top: number;
  /** The height the popover may use; its body scrolls beyond it. */
  maxHeight: number;
  /** The side chosen; when neither fit, the side with more room. */
  placement: "below" | "above";
  /** Neither side fit, so the popover was slid along the block axis. */
  slid: boolean;
  /** The trigger's anchor point relative to the popover's box, for `transform-origin`. */
  originX: number;
  originY: number;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

export function placePopover(input: PlaceInput): Placement {
  const { trigger, size, viewport, align } = input;
  const gap = input.gap ?? POPOVER_GAP;
  const margin = input.margin ?? POPOVER_MARGIN;

  const minTop = viewport.top + margin;
  const maxBottom = viewport.top + viewport.height - margin;
  const triggerBottom = trigger.top + trigger.height;
  const roomBelow = maxBottom - (triggerBottom + gap);
  const roomAbove = trigger.top - gap - minTop;
  const usable = Math.max(0, maxBottom - minTop);

  let placement: "below" | "above";
  let slid = false;
  let top: number;
  let maxHeight: number;
  if (size.height <= roomBelow) {
    placement = "below";
    top = triggerBottom + gap;
    maxHeight = roomBelow;
  } else if (size.height <= roomAbove) {
    placement = "above";
    top = trigger.top - gap - size.height;
    maxHeight = roomAbove;
  } else {
    slid = true;
    placement = roomBelow >= roomAbove ? "below" : "above";
    maxHeight = usable;
    const height = Math.min(size.height, usable);
    const preferred = placement === "below" ? triggerBottom + gap : trigger.top - gap - height;
    top = clamp(preferred, minTop, maxBottom - height);
  }
  maxHeight = Math.max(0, maxHeight);

  const minLeft = viewport.left + margin;
  const maxRight = viewport.left + viewport.width - margin;
  const preferredLeft = align === "end" ? trigger.left + trigger.width - size.width : trigger.left;
  const left = Math.max(minLeft, Math.min(preferredLeft, maxRight - size.width));

  // The grow-from point: the trigger's edge on the aligned side and the edge
  // facing the popover. Relative to the popover and held inside its box, so a
  // flip, a clamp or a slide never points the origin into empty space.
  const height = Math.min(size.height, maxHeight);
  const anchorX = align === "end" ? trigger.left + trigger.width : trigger.left;
  const anchorY = placement === "below" ? triggerBottom : trigger.top;
  return {
    left,
    top,
    maxHeight,
    placement,
    slid,
    originX: clamp(anchorX - left, 0, size.width),
    originY: clamp(anchorY - top, 0, height),
  };
}
