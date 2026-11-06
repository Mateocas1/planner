/**
 * The day replay's closing sentence (day-replay plan §5): one line about how
 * the person's estimates compare with what the focus timer recorded.
 *
 * It reads the same evidence as `BiasHint` (`bias.ts`: finished tasks with an
 * estimate and at least five tracked minutes, ratios keyed to title words,
 * the last 50 per word, median, clamp to [0.5, 3]) and the same thresholds
 * (3 samples for a word, 5 overall, silent inside 0.9..1.1), so the replay
 * never contradicts the hint. Two differences, both about *today*:
 *
 * - the candidate words come from the tasks tracked or finished today, because
 *   the sentence is a reflection on this day, not on the whole history;
 * - among the words with enough samples the one with the most samples wins and
 *   a tie goes to the larger gap from 1, since the sentence should name the
 *   most striking pattern the evidence can carry.
 *
 * As in `bias.ts`, a word with enough samples is final even when neutral: the
 * sentence then stays silent instead of falling back to a global pace that
 * would say something false about that kind of work. With no such word, the
 * global median speaks, from five samples.
 *
 * Pure: no clock, no zone, no Firebase, no React. Ratios compare minutes with
 * minutes. The caller passes `completedSamples(tasks)` and the titles of
 * today's tracked or finished tasks (an empty list means a quiet day, which is
 * silent).
 */

import { getLocale, intlLocale, t } from "../i18n/index.ts";
import {
  MAX_RATIO,
  MIN_GLOBAL_SAMPLES,
  MIN_KEYED_SAMPLES,
  MIN_RATIO,
  NEUTRAL_RATIO_MAX,
  NEUTRAL_RATIO_MIN,
  SAMPLES_PER_KEY,
  clamp,
  collect,
  median,
  normalize,
  titleTokens,
  type BiasSample,
} from "./bias.ts";

/** A task tracked or finished today; only its title matters here. */
export type DayBiasTask = { title: string };

export type DayBias = {
  /** The localized sentence the replay prints. */
  sentence: string;
  /** The muted evidence line below it ("Based on 3 finished tasks."). */
  basis: string;
  kind: "keyed" | "global";
  /** `under`: the work took longer than estimated; `over`: it took less. */
  direction: "under" | "over";
  /** The distance from a perfect estimate, rounded to the nearest five. */
  percent: number;
  /** The clamped median ratio the sentence came from. */
  ratio: number;
  sampleCount: number;
  /** The title word the sentence names, lowercased with its accents; keyed only. */
  word?: string;
};

type Pace = { ratio: number; count: number; token?: string };

/** The title word (as written, lowercased) whose unaccented form is `token`. */
function wordFor(token: string, titles: readonly string[]): string {
  for (const title of titles) {
    for (const word of title.split(/[^\p{L}\p{N}]+/u)) {
      if (normalize(word) === token) return word.toLowerCase();
    }
  }
  return token;
}

/** The pace of the best title word of today, or null when none has enough samples. */
function keyedPace(byToken: Map<string, number[]>, today: readonly DayBiasTask[]): Pace | null {
  let best: { ratio: number; count: number; token: string; gap: number } | null = null;
  const seen = new Set<string>();
  for (const task of today) {
    for (const token of titleTokens(task.title)) {
      if (seen.has(token)) continue;
      seen.add(token);
      const values = byToken.get(token)?.slice(-SAMPLES_PER_KEY);
      if (!values || values.length < MIN_KEYED_SAMPLES) continue;
      const ratio = clamp(median(values), MIN_RATIO, MAX_RATIO);
      const gap = Math.abs(ratio - 1);
      if (best === null || values.length > best.count || (values.length === best.count && gap > best.gap)) {
        best = { ratio, count: values.length, token, gap };
      }
    }
  }
  return best === null ? null : { ratio: best.ratio, count: best.count, token: best.token };
}

/** The sentence about the estimate bias, or null when the evidence is short or neutral. */
export function dayBias(samples: readonly BiasSample[], today: readonly DayBiasTask[]): DayBias | null {
  if (today.length === 0) return null;
  const { byToken, all } = collect(samples);

  const keyed = keyedPace(byToken, today);
  const pace: Pace | null =
    keyed ?? (all.length >= MIN_GLOBAL_SAMPLES ? { ratio: clamp(median(all), MIN_RATIO, MAX_RATIO), count: all.length } : null);
  if (pace === null) return null;
  if (pace.ratio >= NEUTRAL_RATIO_MIN && pace.ratio <= NEUTRAL_RATIO_MAX) return null;

  const under = pace.ratio > 1;
  const percent = Math.round((Math.abs(pace.ratio - 1) * 100) / 5) * 5;
  const shown = new Intl.NumberFormat(intlLocale(getLocale()), { style: "percent" }).format(percent / 100);
  const basis = t("dayBias.basis", { count: pace.count });

  if (keyed === null || pace.token === undefined) {
    return {
      sentence: t(under ? "dayBias.longer" : "dayBias.shorter", { percent: shown }),
      basis,
      kind: "global",
      direction: under ? "under" : "over",
      percent,
      ratio: pace.ratio,
      sampleCount: pace.count,
    };
  }
  const word = wordFor(pace.token, today.map(task => task.title));
  return {
    sentence: t(under ? "dayBias.under" : "dayBias.over", { word, percent: shown }),
    basis,
    kind: "keyed",
    direction: under ? "under" : "over",
    percent,
    ratio: pace.ratio,
    sampleCount: pace.count,
    word,
  };
}
