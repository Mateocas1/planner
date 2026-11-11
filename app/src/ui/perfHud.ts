/** Linux diagnostics for : the switches the desktop shell hands to the
 * page (`window.__PLANNER_DIAG__`, set by `src-tauri/src/window.rs` from the
 * `PLANNER_GUARD` / `PLANNER_GLASS` / `PLANNER_FPS` environment variables) and
 * the corner frame-time HUD behind `PLANNER_FPS=1`.
 *
 * The HUD measures main-thread requestAnimationFrame intervals, not presented
 * frames: it shows whether the page itself drops frames, and a smooth HUD with a
 * laggy feel points at the compositor instead. The stats are pure so they run
 * under the node test runner; only `installPerfHud` touches the DOM. */

export type PlannerDiag = {
  /** `off` skips the compositor handoff (D11). */
  guard: "on" | "off";
  /** `blur` keeps the blurred glass; `flat` is the Linux default. */
  glass: "flat" | "blur";
  fps: boolean;
};

const DEFAULT_DIAG: PlannerDiag = { guard: "on", glass: "flat", fps: false };

/** Reads `__PLANNER_DIAG__` from `scope`, keeping only the known values so a
 * malformed or missing object falls back to the defaults field by field. */
export function readPlannerDiag(scope: object): PlannerDiag {
  const raw = (scope as { __PLANNER_DIAG__?: unknown }).__PLANNER_DIAG__;
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_DIAG };
  const { guard, glass, fps } = raw as Record<string, unknown>;
  return {
    guard: guard === "off" ? "off" : "on",
    glass: glass === "blur" ? "blur" : "flat",
    fps: fps === true,
  };
}

export type FrameStats = { count: number; p95: number; over: number };

/** Nearest-rank p95 of `intervals` and how many are strictly over `thresholdMs`. */
export function frameStats(intervals: readonly number[], thresholdMs: number): FrameStats {
  if (intervals.length === 0) return { count: 0, p95: 0, over: 0 };
  const sorted = [...intervals].sort((a, b) => a - b);
  const rank = Math.ceil(sorted.length * 0.95);
  return {
    count: sorted.length,
    p95: sorted[rank - 1],
    over: sorted.filter((ms) => ms > thresholdMs).length,
  };
}

/** A gap this long is a hidden or idle page, not a dropped frame. */
const MAX_FRAME_GAP_MS = 1000;
const SLOW_FRAME_MS = 20;

/** Rolling frame-interval window (for p95) plus a slow-frame tally that lasts
 * until `reset`. */
export class FrameMeter {
  private readonly window: number[] = [];
  private last: number | null = null;
  private slow = 0;
  private readonly size: number;

  constructor(size = 120) {
    this.size = size;
  }

  tick(now: number): void {
    const previous = this.last;
    this.last = now;
    if (previous === null) return;
    const interval = now - previous;
    if (interval > MAX_FRAME_GAP_MS) return;
    this.window.push(interval);
    if (this.window.length > this.size) this.window.shift();
    if (interval > SLOW_FRAME_MS) this.slow += 1;
  }

  reset(): void {
    this.window.length = 0;
    this.last = null;
    this.slow = 0;
  }

  /** `count` and `p95` describe the rolling window; `over` is the tally since reset. */
  snapshot(): FrameStats {
    return { ...frameStats(this.window, SLOW_FRAME_MS), over: this.slow };
  }
}

const REFRESH_MS = 250;

/** The HUD text changes at most four times a second. */
export function dueForRefresh(now: number, lastRefresh: number): boolean {
  return now - lastRefresh >= REFRESH_MS;
}

export function formatHud(stats: FrameStats): string {
  const p95 = stats.count === 0 ? "–" : `${stats.p95.toFixed(1)} ms`;
  return `p95 ${p95} · >20 ms: ${stats.over} (since reset)`;
}

/** Ctrl+Shift+F8 clears the tally. */
function isResetKey(event: KeyboardEvent): boolean {
  return event.key === "F8" && event.ctrlKey && event.shiftKey;
}

/** Mounts the corner HUD (styled by `perfHud.css`) and starts sampling. */
export function installPerfHud(): void {
  const hud = document.createElement("div");
  hud.className = "perf-hud";
  hud.setAttribute("aria-hidden", "true");
  document.body.append(hud);

  const meter = new FrameMeter();
  let lastRefresh = Number.NEGATIVE_INFINITY;
  const frame = (now: number) => {
    meter.tick(now);
    if (dueForRefresh(now, lastRefresh)) {
      lastRefresh = now;
      hud.textContent = formatHud(meter.snapshot());
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  window.addEventListener("keydown", (event) => {
    if (!isResetKey(event)) return;
    meter.reset();
    hud.textContent = formatHud(meter.snapshot());
  });
}
