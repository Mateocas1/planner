import type { Page } from "@playwright/test";

/** One computed-style sample of the animated element at one frame. `el` is a
 * per-mount identity: a view switch remounts the element, so samples from
 * different mounts must not be compared for layout thrash. */
export type MotionSample = {
  t: number;
  el: number;
  transform: string;
  opacity: string;
  width: string;
  height: string;
  top: string;
  left: string;
};

/** The samples plus the in-page timestamp (relative to the same clock as
 * `t`) of the animationstart event on the sampled element, when it fired
 * inside the window. The true start lets the easing fit anchor time exactly
 * instead of guessing it from the first captured frame. */
export type MotionRun = {
  samples: MotionSample[];
  animationStartedAt: number | null;
};

/** One frame of tolerance at 60 Hz — the floor for observed cadences. */
export const FRAME_MS = 1000 / 60;

/** The sampler's observed frame cadence (90th percentile of the intervals
 * between consecutive samples). Under load a frame gap can stretch well
 * past 16.7 ms, and the duration error is bounded by the local interval,
 * not by the nominal one — so assertions on measured durations must derive
 * their tolerance from the machine's real cadence. It stays small enough
 * that wrong durations fail: a deliberately-set 400 ms token measured
 * ~260 ms against a 140 ms assertion. */
export function observedFrameMs(samples: MotionSample[]): number {
  const deltas: number[] = [];
  for (let i = 1; i < samples.length; i += 1) deltas.push(samples[i].t - samples[i - 1].t);
  if (deltas.length === 0) return FRAME_MS;
  deltas.sort((a, b) => a - b);
  const p90 = deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.9))];
  return Math.max(FRAME_MS, p90);
}

/**
 * Arms an in-page sampler that records the element's computed transform and
 * opacity (plus layout-sensitive properties for the thrash check) on every
 * animation frame for a fixed window. It must be armed BEFORE the trigger:
 * sampling only after the click misses the first frames and every
 * measurement would be wrong. The element is re-queried each frame, so a
 * keyed remount (a view switch) is followed instead of lost.
 */
export function sampleMotion(page: Page, selector: string, ms: number): Promise<MotionSample[]> {
  return sampleMotionDetailed(page, selector, ms).then(run => run.samples);
}

/** As sampleMotion, but also reports the captured animationstart timestamp. */
export function sampleMotionDetailed(page: Page, selector: string, ms: number): Promise<MotionRun> {
  return page.evaluate(
    ([sel, windowMs]: [string, number]) =>
      new Promise<MotionRun>(resolve => {
        const samples: MotionSample[] = [];
        const ids = new WeakMap<Element, number>();
        let nextId = 1;
        let animationStartedAt: number | null = null;
        const started = performance.now();
        const onAnimationStart = (event: AnimationEvent) => {
          if (animationStartedAt === null && event.target instanceof Element && event.target.matches(sel)) {
            // event.timeStamp is the frame time at which the animation
            // started; performance.now() inside the listener runs up to a
            // frame late, which misaligns the whole easing fit
            animationStartedAt = event.timeStamp - started;
          }
        };
        document.addEventListener("animationstart", onAnimationStart, true);
        const tick = () => {
          const el = document.querySelector(sel);
          if (el) {
            let id = ids.get(el);
            if (id === undefined) {
              id = nextId;
              ids.set(el, id);
              nextId += 1;
            }
            const s = getComputedStyle(el);
            samples.push({
              t: performance.now() - started,
              el: id,
              transform: s.transform,
              opacity: s.opacity,
              width: s.width,
              height: s.height,
              top: s.top,
              left: s.left,
            });
          }
          if (performance.now() - started < windowMs) {
            requestAnimationFrame(tick);
          } else {
            document.removeEventListener("animationstart", onAnimationStart, true);
            resolve({ samples, animationStartedAt });
          }
        };
        requestAnimationFrame(tick);
      }),
    [selector, ms] as [string, number],
  );
}

/** The samples where transform or opacity changed from the previous frame. */
function changes(samples: MotionSample[]): MotionSample[] {
  return samples.filter(
    (s, i) => i > 0 && (s.transform !== samples[i - 1].transform || s.opacity !== samples[i - 1].opacity),
  );
}

/** Measured duration in ms: first to last frame where transform or opacity
 * changed. An element that never animates measures 0. */
export function measureDuration(samples: MotionSample[]): number {
  const changed = changes(samples);
  if (changed.length === 0) return 0;
  return changed[changed.length - 1].t - changed[0].t;
}

export type EasingCandidate = { name: string; x1: number; y1: number; x2: number; y2: number };

/** The curves the fit must distinguish. "ease-out" is our --ease-out token. */
export const EASING_CANDIDATES: EasingCandidate[] = [
  { name: "ease-out", x1: 0.23, y1: 1, x2: 0.32, y2: 1 },
  { name: "ease", x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 },
  { name: "linear", x1: 0, y1: 0, x2: 1, y2: 1 },
];

function bezier(p1: number, p2: number, u: number): number {
  const v = 1 - u;
  return 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u;
}

/** Progress of a cubic-bezier easing at time fraction x (solves x(u) = x). */
function easingAt(c: EasingCandidate, x: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (bezier(c.x1, c.x2, mid) < x) lo = mid;
    else hi = mid;
  }
  return bezier(c.y1, c.y2, (lo + hi) / 2);
}

/** A scalar whose evolution over the changed window is the animation's
 * progress: opacity when it animates, otherwise the transform matrix. */
function scalarOf(s: MotionSample): number {
  const m = /matrix\(([^)]+)\)/.exec(s.transform);
  if (!m) return Number(s.opacity);
  const [a, , , , e, f] = m[1].split(",").map(Number);
  if (e !== 0 || f !== 0) return Math.hypot(e, f);
  return a;
}

function rawProgressPoints(samples: MotionSample[]): Array<{ t: number; p: number }> {
  const changed = changes(samples);
  if (changed.length < 2) return [];
  const first = changed[0];
  const last = changed[changed.length - 1];
  const scalar = first.opacity !== last.opacity ? (s: MotionSample) => Number(s.opacity) : scalarOf;
  if (scalar(first) === scalar(last)) return [];
  return changed.map(s => ({ t: s.t, p: scalar(s) }));
}

/** Fits each candidate curve to the measured progress series and returns
 * them ranked by RMS error — the winner should be the intended curve.
 * Progress is the raw animated channel (opacity runs its real 0→1). Both
 * the start and the duration are searched: renormalising values from the
 * first captured frame collapses the curve's shape whenever the sampler
 * misses early frames under load, and then a straight line can win. The
 * captured animationstart bounds the start from above (the event runs
 * about one frame late), so the search window stays small. */
export function fitEasing(
  samples: MotionSample[],
  candidates: EasingCandidate[] = EASING_CANDIDATES,
  animationStartedAt?: number | null,
): Array<{ name: string; rms: number }> {
  const points = rawProgressPoints(samples);
  if (points.length < 3) return candidates.map(c => ({ name: c.name, rms: Number.NaN }));
  const tFirst = points[0].t;
  const tSecond = points[1].t;

  const rmsFor = (c: EasingCandidate, start: number, dur: number): number => {
    let sum = 0;
    for (const { t, p } of points) {
      const x = Math.min(1, Math.max(0, (t - start) / dur));
      const err = easingAt(c, x) - p;
      sum += err * err;
    }
    return Math.sqrt(sum / points.length);
  };

  return candidates
    .map(c => {
      let best = Number.POSITIVE_INFINITY;
      const sLow = animationStartedAt != null ? animationStartedAt - 3 * FRAME_MS : tFirst - 3 * FRAME_MS;
      const sHigh = animationStartedAt != null ? animationStartedAt : tSecond;
      for (let dur = 60; dur <= 500; dur += 2) {
        for (let start = sLow; start <= sHigh; start += 2) {
          best = Math.min(best, rmsFor(c, start, dur));
        }
      }
      return { name: c.name, rms: best };
    })
    .sort((a, b) => a.rms - b.rms);
}

const LAYOUT_PROPERTIES = ["width", "height", "top", "left"] as const;

/** The samples of the final element mount. A keyed view switch remounts
 * the surface, and the click can land while the previous view's entrance
 * is still finishing — its tail frames are a different animation and must
 * not be mixed into the new mount's measurements. */
export function lastMount(samples: MotionSample[]): MotionSample[] {
  if (samples.length === 0) return samples;
  const last = samples[samples.length - 1].el;
  return samples.filter(s => s.el === last);
}

/** The layout-sensitive properties that changed during the sampled window
 * within a single element mount. A keyed view switch legitimately swaps
 * elements, so changes across a remount are not reported; a change of
 * width/height/top/left inside one mounted element is. */
export function layoutThrash(samples: MotionSample[]): string[] {
  const thrashed = new Set<string>();
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i].el !== samples[i - 1].el) continue;
    for (const prop of LAYOUT_PROPERTIES) {
      if (samples[i][prop] !== samples[i - 1][prop]) thrashed.add(prop);
    }
  }
  return [...thrashed];
}
