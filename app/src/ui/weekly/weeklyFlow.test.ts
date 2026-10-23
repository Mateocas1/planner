import assert from "node:assert/strict";
import test from "node:test";
import {
  biasSentence,
  cleanupActionLabels,
  cleanupReasonLabel,
  momentLabel,
  momentStepsLabel,
  reviewSentences,
  stepLede,
  stepLabel,
  stepsToShow,
  topTaskLines,
  weekNumberLabel,
  weekRangeLabel,
  weekdayName,
} from "./weeklyFlow.ts";
import type { WeeklyNumbers } from "../../planning/weekly.ts";

test("stepsToShow keeps flow order and shows everything when opened by hand", () => {
  assert.deepEqual(stepsToShow(null), ["review", "cleanup", "plan", "reflect"]);
  // The due moment lists its own steps plus carried-over ones; the flow
  // re-orders them the way the person walks them.
  assert.deepEqual(stepsToShow({ week: "2026-W43", moment: { day: 0, time: 1140, steps: ["plan"] }, steps: ["plan", "review", "reflect"] }), [
    "review",
    "plan",
    "reflect",
  ]);
});

test("step copy is stable, one label and one lede per step", () => {
  assert.equal(stepLabel("cleanup"), "Clean up");
  assert.equal(stepLede("plan"), "Set next week's priorities and time.");
});

test("the week is named by its key's number and its real day span", () => {
  assert.equal(weekNumberLabel("2026-W43"), "Week 43");
  assert.equal(weekRangeLabel("2026-10-19", "2026-10-25"), "Oct 19 – Oct 25");
});

test("momentLabel reads the stored weekday and minute-of-day", () => {
  assert.equal(momentLabel({ day: 5, time: 1020, steps: ["review"] }), "Friday at 17:00");
  assert.equal(momentLabel({ day: 0, time: 1140, steps: ["plan"] }), "Sunday at 19:00");
  assert.equal(weekdayName(0), "Sunday");
  assert.equal(weekdayName(6), "Saturday");
});

test("momentStepsLabel lists the moment's steps in flow order", () => {
  assert.equal(momentStepsLabel(["reflect", "review", "cleanup"]), "Review, Clean up, Reflect");
  assert.equal(momentStepsLabel(["plan"]), "Plan");
});

function numbers(overrides: Partial<WeeklyNumbers>): WeeklyNumbers {
  return {
    week: "2026-W43",
    plannedMinutes: 0,
    actualMinutes: 0,
    biasRatio: null,
    doneCount: 0,
    plannedCount: 0,
    topTasks: [],
    ...overrides,
  };
}

test("reviewSentences compares planned with tracked, and marks a partial total", () => {
  const lines = reviewSentences(numbers({ plannedMinutes: 600, actualMinutes: 420, doneCount: 3, plannedCount: 5 }));
  assert.deepEqual(lines[0], { label: "Planned vs actual", value: "10 h planned · 7 h tracked" });
  assert.deepEqual(lines[1], { label: "Done", value: "3 of 5 planned tasks completed" });
  const partial = reviewSentences(numbers({ plannedMinutes: 600, actualMinutes: 420 }), true);
  assert.equal(partial[0].value, "10 h planned · 7 h tracked (approximate)");
});

test("reviewSentences says nothing tracked yet, and counts done without a plan", () => {
  const lines = reviewSentences(numbers({ doneCount: 2 }));
  assert.equal(lines[0].value, "0 min planned · nothing tracked yet");
  assert.equal(lines[1].value, "2 tasks completed");
});

test("reviewSentences reports the bias only when the week left evidence", () => {
  const quiet = reviewSentences(numbers({ plannedMinutes: 120 }));
  assert.ok(!quiet.some(line => line.label === "Estimation"));
  const withBias = reviewSentences(numbers({ biasRatio: 1.4166666 }));
  assert.deepEqual(withBias[1], { label: "Estimation", value: "Tasks took about 1.4× their estimates." });
});

test("biasSentence speaks plainly outside the neutral band and stays calm inside it", () => {
  assert.equal(biasSentence(1.42), "Tasks took about 1.4× their estimates.");
  assert.equal(biasSentence(0.8), "Tasks took about 0.8× their estimates — faster than planned.");
  assert.equal(biasSentence(1.0), "Time landed close to your estimates.");
});

test("topTaskLines pairs each title with its tracked time", () => {
  assert.deepEqual(topTaskLines([
    { title: "Spec review", minutes: 150 },
    { title: "Email", minutes: 25 },
  ]), [
    { title: "Spec review", value: "2 h 30 min" },
    { title: "Email", value: "25 min" },
  ]);
});

test("the clean-up action table names the three writes", () => {
  assert.deepEqual(cleanupActionLabels, { "this-week": "This week", someday: "Someday", delete: "Delete" });
  assert.equal(cleanupReasonLabel("overdue", "2026-10-23"), "Overdue");
  assert.equal(cleanupReasonLabel("scheduled-not-done", "2026-10-23"), "Was scheduled this week");
});
