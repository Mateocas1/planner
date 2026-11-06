import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import type { DayReplay as DayReplayData, ReplayRow, ReplaySpan, ReplayTimeline } from "../planning/dayReplay.ts";
import { t } from "../i18n/index.ts";
import {
  EXIT_MS,
  frameClip,
  frameTransform,
  layoutRow,
  rangeLabel,
  replayAnnouncement,
  replayMotion,
  rowTitle,
  totalsText,
  type MotionPart,
} from "./dayReplayLayout.ts";
import { useMediaQuery } from "./motion.ts";
import "./DayReplay.css";

/**
 * The day replay (day-replay plan §2, §3, §6): the closing-the-day stage where
 * the plan bends into what happened, then says one sentence about the
 * estimates. Not wired into the ritual here; the sheet mounts it and decides
 * what its two callbacks do.
 *
 * The DOM is the *final frame*: every bar, strike and line carries its resting
 * style, so a stage that never animates (reduced motion, a day where nothing
 * changed, an engine without WAAPI) is already the complete picture. When it
 * plays, `replayMotion` (pure, tested) lists the animations and this file only
 * maps them onto elements with `element.animate()`, one-shot, `fill: backwards`,
 * `transform`/`opacity`/`filter`/`clip-path` only. Skip finishes every running
 * animation in one call, which lands the final frame.
 *
 * Exposed for the specs and the sheet: `data-state` (`playing` | `done`) on
 * the stage, `data-outcome` on every row. The chart is `aria-hidden`; one
 * `role="status"` text carries the whole replay for a screen reader, set once
 * after mount so it is announced then, not frame by frame.
 *
 * Escape belongs to the sheet: call `skip()` on the `ref` first (it returns
 * whether it skipped something) and close only when it did not.
 */

export type DayReplayHandle = {
  /** Lands the final frame and calls `onSkip`; false when nothing was playing. */
  skip: () => boolean;
};

type Props = {
  replay: DayReplayData;
  /** `replayTimeline(replay)`; null for a day where nothing changed (a static summary). */
  timeline: ReplayTimeline | null;
  /** The estimate-bias sentence (`dayBias`), or null when the evidence is silent. */
  sentence: string | null;
  /** The muted evidence line under the sentence ("Based on 3 finished tasks."). */
  basis?: string | null;
  /** The profile zone: with it the chart names the hours it covers. */
  timeZone?: string;
  /** Continue: the stage has faded out (reduced motion: at once); unmount it. */
  onDone: () => void;
  /** The user skipped the playback; the final frame is showing. */
  onSkip: () => void;
  ref?: Ref<DayReplayHandle>;
};

const FALLBACK_EASE = {
  out: "cubic-bezier(0.23, 1, 0.32, 1)",
  inOut: "cubic-bezier(0.77, 0, 0.175, 1)",
} as const;

/** The curves live in CSS (`--ease-out` in app.css, `--ease-in-out` in DayReplay.css); WAAPI cannot take `var()`. */
function resolveEase(stage: HTMLElement): { out: string; inOut: string } {
  const style = getComputedStyle(stage);
  return {
    out: style.getPropertyValue("--ease-out").trim() || FALLBACK_EASE.out,
    inOut: style.getPropertyValue("--ease-in-out").trim() || FALLBACK_EASE.inOut,
  };
}

const canAnimate = (): boolean => typeof Element !== "undefined" && typeof Element.prototype.animate === "function";

function CheckGlyph() {
  return (
    <svg className="replay-check" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ReplayRowView({ row, range }: { row: ReplayRow; range: ReplaySpan }) {
  const layout = layoutRow(row, range);
  const barStyle: CSSProperties | undefined =
    layout.bar === null
      ? undefined
      : {
          left: `${layout.bar.left}%`,
          width: `${layout.bar.width}%`,
          transform: frameTransform(layout.to),
          clipPath: frameClip(layout.to),
          opacity: layout.to.opacity,
        };
  return (
    <li
      className="replay-row"
      data-part="row"
      data-key={row.key}
      data-outcome={row.outcome}
      data-kind={row.kind}
      data-done={row.done ? "true" : undefined}
    >
      <span className="replay-label">
        <span className="replay-name">
          {rowTitle(row)}
          {row.outcome === "struck" && (
            <span className="replay-strike" data-part="strike" data-key={row.key} style={{ clipPath: "inset(0 0% 0 0)" }} />
          )}
        </span>
        {row.done && <CheckGlyph />}
      </span>
      <span className="replay-track">
        {layout.bar !== null && <span className="replay-bar" data-part="bar" data-key={row.key} style={barStyle} />}
        {layout.ghost !== null && (
          <span className="replay-ghost" style={{ left: `${layout.ghost.left}%`, width: `${layout.ghost.width}%` }} />
        )}
      </span>
    </li>
  );
}

export function DayReplayStage({ replay, timeline, sentence, basis = null, timeZone, onDone, onSkip, ref }: Props) {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const stageRef = useRef<HTMLElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const exiting = useRef(false);
  const titleId = useId();

  /* Plays only with something to play, motion allowed and an engine that can. */
  const plays = timeline !== null && !reduced && canAnimate();
  const [status, setStatus] = useState<"playing" | "done">(plays ? "playing" : "done");
  const state = plays ? status : "done";
  const [announcement, setAnnouncement] = useState("");

  /* The replay as one text. It is written after the first paint so the live
     region is announced when it fills in, not skipped as initial content. */
  useEffect(() => {
    setAnnouncement(replayAnnouncement(replay, sentence));
  }, [replay, sentence]);

  /* Skip (or Continue, when there is nothing to skip) holds focus from frame 0. */
  useLayoutEffect(() => {
    buttonRef.current?.focus({ preventScroll: true });
  }, []);

  /* The replay plays once per mount, from the props as they are then: a parent
     that rebuilds `replay` on every render must not restart it, and a stage that
     is already done must not play again because its data moved. The sheet keys
     the stage by day and freezes what it hands in. */
  const latest = useRef({ replay, timeline, sentence });
  useLayoutEffect(() => {
    latest.current = { replay, timeline, sentence };
  });
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const { replay: current, timeline: schedule, sentence: line } = latest.current;
    if (!plays || stage === null || schedule === null) return;
    const ease = resolveEase(stage);
    const elements = new Map<string, HTMLElement>([["stage|", stage]]);
    for (const element of stage.querySelectorAll<HTMLElement>("[data-part]")) {
      elements.set(`${element.dataset.part}|${element.dataset.key ?? ""}`, element);
    }
    const animations: Animation[] = [];
    for (const item of replayMotion(current, schedule, line !== null)) {
      const part: MotionPart = item.target.part;
      const element = elements.get(`${part}|${item.target.key ?? ""}`);
      if (element === undefined) continue;
      const { delay, duration, endDelay, fill } = item.options;
      animations.push(element.animate(item.keyframes, { delay, duration, endDelay, fill, easing: ease[item.options.ease] }));
    }
    setStatus("playing");
    let alive = true;
    Promise.all(animations.map(animation => animation.finished)).then(
      () => {
        if (alive) setStatus("done");
      },
      () => {
        /* cancelled: the stage was unmounted */
      },
    );
    return () => {
      alive = false;
      for (const animation of animations) animation.cancel();
    };
  }, [plays]);

  /* A hidden tab keeps its place in the replay instead of playing it unseen. */
  useEffect(() => {
    if (state !== "playing") return;
    const onVisibility = () => {
      for (const animation of stageRef.current?.getAnimations({ subtree: true }) ?? []) {
        if (document.hidden && animation.playState === "running") animation.pause();
        else if (!document.hidden && animation.playState === "paused") animation.play();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [state]);

  const skip = useCallback((): boolean => {
    const stage = stageRef.current;
    if (stage === null || state !== "playing") return false;
    for (const animation of stage.getAnimations({ subtree: true })) animation.finish();
    setStatus("done");
    onSkip();
    return true;
  }, [state, onSkip]);
  useImperativeHandle(ref, () => ({ skip }), [skip]);

  const proceed = () => {
    if (exiting.current) return;
    exiting.current = true;
    const stage = stageRef.current;
    if (stage === null || reduced || !canAnimate()) {
      onDone();
      return;
    }
    const fade = stage.animate([{ opacity: 1 }, { opacity: 0 }], { duration: EXIT_MS, easing: resolveEase(stage).out, fill: "forwards" });
    fade.finished.then(
      () => onDone(),
      () => {
        /* cancelled by an unmount: nothing left to continue */
      },
    );
  };

  const done = state === "done";
  return (
    <section ref={stageRef} className="day-replay" data-part="stage" data-state={state} aria-labelledby={titleId}>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <h2 className="replay-title" id={titleId}>
        {t("replay.title")}
      </h2>

      {timeline === null ? (
        <p className="replay-unchanged">{t("replay.unchanged")}</p>
      ) : (
        <div className="replay-chart" aria-hidden="true">
          <div className="replay-legend">
            <span className="replay-keys">
              <span className="replay-key">
                <span className="replay-swatch replay-swatch-plan" />
                {t("replay.legend.plan")}
              </span>
              <span className="replay-key">
                <span className="replay-swatch replay-swatch-actual" />
                {t("replay.legend.actual")}
              </span>
            </span>
            {timeZone !== undefined && <span className="replay-range">{rangeLabel(replay, timeZone)}</span>}
          </div>
          <ol className="replay-rows">
            {replay.rows.map(row => (
              <ReplayRowView key={row.key} row={row} range={replay.range} />
            ))}
          </ol>
          {replay.more !== null && (
            <p className="replay-more" data-part="more">
              {t("replay.more", { count: replay.more.count })}
            </p>
          )}
        </div>
      )}

      <p className="replay-totals" data-part="totals">
        {totalsText(replay)}
      </p>
      {sentence !== null && (
        <div className="replay-sentence" data-part="sentence">
          <p className="replay-sentence-text">{sentence}</p>
          {basis ? <p className="replay-basis">{basis}</p> : null}
        </div>
      )}

      <div className="replay-actions">
        <button
          ref={buttonRef}
          type="button"
          className={done ? "button button-accent replay-action" : "button replay-action"}
          data-action={done ? "continue" : "skip"}
          onClick={done ? proceed : skip}
        >
          {done ? t("replay.continue") : t("replay.skip")}
        </button>
      </div>
    </section>
  );
}
