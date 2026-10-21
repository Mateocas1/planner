/**
 * The page-turn gesture's arithmetic (distinctive roadmap F3, "The page-turn
 * gesture"): closing the day is a left drag on Today, like turning to the next
 * page. Nothing here touches the DOM -- ui/PageTurn.tsx owns the pointers -- so
 * the thresholds below can move without a browser, and the same answers reach a
 * mouse, a pen and a finger.
 *
 * A release commits when the page has been carried past `commitProgress` of its
 * width, or when it is thrown leftward at `flickVelocity` with at least
 * `flickTravel` behind it. Everything else cancels: a rightward drag never
 * turns the day, and a tap's jitter is not a gesture.
 *
 * Leftward is negative on the x axis throughout, which is also the sign of the
 * velocity in px/ms.
 */

/** Progress at or past which a release turns the day (0..1 of the width). */
export const commitProgress = 0.4;

/** A leftward throw at this speed, in px/ms, turns the page without the travel. */
export const flickVelocity = 0.5;

/** ...but only with this much page behind it, so a tap never turns the day. */
export const flickTravel = 24;

/** How far the pointer must go before a press becomes a drag at all. */
export const activateDistance = 8;

/** What a rightward drag keeps of itself: a rubber band, not a wall. */
export const rubberBand = 0.2;

/** A press this close to a screen edge is the browser's back gesture, not ours. */
export const edgeGuard = 16;

/** The window the release velocity is measured over, in milliseconds. */
export const velocityWindowMs = 80;

/** What a release does to the page. */
export type TurnDecision = "commit" | "cancel";

/** One pointer move, timed by the event's own clock. */
export type PointerSample = { t: number; x: number };

/**
 * How far the page has been turned, 0..1: the leftward fraction of its width. A
 * rightward drag is no progress at all, and a page with no measured width (not
 * laid out yet) cannot be half turned.
 */
export function turnProgress(dx: number, width: number): number {
  if (!(width > 0) || dx >= 0) return 0;
  return Math.min(1, -dx / width);
}

/**
 * Where the page sits under a pointer that has moved `dx`: one to one to the
 * left, and a fifth of the way to the right, so pulling it back past its rest
 * slows down instead of stopping dead.
 */
export function draggedOffset(dx: number): number {
  return dx > 0 ? dx * rubberBand : dx;
}

/** True when a press at `x` is close enough to either edge to be the browser's. */
export function isEdgeGuarded(x: number, width: number): boolean {
  return x <= edgeGuard || x >= width - edgeGuard;
}

/**
 * The pointer's speed over the last `velocityWindowMs` before `now`, in px/ms:
 * negative leftward. Fewer than two samples inside the window -- a tap, or a
 * pointer that rested before it let go -- is no velocity at all, not a guess.
 */
export function pointerVelocity(samples: readonly PointerSample[], now: number): number {
  const from = now - velocityWindowMs;
  const recent = samples.filter(sample => sample.t >= from);
  if (recent.length < 2) return 0;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const elapsed = last.t - first.t;
  if (!(elapsed > 0)) return 0;
  return (last.x - first.x) / elapsed;
}

/**
 * What releasing the page at `dx` (px, leftward negative) with `velocity`
 * (px/ms, leftward negative) does. `width` is the page's own width, so a phone
 * and a desktop turn at the same felt distance.
 */
export function pageTurnDecision({ dx, width, velocity }: { dx: number; width: number; velocity: number }): TurnDecision {
  if (turnProgress(dx, width) >= commitProgress) return "commit";
  if (dx <= -flickTravel && velocity <= -flickVelocity) return "commit";
  return "cancel";
}
