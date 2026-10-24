/**
 * Pure gesture math for swipe-to-dismiss on the shared glass sheet (odd/tasks/
 * ronda4.md, S1): a pointer drag on the sheet's drag handle or its plain surface
 * follows the finger 1:1, locks to one direction after a small slop, and either
 * commits a dismissal or springs back. No DOM here -- Sheet.tsx owns the pointer
 * wiring, this module owns the numbers, so every threshold is unit-testable.
 *
 * The values follow the Emil flow (AGENTS.md) and the user's S1 description:
 * the gesture is distance- OR velocity-gated ("debe tener un threshold que tiene
 * que ser a una determinada distancia o velocidad"), the same way iOS sheets
 * dismiss, and every direction except up may dismiss ("da igual si es para la
 * izquierda, para la derecha o para abajo"); up rubber-bands and never closes.
 */

/** A locked drag direction. `up` is the rubber-band direction: never dismisses. */
export type SwipeDirection = "left" | "right" | "down" | "up";

/**
 * Distance the pointer must travel before the gesture commits to one axis
 * (Apple's and Android's slop). Below this the pointer may still be reaching
 * for a scroll or a click, so nothing moves.
 */
export const SWIPE_SLOP = 8;

/**
 * A drag commits when it covered this fraction of the sheet's size along the
 * locked axis. 35% is the iOS sheet band (30-40%): far enough that a scroll
 * misfire never closes, close enough that the release lands while the sheet is
 * still visibly "thrown".
 */
export const COMMIT_DISTANCE_RATIO = 0.35;

/** …but never less than this, so a narrow sheet does not dismiss on a twitch. */
export const MIN_COMMIT_DISTANCE = 96;

/**
 * …or the release was a flick at least this fast, in px/ms (500 px/s, the
 * velocity iOS `UIScrollView` treats as a decisive throw). A flick commits from
 * a shorter distance, because the release velocity -- not the position -- is
 * what the user is saying "go" with.
 */
export const FLICK_VELOCITY = 0.5;

/** A flick only commits once the gesture is real: past the slop and this far. */
export const MIN_FLICK_DISTANCE = 24;

/**
 * Rubber-band limit for the `up` direction, as a fraction of the sheet's size:
 * the offset the band approaches but never reaches. The curve starts with slope
 * 1 (a 1:1 follow at first) and flattens, so an upward drag always feels
 * attached to the finger while clearly refusing to leave.
 */
export const RUBBER_BAND_FRACTION = 0.55;

/** How much the sheet shrinks at full progress (scale 1 → 0.94): "se achica un poquito". */
export const SCALE_SHRINK = 0.06;

/**
 * Corner radius a phone sheet grows to at full progress, in px: the top of the
 * 24-28 px band S1 asks for. A full-viewport sheet (resting radius 0) rounds
 * from 0 to this; the inset sheets on phone rest at --r-sheet (26 px) and only
 * gain the last curvature as they shrink. Desktop never touches its radius.
 */
export const MOBILE_RADIUS_MAX = 28;

/**
 * How fast the commit flight travels at minimum, in px/ms. A release exactly at
 * the distance threshold with a dead pointer still leaves at a brisk pace; a
 * real flick overrides this with its own velocity. 0.8 px/ms (800 px/s) keeps
 * the flight inside the dismissal budget (~180-300 ms) on any screen.
 */
export const MIN_EXIT_SPEED = 0.8;

/** Bounds for the commit flight, in ms: never sluggish, never a frame flash. */
export const EXIT_MS_MIN = 120;
export const EXIT_MS_MAX = 300;

/** Velocity samples inside this window (ms) count toward the release velocity. */
export const VELOCITY_WINDOW_MS = 100;

/**
 * A release this long after the last sample is a hold, not a throw: whatever
 * flick speed the pointer carried earlier is stale, and the release velocity
 * is zero (the pointer wiring in useSwipeDismiss only reports velocity for
 * throws the pointer is still making when it lifts).
 */
export const VELOCITY_STALE_MS = 60;

/**
 * The axis a gesture locks to, or null while the pointer is inside the slop.
 * The axis that reaches the slop first wins; on a diagonal the horizontal axis
 * wins ties, matching how sheets are dismissed far more often than scrolled.
 */
export function lockDirection(dx: number, dy: number, slop: number = SWIPE_SLOP): SwipeDirection | null {
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx < slop && ady < slop) return null;
  if (adx >= ady) return dx < 0 ? "left" : "right";
  return dy < 0 ? "up" : "down";
}

/**
 * The commit threshold for a locked axis: a fraction of the sheet's size along
 * that axis (width for left/right, height for down), with a floor.
 */
export function commitDistance(dimension: number): number {
  return Math.max(dimension * COMMIT_DISTANCE_RATIO, MIN_COMMIT_DISTANCE);
}

/** Visual progress 0..1 of a drag toward its commit threshold. */
export function progress(distance: number, dimension: number): number {
  if (distance <= 0) return 0;
  return Math.min(distance / commitDistance(dimension), 1);
}

/**
 * iOS-style rubber band: starts with slope 1 (1:1 follow) and asymptotically
 * approaches `limit` -- the sheet follows the finger up but increasingly
 * resists, and can never be dragged away by it.
 */
export function rubberBand(offset: number, dimension: number): number {
  if (offset <= 0) return 0;
  const limit = dimension * RUBBER_BAND_FRACTION;
  return (limit * offset) / (offset + limit);
}

/** The sheet's scale at a given progress: a slight shrink that grows with the drag. */
export function sheetScale(p: number): number {
  return 1 - SCALE_SHRINK * Math.min(Math.max(p, 0), 1);
}

/**
 * The sheet's corner radius at a given progress: from its resting radius up to
 * `MOBILE_RADIUS_MAX`. A full-viewport sheet (resting radius 0) rounds from 0
 * to the top of the S1 band; a phone sheet already at 26 px only gains the
 * last curvature. Desktop callers pass their resting radius and never apply it.
 */
export function sheetRadius(baseRadius: number, p: number): number {
  const clamped = Math.min(Math.max(p, 0), 1);
  return baseRadius + (MOBILE_RADIUS_MAX - baseRadius) * clamped;
}

/**
 * Whether a release commits the dismissal. `distance` is the drag distance
 * along the locked axis and `velocity` the release velocity along it, in px/ms,
 * signed the same way as the drag (a release that decelerates against the drag
 * is the user pulling the sheet back, not throwing it).
 */
export function shouldCommit(distance: number, velocity: number, dimension: number): boolean {
  if (distance >= commitDistance(dimension)) return true;
  return distance >= MIN_FLICK_DISTANCE && velocity >= FLICK_VELOCITY;
}

/**
 * Duration of the commit flight, in ms: the remaining distance divided by the
 * release speed (so the flight inherits the velocity the pointer arrived with),
 * floored at MIN_EXIT_SPEED and clamped to the dismissal budget. Linear within
 * the flight, so the sheet keeps the velocity it was released with.
 */
export function exitDurationMs(remainingPx: number, velocityPxPerMs: number): number {
  const speed = Math.max(Math.abs(velocityPxPerMs), MIN_EXIT_SPEED);
  const remaining = Math.max(remainingPx, 1);
  return Math.round(Math.min(Math.max(remaining / speed, EXIT_MS_MIN), EXIT_MS_MAX));
}

/** One transform string for the sheet mid-gesture: translate plus a uniform scale. */
export function dragTransform(x: number, y: number, scale: number): string {
  return `translate(${x}px, ${y}px) scale(${scale}, ${scale})`;
}

/**
 * How far the sheet still has to travel, from its released box, until it is
 * fully outside the viewport along the locked direction.
 */
export function exitDistance(
  direction: Exclude<SwipeDirection, "up">,
  rect: { left: number; top: number; width: number; height: number },
  viewportWidth: number,
  viewportHeight: number,
): number {
  switch (direction) {
    case "left":
      return rect.left + rect.width;
    case "right":
      return viewportWidth - rect.left;
    case "down":
      return viewportHeight - rect.top;
  }
}

/**
 * Tracks pointer positions over a short window and reports the release
 * velocity along one axis, in px/ms. The window -- not the last event pair --
 * is what makes the velocity stable against a slow final frame, and `now`
 * (the release's `event.timeStamp`) is what makes a hesitant release honest:
 * a flick followed by a hold reads as zero, because the pointer had already
 * stopped when it lifted.
 */
export function createVelocityTracker(windowMs: number = VELOCITY_WINDOW_MS) {
  let samples: Array<{ x: number; y: number; t: number }> = [];
  return {
    reset() {
      samples = [];
    },
    add(x: number, y: number, t: number) {
      samples.push({ x, y, t });
      const cutoff = t - windowMs;
      while (samples.length > 2 && samples[0].t < cutoff) samples.shift();
    },
    velocity(axis: "x" | "y", now: number): number {
      if (samples.length === 0) return 0;
      const cutoff = now - windowMs;
      while (samples.length > 1 && samples[0].t < cutoff) samples.shift();
      const last = samples[samples.length - 1];
      // The pointer stopped holding the velocity before it let go: the earlier
      // flick belongs to a gesture the user already changed their mind about.
      if (now - last.t > VELOCITY_STALE_MS) return 0;
      if (samples.length < 2) return 0;
      const first = samples[0];
      const dt = last.t - first.t;
      if (dt <= 0) return 0;
      return (last[axis] - first[axis]) / dt;
    },
  };
}
