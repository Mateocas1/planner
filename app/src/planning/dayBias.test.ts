import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setDeviceLanguage } from "../i18n/index.ts";
import type { BiasSample } from "./bias.ts";
import { dayBias } from "./dayBias.ts";

/**
 * The day-replay bias sentence (day-replay plan §5), proved on plain lists:
 * the completed history the learner already reads, plus the titles of the
 * tasks that were tracked or finished today. No clock, no zone, no database.
 */

afterEach(() => setDeviceLanguage(null));

const NBSP = "\u00a0";

function sample(title: string, estimate: number, actualMinutes: number): BiasSample {
  return { title, estimate, actualMinutes };
}

function repeated(count: number, title: string, estimate: number, actualMinutes: number): BiasSample[] {
  return Array.from({ length: count }, () => sample(title, estimate, actualMinutes));
}

const today = (...titles: string[]) => titles.map(title => ({ title }));

test("rounding: the percent is the distance from 1 to the nearest five", () => {
  const percent = (actual: number) => dayBias(repeated(3, "Meeting", 100, actual), today("Meeting"))?.percent;
  assert.equal(percent(130), 30);
  assert.equal(percent(127), 25);
  assert.equal(percent(112), 10);
  assert.equal(percent(80), 20);
  assert.equal(percent(1000), 200, "the ratio is clamped to 3 before it is worded");
});

test("neutral and short evidence stay silent", () => {
  assert.equal(dayBias(repeated(3, "Meeting", 100, 105), today("Meeting")), null, "ratio 1.05 is inside the band");
  assert.equal(dayBias(repeated(3, "Meeting", 100, 110), today("Meeting")), null, "1.1 is the edge of the band");
  assert.equal(dayBias(repeated(3, "Meeting", 100, 90), today("Meeting")), null, "0.9 is the edge of the band");
  assert.equal(dayBias(repeated(2, "Meeting", 100, 150), today("Meeting")), null, "two keyed samples are too few");
  assert.equal(dayBias(repeated(4, "Meeting", 100, 150), today("Report")), null, "four global samples are too few");
  assert.equal(dayBias([], today("Meeting")), null);
});

test("nothing tracked or finished today is silent", () => {
  assert.equal(dayBias(repeated(5, "Meeting", 100, 150), []), null);
});

test("samples under five tracked minutes or without an estimate do not count", () => {
  const noise: BiasSample[] = [
    ...repeated(2, "Meeting", 2, 4),
    { title: "Meeting", actualMinutes: 60 },
    { title: "Meeting", estimate: 30 },
  ];
  assert.equal(dayBias([...repeated(2, "Meeting", 100, 150), ...noise], today("Meeting")), null);
});

test("keyed beats global: three samples on a title word of today", () => {
  const history = [...repeated(3, "Meeting with team", 100, 130), ...repeated(6, "Chore", 100, 200)];
  const result = dayBias(history, today("Weekly meeting"));
  assert.ok(result);
  assert.equal(result.kind, "keyed");
  assert.equal(result.word, "meeting");
  assert.equal(result.direction, "under");
  assert.equal(result.sampleCount, 3);
  assert.equal(result.sentence, "You underestimate “meeting” tasks by 30%.");
  assert.equal(result.basis, "Based on 3 finished tasks.");
});

test("a keyed ratio inside the band is final: it does not fall back to the global pace", () => {
  const history = [...repeated(3, "Meeting", 100, 100), ...repeated(6, "Chore", 100, 200)];
  assert.equal(dayBias(history, today("Meeting")), null);
});

test("global fallback at five samples when no word of today has three", () => {
  const history = [
    sample("Alpha", 100, 125),
    sample("Bravo", 100, 125),
    sample("Charlie", 100, 125),
    sample("Delta", 100, 125),
    sample("Echo", 100, 125),
  ];
  const result = dayBias(history, today("Zulu"));
  assert.ok(result);
  assert.equal(result.kind, "global");
  assert.equal(result.word, undefined);
  assert.equal(result.direction, "under");
  assert.equal(result.sentence, "Your tasks take 25% longer than you estimate.");
  assert.equal(result.basis, "Based on 5 finished tasks.");
});

test("global pace faster than the estimates", () => {
  const history = Array.from({ length: 5 }, (_, index) => sample(`Task${index}`, 100, 70));
  const result = dayBias(history, today("Zulu"));
  assert.ok(result);
  assert.equal(result.direction, "over");
  assert.equal(result.sentence, "Your tasks take 30% less time than you estimate.");
});

test("the candidate with most samples wins; a tie goes to the larger gap", () => {
  const most = [...repeated(4, "Meeting", 100, 120), ...repeated(3, "Report", 100, 180)];
  assert.equal(dayBias(most, today("Meeting", "Report"))?.word, "meeting", "4 samples beat 3");
  const tie = [...repeated(3, "Meeting", 100, 120), ...repeated(3, "Report", 100, 180)];
  assert.equal(dayBias(tie, today("Meeting", "Report"))?.word, "report", "equal samples: ratio 1.8 beats 1.2");
});

test("only words of today's tasks are candidates", () => {
  const history = [...repeated(3, "Meeting", 100, 130), ...repeated(3, "Report", 100, 100)];
  assert.equal(dayBias(history, today("Report")), null, "report is neutral and final");
  assert.equal(dayBias(history, today("Meeting"))?.word, "meeting");
});

test("only the last 50 samples of a word count", () => {
  const history = [...repeated(60, "Meeting", 100, 200), ...repeated(50, "Meeting", 100, 130)];
  const result = dayBias(history, today("Meeting"));
  assert.ok(result);
  assert.equal(result.percent, 30);
  assert.equal(result.sampleCount, 50);
});

test("an accented word keeps its accent, matched without it", () => {
  const history = repeated(3, "reunion", 100, 130);
  const result = dayBias(history, today("Reunión semanal"));
  assert.ok(result);
  assert.equal(result.word, "reunión");
  assert.equal(result.sentence, "You underestimate “reunión” tasks by 30%.");
});

test("over: the keyed sentence in English", () => {
  const result = dayBias(repeated(3, "Report", 100, 80), today("Report"));
  assert.equal(result?.sentence, "You overestimate “report” tasks by 20%.");
  assert.equal(result?.direction, "over");
});

test("Spanish: neutral tú, spaced percent, plural basis", () => {
  setDeviceLanguage("es");
  const under = dayBias(repeated(3, "Reunión", 30, 39), today("Reunión"));
  assert.equal(under?.sentence, `Subestimas las tareas de «reunión» un 30${NBSP}%.`);
  assert.equal(under?.basis, "Según 3 tareas terminadas.");
  const over = dayBias(repeated(3, "Informe", 100, 80), today("Informe"));
  assert.equal(over?.sentence, `Sobreestimas las tareas de «informe» un 20${NBSP}%.`);
  const history = Array.from({ length: 5 }, (_, index) => sample(`Tarea${index}`, 100, 125));
  assert.equal(dayBias(history, today("Otra"))?.sentence, `Tus tareas llevan un 25${NBSP}% más de lo que estimas.`);
  const faster = Array.from({ length: 5 }, (_, index) => sample(`Tarea${index}`, 100, 70));
  assert.equal(dayBias(faster, today("Otra"))?.sentence, `Tus tareas llevan un 30${NBSP}% menos de lo que estimas.`);
});
