/**
 * The stream pacer: turns bursty transport deltas into a steady
 * reveal. The network delivers 1–30 character chunks at irregular 20–250 ms
 * gaps; shown raw, the answer stalls and then dumps, which is exactly the
 * sensation the spec rejects.
 *
 * The pacer holds the undelivered text in a buffer and drains it on frames at
 * an adaptive rate: a baseline chars/second, sped up in proportion to how much
 * is buffered, so the visible text never lags more than ~1 s behind the
 * transport (pressure ≥ 1 char/s per buffered char ⇒ lag ≤ buffer/rate). The
 * frame loop is borrowed from the caller (`schedule`, normally
 * `requestAnimationFrame`) and stops itself the moment the buffer is empty —
 * nothing runs while nothing is pending. `flush` delivers everything at once
 * for `done` and stop.
 *
 * Pure and injectable (`now`, `schedule`, `emit`) so unit tests drive virtual
 * time without a browser.
 */

export type PacerOptions = {
  /** Delivers revealed text. Called with at most the drained chunk. */
  emit: (text: string) => void;
  /** Monotonic milliseconds (performance.now in the app, a counter in tests). */
  now: () => number;
  /** Requests the next frame; returns its cancel. Called only while pending. */
  schedule: (callback: () => void) => () => void;
  /** Steady-state reveal rate in characters per second. */
  baseRate?: number;
  /** Extra chars/s per buffered character (the lag limiter). */
  pressure?: number;
};

export type StreamPacer = {
  push: (delta: string) => void;
  /** Deliver everything buffered immediately (done / stop). */
  flush: () => void;
  /** True while text is buffered or a frame is scheduled. */
  isPending: () => boolean;
};

export function createPacer(options: PacerOptions): StreamPacer {
  const baseRate = options.baseRate ?? 90;
  const pressure = options.pressure ?? 2;
  let buffer = "";
  let last = options.now();
  let cancelFrame: (() => void) | null = null;

  const drain = () => {
    cancelFrame = null;
    if (buffer === "") return;
    const t = options.now();
    const elapsedSeconds = Math.max(0, (t - last) / 1000);
    // The rate scales with the backlog: 90 c/s when caught up, ~2 k c/s for a
    // 1000-character dump — the reveal speeds up so it never trails the model
    // by more than about half a second.
    const rate = baseRate + pressure * buffer.length;
    const take = Math.min(buffer.length, Math.floor(elapsedSeconds * rate));
    if (take > 0) {
      options.emit(buffer.slice(0, take));
      buffer = buffer.slice(take);
      last = t;
    }
    if (buffer !== "") cancelFrame = options.schedule(drain);
  };

  const requestDrain = () => {
    if (cancelFrame === null) cancelFrame = options.schedule(drain);
  };

  return {
    push(delta) {
      if (delta === "") return;
      buffer += delta;
      requestDrain();
    },
    flush() {
      if (cancelFrame !== null) {
        cancelFrame();
        cancelFrame = null;
      }
      if (buffer === "") return;
      options.emit(buffer);
      buffer = "";
      last = options.now();
    },
    isPending() {
      return buffer !== "" || cancelFrame !== null;
    },
  };
}
