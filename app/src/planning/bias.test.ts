import assert from "node:assert/strict";
import test from "node:test";
import { noBiasHint, suggestEstimate, titleTokens, type BiasSample } from "./bias.ts";

/**
 * The learned estimate bias, proved without a clock, a database or a
 * component: every fixture is a plain list of completed tasks, so "three
 * invoices took 1.5x" is three objects here and never a wait. "Now" is not an
 * input, which is why no fixture mentions a date, a zone or DST: the learner
 * compares minutes to minutes and never reads an instant.
 */

/** One completed task as the learner reads it: what was planned, what happened. */
function sample(title: string, estimate: number, actualMinutes: number): BiasSample {
  return { title, estimate, actualMinutes };
}

/** `count` copies of one sample, in the order a task list would hold them. */
function repeated(count: number, title: string, estimate: number, actualMinutes: number): BiasSample[] {
  return Array.from({ length: count }, () => sample(title, estimate, actualMinutes));
}

test("tokens: lowercased, accent-stripped, three letters or more, stop words dropped", () => {
  assert.deepEqual(titleTokens("Send the INVOICE, please"), ["send", "invoice", "please"]);
  assert.deepEqual(titleTokens("Cerrar sesión de Résumé"), ["cerrar", "sesion", "resume"]);
  assert.deepEqual(titleTokens("Go to it"), [], "tokens shorter than three letters never key a ratio");
  assert.deepEqual(titleTokens("The and for with that"), [], "a title of function words carries no key");
  assert.deepEqual(titleTokens("Report report REPORT"), ["report"], "one token counts once per title");
  assert.deepEqual(titleTokens("  "), []);
});

test("no suggestion below the thresholds, and the empty hint names the timer", () => {
  assert.equal(noBiasHint(), "Track a few tasks with the timer to learn your pace.");
  assert.equal(suggestEstimate([], { title: "Send invoice", estimate: 30 }), null);
  assert.equal(
    suggestEstimate([sample("invoice", 30, 45), sample("invoice", 30, 45)], { title: "Send invoice", estimate: 30 }),
    null,
    "two keyed samples are not enough",
  );
});

test("the third keyed sample turns the ratio into a suggestion (n = 2 vs 3)", () => {
  const two = repeated(2, "invoice", 30, 45);
  assert.equal(suggestEstimate(two, { title: "Send invoice", estimate: 30 }), null);
  const three = repeated(3, "invoice", 30, 45);
  assert.deepEqual(suggestEstimate(three, { title: "Send invoice", estimate: 30 }), {
    minutes: 45,
    ratio: 1.5,
    sampleCount: 3,
    source: "keyed",
    token: "invoice",
    message: "Usually takes 45 min for tasks like this.",
  });
});

test("four unrelated samples are not enough globally; the fifth is", () => {
  const others = [
    sample("notes", 30, 60),
    sample("draft", 30, 60),
    sample("review", 30, 60),
    sample("cleanup", 30, 60),
  ];
  assert.equal(suggestEstimate(others, { title: "Send invoice", estimate: 30 }), null);
  const global = suggestEstimate([...others, sample("archive", 30, 60)], { title: "Send invoice", estimate: 30 });
  assert.equal(global?.source, "global");
  assert.equal(global?.sampleCount, 5);
  assert.equal(global?.minutes, 60);
  assert.equal(global?.ratio, 2);
  assert.equal(Object.hasOwn(global!, "token"), false, "a global ratio carries no token");
});

test("the token with the most samples wins, and the keyed answer survives a global gap", () => {
  const samples = [...repeated(3, "invoice", 30, 45), ...repeated(4, "report", 30, 60)];
  const byCount = suggestEstimate(samples, { title: "Invoice report", estimate: 30 });
  assert.equal(byCount?.token, "report");
  assert.equal(byCount?.minutes, 60);

  const tie = suggestEstimate([...repeated(3, "invoice", 30, 45), ...repeated(3, "report", 30, 60)], {
    title: "Invoice report",
    estimate: 30,
  });
  assert.equal(tie?.token, "invoice", "a tie goes to the token that comes first in the title");
  assert.equal(tie?.minutes, 45);
});

test("fewer than three keyed samples fall back to the global ratio", () => {
  const samples = [...repeated(2, "invoice", 30, 45), ...repeated(3, "notes", 30, 60)];
  const fallback = suggestEstimate(samples, { title: "Send invoice", estimate: 30 });
  assert.equal(fallback?.source, "global");
  assert.equal(fallback?.sampleCount, 5);
  assert.equal(fallback?.minutes, 60);
});

test("a ratio is the median, not the mean", () => {
  // Ratios 1, 1, 2: the median is 1 (neutral, no suggestion); a mean would be
  // 1.33 and would have suggested 40 minutes for the same 30-minute task.
  const skewed = [...repeated(2, "invoice", 30, 30), sample("invoice", 30, 60)];
  assert.equal(suggestEstimate(skewed, { title: "Send invoice", estimate: 30 }), null);

  // An even count takes the mean of the two middle values: 1, 1, 1, 3 -> 1.
  const even = [...repeated(3, "invoice", 30, 30), sample("invoice", 30, 90)];
  assert.equal(suggestEstimate(even, { title: "Send invoice", estimate: 30 }), null);
});

test("a ratio of 6 is clamped to 3, and a ratio of 0.2 to 0.5", () => {
  const slow = suggestEstimate(repeated(3, "invoice", 10, 60), { title: "Send invoice", estimate: 30 });
  assert.equal(slow?.ratio, 3);
  assert.equal(slow?.minutes, 90);

  const fast = suggestEstimate(repeated(3, "invoice", 100, 20), { title: "Send invoice", estimate: 40 });
  assert.equal(fast?.ratio, 0.5);
  assert.equal(fast?.minutes, 20);
});

test("the neutral band hides the hint at exactly 0.9 and 1.1, and shows it just outside", () => {
  assert.equal(suggestEstimate(repeated(3, "invoice", 20, 22), { title: "Send invoice", estimate: 40 }), null, "1.1 is neutral");
  assert.equal(suggestEstimate(repeated(3, "invoice", 100, 90), { title: "Send invoice", estimate: 40 }), null, "0.9 is neutral");

  const slower = suggestEstimate(repeated(3, "invoice", 20, 23), { title: "Send invoice", estimate: 40 });
  assert.equal(slower?.minutes, 50, "1.15 x 40 = 46, rounded up to 50");

  const faster = suggestEstimate(repeated(3, "invoice", 100, 89), { title: "Send invoice", estimate: 40 });
  assert.equal(faster?.minutes, 40, "0.89 x 40 = 35.6, rounded up to 40");
});

test("the suggestion is rounded up to a five-minute mark", () => {
  // 27 / 20 = 1.35; 25 x 1.35 = 33.75 -> 35.
  const suggestion = suggestEstimate(repeated(3, "invoice", 20, 27), { title: "Send invoice", estimate: 25 });
  assert.equal(suggestion?.minutes, 35);
});

test("a title matches by token across case and accents", () => {
  const accented = suggestEstimate(repeated(3, "SESIÓN", 30, 45), { title: "Cerrar sesión", estimate: 30 });
  assert.equal(accented?.token, "sesion");
  assert.equal(accented?.minutes, 45);

  const punctuation = suggestEstimate(repeated(3, "Résumé,", 30, 45), { title: "Update RESUME", estimate: 30 });
  assert.equal(punctuation?.token, "resume");
  assert.equal(punctuation?.minutes, 45);
});

test("a task without an estimate is padded from the assumed hour", () => {
  const suggestion = suggestEstimate(repeated(3, "invoice", 30, 45), { title: "Send invoice" });
  assert.equal(suggestion?.minutes, 90);
  assert.equal(suggestion?.message, "Usually takes 1h 30m for tasks like this.");
});

test("only the last 50 samples per key count", () => {
  // 26 older ratios of 3, then 26 newer ratios of 1: the last 50 are 24 x 3 and
  // 26 x 1, whose median is 1 and therefore neutral. Counting all 52 would give
  // a median of 2 and a 60-minute suggestion.
  const capped = [...repeated(26, "invoice", 30, 90), ...repeated(26, "invoice", 30, 30)];
  assert.equal(suggestEstimate(capped, { title: "invoice", estimate: 30 }), null);

  // The same 52 samples in the opposite order: the last 50 are 24 x 1 and
  // 26 x 3, whose median is 3.
  const reversed = [...repeated(26, "invoice", 30, 30), ...repeated(26, "invoice", 30, 90)];
  assert.equal(suggestEstimate(reversed, { title: "invoice", estimate: 30 })?.minutes, 90);
});

test("samples without a usable estimate or a five-minute session are ignored", () => {
  const noEstimate: BiasSample[] = [{ title: "invoice", actualMinutes: 45 }, { title: "invoice", actualMinutes: 45 }];
  assert.equal(suggestEstimate(noEstimate, { title: "invoice", estimate: 30 }), null);

  assert.equal(suggestEstimate(repeated(3, "invoice", 30, 4), { title: "invoice", estimate: 30 }), null, "4 minutes is not a session");
  // 5 minutes is a session: 5 / 30 = 0.17, clamped to 0.5, so 30 -> 15.
  assert.equal(suggestEstimate(repeated(3, "invoice", 30, 5), { title: "invoice", estimate: 30 })?.minutes, 15);

  const junk: BiasSample[] = [
    { title: "invoice", estimate: 0, actualMinutes: 30 },
    { title: "invoice", estimate: -5, actualMinutes: 30 },
    { title: "invoice", estimate: 30, actualMinutes: Number.NaN },
    { title: "invoice", estimate: 30, actualMinutes: -1 },
  ];
  assert.equal(suggestEstimate(junk, { title: "invoice", estimate: 30 }), null);
});

test("the learner reads its inputs and never changes them", () => {
  const samples = Object.freeze(repeated(3, "invoice", 30, 45).map((item) => Object.freeze(item)));
  const query = Object.freeze({ title: "Send invoice", estimate: 30 });
  const suggestion = suggestEstimate(samples, query);
  assert.equal(suggestion?.minutes, 45);
  assert.deepEqual(samples, repeated(3, "invoice", 30, 45));
  assert.deepEqual(query, { title: "Send invoice", estimate: 30 });
});
