import assert from "node:assert/strict";
import test from "node:test";
import { dateKey } from "../ui/time.ts";
import { parseQuickAdd, type QuickAddFrequency } from "./quickAdd.ts";

/**
 * Table-driven cases for the natural-language quick add (value roadmap §2.2).
 *
 * Every case names the whole contract at once: the text, the instant the user
 * typed it, the planner's zone, and what must come out (a clean title, a
 * deadline day key, a repeat). One row is one rule, so a rule that regresses is
 * named by its own row instead of being buried in a multi-assertion test.
 */

/** Wed 21 Oct 2026, 09:00 in Buenos Aires (UTC-03:00). */
const wednesday = "2026-10-21T12:00:00Z";
const buenosAires = "America/Argentina/Buenos_Aires";

type Case = {
  /** The row's name: the rule it pins. */
  name: string;
  text: string;
  now?: string;
  zone?: string;
  /** Matched texts whose chip the user undid: they stay in the title. */
  ignore?: string[];
  title: string;
  deadline?: string;
  frequency?: QuickAddFrequency;
  anchorDate?: string;
  /** The matched texts, in the order they appear in the input. */
  parts?: string[];
};

const cases: Case[] = [
  {
    name: "a plain title passes through untouched",
    text: "call mom",
    title: "call mom",
  },
  {
    name: "a blank title stays blank",
    text: "   ",
    title: "",
  },
  {
    name: "tomorrow is the next calendar day",
    text: "pay rent tomorrow",
    title: "pay rent",
    deadline: "2026-10-22",
    parts: ["tomorrow"],
  },
  {
    name: "today is the planner's own day",
    text: "ship it today",
    title: "ship it",
    deadline: "2026-10-21",
    parts: ["today"],
  },
  {
    name: "hoy is today in Spanish",
    text: "llamar a mamá hoy",
    title: "llamar a mamá",
    deadline: "2026-10-21",
    parts: ["hoy"],
  },
  {
    name: "mañana is tomorrow, with or without the tilde",
    text: "llamar mañana",
    title: "llamar",
    deadline: "2026-10-22",
    parts: ["mañana"],
  },
  {
    name: "manana without the tilde is tomorrow too",
    text: "llamar manana",
    title: "llamar",
    deadline: "2026-10-22",
    parts: ["manana"],
  },
  {
    name: "pasado mañana is the day after tomorrow",
    text: "pagar pasado mañana",
    title: "pagar",
    deadline: "2026-10-23",
    parts: ["pasado mañana"],
  },
  {
    name: "el sábado que viene is the same weekday in the following week",
    text: "asado el sábado que viene",
    title: "asado",
    deadline: "2026-10-31",
    parts: ["el sábado que viene"],
  },
  {
    name: "a Spanish date with its article",
    text: "vence el 25/10",
    title: "vence",
    deadline: "2026-10-25",
    parts: ["el 25/10"],
  },
  {
    name: "a day that does not exist in that month is not a date",
    text: "vence el 31/02",
    title: "vence el 31/02",
  },
  {
    name: "recognition ignores casing",
    text: "Pay Rent TOMORROW",
    title: "Pay Rent",
    deadline: "2026-10-22",
    parts: ["TOMORROW"],
  },
  {
    name: "a bare weekday resolves to its next occurrence",
    text: "call mom fri",
    title: "call mom",
    deadline: "2026-10-23",
    parts: ["fri"],
  },
  {
    name: "a weekday that is today resolves to today, never to the past",
    text: "standup wed",
    title: "standup",
    deadline: "2026-10-21",
    parts: ["wed"],
  },
  {
    name: "next and a weekday means the following week",
    text: "call mom next fri",
    title: "call mom",
    deadline: "2026-10-30",
    parts: ["next fri"],
  },
  {
    name: "a Spanish weekday with its accent",
    text: "reunión el jueves",
    title: "reunión",
    deadline: "2026-10-22",
    parts: ["el jueves"],
  },
  {
    name: "a Spanish weekday typed without its accent",
    text: "reunión miercoles",
    title: "reunión",
    deadline: "2026-10-21",
    parts: ["miercoles"],
  },
  {
    name: "the three-letter Spanish abbreviation",
    text: "plan lun",
    title: "plan",
    deadline: "2026-10-26",
    parts: ["lun"],
  },
  {
    name: "in N days",
    text: "review PR in 2 days",
    title: "review PR",
    deadline: "2026-10-23",
    parts: ["in 2 days"],
  },
  {
    name: "en N días, with its accent",
    text: "revisar en 3 días",
    title: "revisar",
    deadline: "2026-10-24",
    parts: ["en 3 días"],
  },
  {
    name: "dd/mm is a day and a month in the planner's zone",
    text: "dentist 25/10",
    title: "dentist",
    deadline: "2026-10-25",
    parts: ["25/10"],
  },
  {
    name: "dd/mm/yyyy keeps the year",
    text: "dentist 25/10/2027",
    title: "dentist",
    deadline: "2027-10-25",
    parts: ["25/10/2027"],
  },
  {
    name: "a dd/mm already past this year is the next year's",
    text: "dentist 25/10",
    now: "2026-11-01T12:00:00Z",
    title: "dentist",
    deadline: "2027-10-25",
    parts: ["25/10"],
  },
  {
    name: "an explicit year in the past is not a date the planner takes",
    text: "meeting 01/01/2020",
    title: "meeting 01/01/2020",
  },
  {
    name: "a day and a month name",
    text: "trip 25 oct",
    title: "trip",
    deadline: "2026-10-25",
    parts: ["25 oct"],
  },
  {
    name: "a day and a Spanish month name",
    text: "viaje 25 de octubre",
    title: "viaje",
    deadline: "2026-10-25",
    parts: ["25 de octubre"],
  },
  {
    name: "a month name before the day",
    text: "trip oct 25",
    title: "trip",
    deadline: "2026-10-25",
    parts: ["oct 25"],
  },
  {
    name: "tomorrow crosses a month boundary",
    text: "report tomorrow",
    now: "2026-10-31T12:00:00Z",
    title: "report",
    deadline: "2026-11-01",
    parts: ["tomorrow"],
  },
  {
    name: "in N days crosses a year boundary",
    text: "review in 2 days",
    now: "2026-12-30T12:00:00Z",
    title: "review",
    deadline: "2027-01-01",
    parts: ["in 2 days"],
  },
  {
    name: "late at night in the profile zone, the day is still the profile zone's",
    text: "pay rent tomorrow",
    // 23:30 on Wed 21 Oct in Buenos Aires, already Thu 22 Oct in UTC.
    now: "2026-10-22T02:30:00Z",
    title: "pay rent",
    deadline: "2026-10-22",
    parts: ["tomorrow"],
  },
  {
    name: "a zone ahead of UTC keeps its own day, not UTC's",
    text: "ship it today",
    // 05:00 on Wed 21 Oct in Tokyo, still Tue 20 Oct in UTC.
    now: "2026-10-20T20:00:00Z",
    zone: "Asia/Tokyo",
    title: "ship it",
    deadline: "2026-10-21",
    parts: ["today"],
  },
  {
    name: "a zone ahead of UTC advances on its own midnight",
    text: "ship it tomorrow",
    now: "2026-10-20T20:00:00Z",
    zone: "Asia/Tokyo",
    title: "ship it",
    deadline: "2026-10-22",
    parts: ["tomorrow"],
  },
  {
    name: "the day after a spring-forward DST change is one day later",
    text: "call mom tomorrow",
    // 00:30 on Mon 9 Mar 2026 in New York: the DST change was 23 hours ago.
    now: "2026-03-09T04:30:00Z",
    zone: "America/New_York",
    title: "call mom",
    deadline: "2026-03-10",
    parts: ["tomorrow"],
  },
  {
    name: "the day after a fall-back DST change is one day later",
    text: "call mom tomorrow",
    // 23:30 on Sun 1 Nov 2026 in New York: the DST change was two hours ago.
    now: "2026-11-02T04:30:00Z",
    zone: "America/New_York",
    title: "call mom",
    deadline: "2026-11-02",
    parts: ["tomorrow"],
  },
  {
    name: "every and a weekday is a weekly series starting on that day",
    text: "standup every mon",
    title: "standup",
    frequency: "weekly",
    anchorDate: "2026-10-26",
    parts: ["every mon"],
  },
  {
    name: "cada and a weekday in Spanish",
    text: "gimnasio cada martes",
    title: "gimnasio",
    frequency: "weekly",
    anchorDate: "2026-10-27",
    parts: ["cada martes"],
  },
  {
    name: "todos los días is daily",
    text: "gym todos los días",
    title: "gym",
    frequency: "daily",
    anchorDate: "2026-10-21",
    parts: ["todos los días"],
  },
  {
    name: "daily, weekly and monthly are frequencies",
    text: "daily standup",
    title: "standup",
    frequency: "daily",
    anchorDate: "2026-10-21",
    parts: ["daily"],
  },
  {
    name: "weekly is a frequency",
    text: "weekly review",
    title: "review",
    frequency: "weekly",
    anchorDate: "2026-10-21",
    parts: ["weekly"],
  },
  {
    name: "monthly is a frequency",
    text: "monthly report",
    title: "report",
    frequency: "monthly",
    anchorDate: "2026-10-21",
    parts: ["monthly"],
  },
  {
    name: "every month is monthly",
    text: "pay rent every month",
    title: "pay rent",
    frequency: "monthly",
    anchorDate: "2026-10-21",
    parts: ["every month"],
  },
  {
    name: "every weekday is not one of the model's frequencies, so it stays",
    text: "gym every weekday",
    title: "gym every weekday",
  },
  {
    name: "every other monday is not supported either",
    text: "plan every other monday",
    title: "plan every other monday",
  },
  {
    name: "a repeat and an explicit date agree on the first occurrence",
    text: "review every week 13/11",
    title: "review",
    deadline: "2026-11-13",
    frequency: "weekly",
    anchorDate: "2026-11-13",
    parts: ["every week", "13/11"],
  },
  {
    name: "a time of day stays in the title: the model has no time field",
    text: "call mom fri 3pm",
    title: "call mom 3pm",
    deadline: "2026-10-23",
    parts: ["fri"],
  },
  {
    name: "an hs time stays in the title too",
    text: "dentist 25/10 16hs",
    title: "dentist 16hs",
    deadline: "2026-10-25",
    parts: ["25/10"],
  },
  {
    name: "only the first of two dates is taken",
    text: "tomorrow or friday",
    title: "or friday",
    deadline: "2026-10-22",
    parts: ["tomorrow"],
  },
  {
    name: "a matched part at the start leaves a clean title",
    text: "tomorrow pay rent",
    title: "pay rent",
    deadline: "2026-10-22",
    parts: ["tomorrow"],
  },
  {
    name: "punctuation around a matched part is cleaned up",
    text: "call mom, fri.",
    title: "call mom",
    deadline: "2026-10-23",
    parts: ["fri"],
  },
  {
    name: "a word that only starts like a weekday is not a weekday",
    text: "monitor the build",
    title: "monitor the build",
  },
  {
    name: "a number that is not a date stays in the title",
    text: "buy 3 apples",
    title: "buy 3 apples",
  },
  {
    name: "an undone chip keeps its text in the title",
    text: "call mom fri",
    ignore: ["fri"],
    title: "call mom fri",
  },
  {
    name: "an undone chip is matched case-insensitively",
    text: "call mom FRI",
    ignore: ["fri"],
    title: "call mom FRI",
  },
  {
    name: "undoing the date keeps the repeat working",
    text: "standup every mon 25/10",
    ignore: ["25/10"],
    title: "standup 25/10",
    frequency: "weekly",
    anchorDate: "2026-10-26",
    parts: ["every mon"],
  },
];

for (const item of cases) {
  test(item.name, () => {
    const text = item.text;
    const result = parseQuickAdd(text, {
      now: new Date(item.now ?? wednesday),
      timeZone: item.zone ?? buenosAires,
      ...(item.ignore === undefined ? {} : { ignore: item.ignore }),
    });

    assert.equal(result.title, item.title, "title");
    assert.equal(result.deadline, item.deadline, "deadline");
    assert.equal(result.frequency, item.frequency, "frequency");
    assert.equal(result.anchorDate, item.anchorDate, "anchorDate");
    assert.deepEqual(
      result.parts.map(part => part.text),
      item.parts ?? [],
      "matched parts",
    );

    // Every part points at the exact slice of the input it consumed, so the
    // sheet can put that text back in the title when the user undoes a chip.
    for (const part of result.parts) {
      assert.ok(part.start < part.end, `part ${part.text} has a positive span`);
      assert.equal(text.slice(part.start, part.end), part.text, `part ${part.text} matches its span`);
    }
    assert.deepEqual(
      result.parts.map(part => part.kind),
      [...new Set(result.parts.map(part => part.kind))],
      "at most one part of each kind",
    );
  });
}

test("the planner's day agrees with the app's own zone helpers", () => {
  const now = new Date("2026-10-21T02:30:00Z");
  for (const zone of ["UTC", "America/Argentina/Buenos_Aires", "Asia/Tokyo", "Pacific/Kiritimati", "Pacific/Niue"]) {
    const result = parseQuickAdd("ship it today", { now, timeZone: zone });
    assert.equal(result.deadline, dateKey(now, zone), `today in ${zone}`);
  }
});
