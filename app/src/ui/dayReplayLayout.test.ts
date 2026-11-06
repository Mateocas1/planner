import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setDeviceLanguage } from "../i18n/index.ts";
import { replayTimeline, type DayReplay, type ReplayRow } from "../planning/dayReplay.ts";
import {
  MIN_BAR_PERCENT,
  STRIKE_MS,
  STRUCK_BAR_OPACITY,
  axisLabel,
  frameClip,
  frameTransform,
  layoutRow,
  playbackEndMs,
  rangeLabel,
  replayAnnouncement,
  replayMotion,
  rowTitle,
  type MotionEntry,
} from "./dayReplayLayout.ts";

/**
 * The geometry and the motion plan of the day-replay stage (day-replay plan
 * §2, §3, §6), proved on plain data: no DOM, no React. The component only maps
 * these entries onto elements, so what plays, when, and on which properties
 * is decided and asserted here.
 */

afterEach(() => setDeviceLanguage(null));

/** 200 minutes, so one minute is half a percent and the numbers stay exact. */
const range = { start: 540, end: 740 };

function row(overrides: Partial<ReplayRow> & Pick<ReplayRow, "key" | "outcome">): ReplayRow {
  return {
    kind: "task",
    label: "Report",
    done: false,
    plan: { start: 540, end: 600 },
    actual: { start: 540, end: 600 },
    placed: true,
    plannedMinutes: 60,
    actualMinutes: 60,
    ...overrides,
  };
}

function replayOf(rows: ReplayRow[], overrides: Partial<DayReplay> = {}): DayReplay {
  return {
    day: "2026-11-06",
    axisMinutes: 1440,
    range,
    rows,
    more: null,
    plannedMinutes: 300,
    trackedMinutes: 370,
    changedCount: rows.filter(candidate => candidate.outcome !== "unchanged").length,
    ...overrides,
  };
}

test("an unchanged row is a still bar on the track with no ghost", () => {
  const layout = layoutRow(row({ key: "task:a", outcome: "unchanged" }), range);
  assert.equal(layout.ghost, null);
  assert.deepEqual(layout.bar, { left: 0, width: 30 });
  assert.deepEqual(layout.from, { translateX: 0, clipRight: 0, opacity: 1 });
  assert.deepEqual(layout.to, layout.from);
  assert.equal(layout.animated, false);
});

test("a stretched row lays the bar out at its tracked length and clips it back to the plan", () => {
  const layout = layoutRow(
    row({ key: "task:a", outcome: "stretched", actual: { start: 540, end: 640 }, actualMinutes: 100 }),
    range,
  );
  assert.deepEqual(layout.ghost, { left: 0, width: 30 });
  assert.deepEqual(layout.bar, { left: 0, width: 50 });
  assert.deepEqual(layout.from, { translateX: 0, clipRight: 40, opacity: 1 });
  assert.deepEqual(layout.to, { translateX: 0, clipRight: 0, opacity: 1 });
  assert.equal(layout.animated, true);
});

test("a shrunk row lays the bar out at the plan length and clips it down to the tracked length", () => {
  const layout = layoutRow(
    row({
      key: "task:a",
      outcome: "shrunk",
      plan: { start: 540, end: 640 },
      plannedMinutes: 100,
      actual: { start: 540, end: 600 },
      actualMinutes: 60,
    }),
    range,
  );
  assert.deepEqual(layout.ghost, { left: 0, width: 50 });
  assert.deepEqual(layout.bar, { left: 0, width: 50 });
  assert.deepEqual(layout.from, { translateX: 0, clipRight: 0, opacity: 1 });
  assert.deepEqual(layout.to, { translateX: 0, clipRight: 40, opacity: 1 });
});

test("a moved row slides by its own width, in percent of the bar", () => {
  const layout = layoutRow(
    row({ key: "block:a", kind: "block", outcome: "moved", actual: { start: 600, end: 660 } }),
    range,
  );
  assert.deepEqual(layout.ghost, { left: 0, width: 30 });
  assert.deepEqual(layout.bar, { left: 0, width: 30 });
  assert.deepEqual(layout.from, { translateX: 0, clipRight: 0, opacity: 1 });
  assert.deepEqual(layout.to, { translateX: 100, clipRight: 0, opacity: 1 });
});

test("a row that both moved and stretched plays the two bends in one frame pair", () => {
  const layout = layoutRow(
    row({ key: "task:a", outcome: "stretched", actual: { start: 600, end: 700 }, actualMinutes: 100 }),
    range,
  );
  assert.deepEqual(layout.bar, { left: 0, width: 50 });
  assert.deepEqual(layout.from, { translateX: 0, clipRight: 40, opacity: 1 });
  assert.deepEqual(layout.to, { translateX: 60, clipRight: 0, opacity: 1 });
});

test("a struck row keeps its plan block, and the bar dims to the struck opacity", () => {
  const layout = layoutRow(
    row({ key: "task:a", outcome: "struck", actual: null, actualMinutes: 0 }),
    range,
  );
  assert.deepEqual(layout.ghost, { left: 0, width: 30 });
  assert.deepEqual(layout.bar, { left: 0, width: 30 });
  assert.deepEqual(layout.from, { translateX: 0, clipRight: 0, opacity: 1 });
  assert.deepEqual(layout.to, { translateX: 0, clipRight: 0, opacity: STRUCK_BAR_OPACITY });
});

test("an added row has no ghost and its bar is drawn in from the left", () => {
  const layout = layoutRow(
    row({ key: "task:a", outcome: "added", plan: null, plannedMinutes: 0, actual: { start: 600, end: 660 } }),
    range,
  );
  assert.equal(layout.ghost, null);
  assert.deepEqual(layout.bar, { left: 30, width: 30 });
  assert.deepEqual(layout.from, { translateX: 0, clipRight: 100, opacity: 0 });
  assert.deepEqual(layout.to, { translateX: 0, clipRight: 0, opacity: 1 });
});

test("time tracked with no block starts at the axis origin and claims no time of day", () => {
  const layout = layoutRow(
    row({
      key: "task:a",
      outcome: "added",
      plan: null,
      plannedMinutes: 0,
      actual: { start: 0, end: 40 },
      placed: false,
      actualMinutes: 40,
    }),
    range,
  );
  assert.deepEqual(layout.bar, { left: 0, width: 20 });
});

test("a sliver stays visible and a bar at the far edge stays inside the track", () => {
  const wide = { start: 0, end: 1000 };
  const sliver = layoutRow(row({ key: "task:a", outcome: "unchanged", plan: { start: 500, end: 501 }, actual: { start: 500, end: 501 } }), wide);
  assert.equal(sliver.bar?.width, MIN_BAR_PERCENT);
  const edge = layoutRow(row({ key: "task:a", outcome: "unchanged", plan: { start: 999, end: 1000 }, actual: { start: 999, end: 1000 } }), wide);
  assert.equal(edge.bar?.width, MIN_BAR_PERCENT);
  assert.equal((edge.bar?.left ?? 0) + (edge.bar?.width ?? 0), 100);
});

test("frames become the exact CSS the keyframes carry", () => {
  assert.equal(frameTransform({ translateX: 100, clipRight: 0, opacity: 1 }), "translateX(100%)");
  assert.equal(frameClip({ translateX: 0, clipRight: 40, opacity: 1 }), "inset(0 40% 0 0 round 6px)");
  assert.equal(frameClip({ translateX: 0, clipRight: 100, opacity: 0 }), "inset(0 100% 0 0 round 6px)");
});

/* ---------- the motion plan ---------- */

const mixed = replayOf([
  row({ key: "task:a", outcome: "stretched", actual: { start: 540, end: 640 }, actualMinutes: 100 }),
  row({ key: "task:b", outcome: "unchanged", label: "Standup" }),
  row({ key: "block:c", kind: "block", outcome: "moved", label: "", actual: { start: 600, end: 660 } }),
  row({ key: "task:d", outcome: "struck", actual: null, actualMinutes: 0 }),
  row({ key: "task:e", outcome: "added", plan: null, plannedMinutes: 0, actual: { start: 660, end: 700 }, actualMinutes: 40 }),
]);

function entriesOf(motion: MotionEntry[], part: MotionEntry["target"]["part"], key?: string): MotionEntry[] {
  return motion.filter(entry => entry.target.part === part && (key === undefined || entry.target.key === key));
}

test("the stage fades in over the timeline's stage-in and each row follows on its stagger", () => {
  const timeline = replayTimeline(mixed)!;
  const motion = replayMotion(mixed, timeline, true);
  const [stage] = entriesOf(motion, "stage");
  assert.equal(stage.options.delay, 0);
  assert.equal(stage.options.duration, timeline.stageInMs);
  assert.deepEqual(stage.keyframes, [{ opacity: 0 }, { opacity: 1 }]);
  assert.equal(stage.options.ease, "out");

  const rows = entriesOf(motion, "row");
  assert.deepEqual(rows.map(entry => entry.target.key), mixed.rows.map(candidate => candidate.key));
  assert.deepEqual(rows.map(entry => entry.options.delay), [0, 60, 120, 180, 240]);
  for (const entry of rows) {
    assert.equal(entry.options.duration, 300);
    assert.deepEqual(entry.keyframes, [
      { opacity: 0, transform: "translateY(6px)" },
      { opacity: 1, transform: "translateY(0px)" },
    ]);
  }
});

test("the folded rows enter after the last shown row", () => {
  const folded = replayOf(mixed.rows, { more: { count: 3, plannedMinutes: 30, actualMinutes: 30 } });
  const motion = replayMotion(folded, replayTimeline(folded)!, true);
  const [more] = entriesOf(motion, "more");
  assert.equal(more.options.delay, 300);
  assert.equal(entriesOf(replayMotion(mixed, replayTimeline(mixed)!, true), "more").length, 0);
});

test("only changed rows act, each on the timeline's own beat and curve", () => {
  const timeline = replayTimeline(mixed)!;
  const motion = replayMotion(mixed, timeline, true);
  const at = (key: string) => timeline.steps.find(step => step.key === key)!.action!;

  const [stretch] = entriesOf(motion, "bar", "task:a");
  assert.equal(stretch.options.delay, at("task:a").atMs);
  assert.equal(stretch.options.duration, 700);
  assert.equal(stretch.options.ease, "inOut");
  assert.deepEqual(stretch.keyframes, [
    { transform: "translateX(0%)", clipPath: "inset(0 40% 0 0 round 6px)" },
    { transform: "translateX(0%)", clipPath: "inset(0 0% 0 0 round 6px)" },
  ]);

  const [move] = entriesOf(motion, "bar", "block:c");
  assert.equal(move.options.duration, 800);
  assert.equal(move.options.ease, "inOut");
  assert.deepEqual(move.keyframes[1], { transform: "translateX(100%)", clipPath: "inset(0 0% 0 0 round 6px)" });

  const [added] = entriesOf(motion, "bar", "task:e");
  assert.equal(added.options.duration, 400);
  assert.equal(added.options.ease, "out");
  assert.deepEqual(added.keyframes, [
    { opacity: 0, clipPath: "inset(0 100% 0 0 round 6px)" },
    { opacity: 1, clipPath: "inset(0 0% 0 0 round 6px)" },
  ]);

  assert.equal(entriesOf(motion, "bar", "task:b").length, 0, "an unchanged row does not animate");
  assert.equal(entriesOf(motion, "strike", "task:b").length, 0);
});

test("a struck row draws its line, then dims the bar", () => {
  const timeline = replayTimeline(mixed)!;
  const motion = replayMotion(mixed, timeline, true);
  const action = timeline.steps.find(step => step.key === "task:d")!.action!;
  assert.equal(action.durationMs, 750);

  const [strike] = entriesOf(motion, "strike", "task:d");
  assert.equal(strike.options.delay, action.atMs);
  assert.equal(strike.options.duration, STRIKE_MS);
  assert.equal(strike.options.ease, "out");
  assert.deepEqual(strike.keyframes, [
    { clipPath: "inset(0 100% 0 0)" },
    { clipPath: "inset(0 0% 0 0)" },
  ]);

  const [dim] = entriesOf(motion, "bar", "task:d");
  assert.equal(dim.options.delay, action.atMs + STRIKE_MS);
  assert.equal(dim.options.duration, action.durationMs - STRIKE_MS);
  assert.deepEqual(dim.keyframes, [{ opacity: 1 }, { opacity: STRUCK_BAR_OPACITY }]);
});

test("the totals line fades in on its beat and the sentence rises last, then holds", () => {
  const timeline = replayTimeline(mixed)!;
  const motion = replayMotion(mixed, timeline, true);

  const [totals] = entriesOf(motion, "totals");
  assert.equal(totals.options.delay, timeline.totalsAtMs);
  assert.equal(totals.options.duration, 200);
  assert.deepEqual(totals.keyframes, [
    { opacity: 0, transform: "translateY(4px)" },
    { opacity: 1, transform: "translateY(0px)" },
  ]);
  assert.equal(totals.options.endDelay, 0);

  const [sentence] = entriesOf(motion, "sentence");
  assert.equal(sentence.options.delay, timeline.sentenceAtMs);
  assert.equal(sentence.options.duration, 600);
  assert.equal(sentence.options.endDelay, timeline.totalMs - timeline.sentenceAtMs - 600);
  assert.deepEqual(sentence.keyframes, [
    { opacity: 0, transform: "translateY(8px)", filter: "blur(6px)" },
    { opacity: 1, transform: "translateY(0px)", filter: "blur(0px)" },
  ]);
});

test("the playback ends with the sentence's hold, or soon after the totals when there is none", () => {
  const timeline = replayTimeline(mixed)!;
  assert.equal(playbackEndMs(timeline, true), timeline.totalMs);
  assert.equal(playbackEndMs(timeline, false), Math.min(timeline.totalMs, timeline.totalsAtMs + 200 + 1200));

  for (const hasSentence of [true, false]) {
    const end = playbackEndMs(timeline, hasSentence);
    const motion = replayMotion(mixed, timeline, hasSentence);
    const ends = motion.map(entry => entry.options.delay + entry.options.duration + entry.options.endDelay);
    assert.equal(Math.max(...ends), end, `the last entry lands on the end (sentence: ${hasSentence})`);
    assert.equal(entriesOf(motion, "sentence").length, hasSentence ? 1 : 0);
  }
});

test("every animation animates only transform, opacity, filter or clip-path, and holds nothing after it ends", () => {
  const allowed = new Set(["opacity", "transform", "filter", "clipPath"]);
  for (const hasSentence of [true, false]) {
    for (const entry of replayMotion(mixed, replayTimeline(mixed)!, hasSentence)) {
      for (const frame of entry.keyframes) {
        for (const property of Object.keys(frame)) {
          assert.ok(allowed.has(property), `${entry.target.part} animates ${property}`);
        }
      }
      assert.equal(entry.options.fill, "backwards", "the final frame is the element's own style, not a held effect");
    }
  }
});

test("the longest move is 800 ms and the plan stays inside the timeline's total", () => {
  const timeline = replayTimeline(mixed)!;
  const motion = replayMotion(mixed, timeline, true);
  const longestAction = Math.max(...motion.filter(entry => entry.target.part === "bar").map(entry => entry.options.duration));
  assert.equal(longestAction, 800);
  assert.ok(timeline.totalMs >= 6000 && timeline.totalMs <= 12_600);
});

/* ---------- copy ---------- */

test("an untitled manual block is called a work block", () => {
  assert.equal(rowTitle(row({ key: "block:c", kind: "block", outcome: "moved", label: "" })), "Work block");
  assert.equal(rowTitle(row({ key: "task:a", outcome: "moved", label: "Report" })), "Report");
  setDeviceLanguage("es");
  assert.equal(rowTitle(row({ key: "block:c", kind: "block", outcome: "moved", label: "" })), "Bloque de trabajo");
});

test("the screen-reader summary is one text: every row, what was folded, the totals, the sentence", () => {
  const replay = replayOf(
    [
      row({ key: "task:a", outcome: "stretched", actual: { start: 540, end: 640 }, actualMinutes: 100, done: true }),
      row({ key: "task:b", outcome: "unchanged", label: "Standup" }),
      row({ key: "block:c", kind: "block", outcome: "moved", label: "", actual: { start: 600, end: 660 } }),
      row({ key: "task:d", outcome: "struck", label: "Review", actual: null, actualMinutes: 0 }),
      row({ key: "task:e", outcome: "added", label: "Call", plan: null, plannedMinutes: 0, actual: { start: 660, end: 700 }, actualMinutes: 40 }),
    ],
    { more: { count: 2, plannedMinutes: 30, actualMinutes: 30 }, plannedMinutes: 330, trackedMinutes: 370 },
  );
  assert.equal(
    replayAnnouncement(replay, "You underestimate “report” tasks by 30%."),
    [
      "Report: planned 1 h, took 1 h 40 min, longer than planned. Done.",
      "Standup: as planned, 1 h.",
      "Work block: planned 1 h, moved to a different time.",
      "Review: planned 1 h, did not happen.",
      "Call: not planned, took 40 min.",
      "+2 more",
      "Planned 5 h 30 min · tracked 6 h 10 min",
      "You underestimate “report” tasks by 30%.",
    ].join(" "),
  );
  assert.equal(
    replayAnnouncement(replayOf([row({ key: "task:a", outcome: "shrunk", plan: { start: 540, end: 640 }, plannedMinutes: 100, actual: { start: 540, end: 600 }, actualMinutes: 60 })], { plannedMinutes: 100, trackedMinutes: 60 }), null),
    "Report: planned 1 h 40 min, took 1 h, shorter than planned. Planned 1 h 40 min · tracked 1 h",
  );
});

test("the screen-reader summary speaks Spanish with the same shape", () => {
  setDeviceLanguage("es");
  const replay = replayOf(
    [
      row({ key: "task:a", outcome: "stretched", actual: { start: 540, end: 640 }, actualMinutes: 100 }),
      row({ key: "task:d", outcome: "struck", label: "Revisión", actual: null, actualMinutes: 0 }),
    ],
    { plannedMinutes: 120, trackedMinutes: 100 },
  );
  assert.equal(
    replayAnnouncement(replay, "Subestimas las tareas de «informe» un 30 %."),
    [
      "Report: planificado 1 h, duró 1 h 40 min, más de lo previsto.",
      "Revisión: planificado 1 h, no ocurrió.",
      "Planificado 2 h · registrado 1 h 40 min",
      "Subestimas las tareas de «informe» un 30 %.",
    ].join(" "),
  );
});

test("the axis labels are the wall clock of the profile zone, also across a DST change", () => {
  assert.equal(axisLabel("2026-11-06", "UTC", 540), "09:00");
  assert.equal(axisLabel("2026-11-06", "America/New_York", 0), "00:00");
  // 2026-03-08: New York skips 02:00-03:00, so 240 elapsed minutes after midnight read 05:00.
  assert.equal(axisLabel("2026-03-08", "America/New_York", 240), "05:00");
  assert.equal(axisLabel("2026-03-08", "America/New_York", 60), "01:00");
  assert.equal(axisLabel("2026-11-06", "UTC", 1440), "24:00", "the end of the day is 24:00, not the next day's midnight");
});

test("the range reads as two wall-clock times", () => {
  const replay = replayOf([row({ key: "task:a", outcome: "unchanged" })], { range: { start: 540, end: 1080 } });
  assert.equal(rangeLabel(replay, "UTC"), "09:00 – 18:00");
});
