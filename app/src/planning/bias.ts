/**
 * Learned estimate bias ("estimate vs actual").
 *
 * The planner learns one thing from finished work: how much longer (or
 * shorter) a task really took than the estimate said. The learned number is a
 * *suggestion* and nothing else: this module never writes a stored estimate,
 * so a task's estimate stays exactly what its owner wrote until they accept
 * the offer in the UI.
 *
 * The rule is deliberately conservative, because a wrong padding is worse than
 * no padding:
 *
 * - a sample is a task that was actually tracked: it has an estimate and at
 *   least five minutes of `actualMinutes` (calls shorter than that are noise);
 * - a sample belongs to every title token it carries (lowercased, accents
 *   stripped, three letters or more, function words dropped), and the ratios
 *   of one token are keyed to that token;
 * - a new task takes the token with the most samples among its tokens, which
 *   needs **3** samples; with fewer, the global ratio over all samples needs
 *   **5**; with fewer still there is no suggestion at all;
 * - the ratio is the **median** of `actual / estimate` (one slow task must not
 *   drag the pace), clamped to **[0.5, 3]**;
 * - the suggestion is `ceil5(estimate × ratio)` and is shown only when the
 *   ratio is outside **0.9..1.1**, so a task that is already estimated well
 *   gets no hint;
 * - only the last **50** samples per key count, so an old project does not
 *   outvote the way the same person works now. Samples are given oldest first,
 *   which is the order a task list read from the data layer already has.
 *
 * A keyed answer with three samples is final, even when it is neutral: falling
 * back to the global pace would tell someone who is accurate at this kind of
 * work that they are slow at everything. The global ratio is consulted only
 * when no token has three samples.
 *
 * Everything here is a pure function: no Firebase, no React, no clock. Ratios
 * compare minutes to minutes, so no timezone, DST rule or midnight boundary can
 * change the answer, and a caller may read a task's completion instant however
 * it likes before handing the list over.
 */

import { ASSUMED_ESTIMATE_MINUTES, formatEstimate } from "../domain/model.ts";
import { t } from "../i18n/index.ts";

/** A tracked session shorter than this is noise, not a measurement. */
export const MIN_ACTUAL_MINUTES = 5;

/** Samples one title token needs before its own ratio may be used. */
export const MIN_KEYED_SAMPLES = 3;

/** Samples the whole history needs before the global ratio may be used. */
export const MIN_GLOBAL_SAMPLES = 5;

/** Samples per key that count: the newest ones, in input order. */
export const SAMPLES_PER_KEY = 50;

/** A pace outside this band is real evidence; inside it, the estimate stands. */
export const MIN_RATIO = 0.5;
export const MAX_RATIO = 3;
export const NEUTRAL_RATIO_MIN = 0.9;
export const NEUTRAL_RATIO_MAX = 1.1;

/** The words a hint shows when there is nothing to learn from yet. */
export const noBiasHint = (): string => t("bias.empty");

/**
 * A task as the learner reads it: its title, what it was estimated at, and the
 * minutes the focus timer recorded. Both numbers are optional because a task
 * list contains untracked, unestimated work too; a sample with a missing or
 * unusable value is simply skipped.
 */
export type BiasSample = { title: string; estimate?: number; actualMinutes?: number };

/** The task being estimated: a title to key on and the estimate to pad. */
export type BiasQuery = { title: string; estimate?: number };

/** What the UI may offer, never what it may store. */
export type BiasSuggestion = {
  /** The padded estimate, a positive multiple of five minutes. */
  minutes: number;
  /** The median ratio the suggestion came from, after clamping. */
  ratio: number;
  /** How many samples that ratio was computed over. */
  sampleCount: number;
  /** Whether the ratio came from the task's own token or from all samples. */
  source: "keyed" | "global";
  /** The token that carried the keyed ratio; absent for a global ratio. */
  token?: string;
  /** The sentence a surface shows next to the offer. */
  message: string;
};

/**
 * Words that carry no subject: articles, pronouns, prepositions, conjunctions
 * and auxiliaries, in the two languages task titles are written in here. The
 * list is small on purpose - a verb like "send" still distinguishes work. They
 * are stored already normalized (lowercase, no accents) because that is the
 * form the tokenizer compares.
 */
const stopWords = new Set([
  "the", "and", "for", "with", "that", "this", "from", "you", "your", "not",
  "are", "was", "were", "have", "has", "had", "will", "but", "its", "all",
  "any", "our", "out", "who", "how", "one", "two", "then", "than", "too",
  "can", "into", "onto", "over", "she", "his", "her", "him", "they", "them",
  "their", "there", "been", "being", "what", "when", "where", "which",
  "que", "con", "por", "para", "una", "uno", "del", "los", "las", "sus",
  "este", "esta", "esto", "esos", "esas", "como", "mas", "sin", "son", "fue",
  "ser", "hay", "muy", "dos", "tres", "nos", "les", "ese", "esa", "cada",
]);

/** Lowercase and unaccent one word, so "Sesión" and "sesion" are the same key. */
export function normalize(word: string): string {
  return word
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * The key tokens of a title, in the order they appear and without repeats.
 * Punctuation separates words, short words and function words carry no key,
 * and one word counts once however often the title repeats it.
 */
export function titleTokens(title: string): string[] {
  const tokens: string[] = [];
  for (const word of title.split(/[^\p{L}\p{N}]+/u)) {
    const token = normalize(word);
    if (token.length < 3 || stopWords.has(token) || tokens.includes(token)) continue;
    tokens.push(token);
  }
  return tokens;
}

/** The `actual / estimate` ratio of one sample, or null when it is not a sample. */
function sampleRatio(sample: BiasSample): number | null {
  const estimate = sample.estimate;
  const actual = sample.actualMinutes;
  if (typeof estimate !== "number" || !Number.isFinite(estimate) || estimate <= 0) return null;
  if (typeof actual !== "number" || !Number.isFinite(actual) || actual < MIN_ACTUAL_MINUTES) return null;
  return actual / estimate;
}

/** The middle value, or the mean of the two middle values for an even count. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Round up to the next five-minute mark, the granularity an estimate has. */
function ceil5(minutes: number): number {
  return Math.ceil(minutes / 5) * 5;
}

/** One token's capped ratio list, plus the ratios of every usable sample. */
export function collect(samples: readonly BiasSample[]): { byToken: Map<string, number[]>; all: number[] } {
  const byToken = new Map<string, number[]>();
  const all: number[] = [];
  for (const sample of samples) {
    const ratio = sampleRatio(sample);
    if (ratio === null) continue;
    all.push(ratio);
    for (const token of titleTokens(sample.title)) {
      const list = byToken.get(token);
      if (list) list.push(ratio);
      else byToken.set(token, [ratio]);
    }
  }
  return { byToken, all };
}

/** The best keyed ratio for a title: most samples, ties to the earliest token. */
function keyedRatio(
  byToken: Map<string, number[]>,
  tokens: readonly string[],
): { ratio: number; count: number; token: string } | null {
  let best: { values: number[]; token: string } | null = null;
  for (const token of tokens) {
    const values = byToken.get(token)?.slice(-SAMPLES_PER_KEY);
    if (!values || values.length < MIN_KEYED_SAMPLES) continue;
    if (best === null || values.length > best.values.length) best = { values, token };
  }
  return best === null ? null : { ratio: median(best.values), count: best.values.length, token: best.token };
}

/** The offer for one task, or null when the pace is unknown or already fine. */
export function suggestEstimate(samples: readonly BiasSample[], query: BiasQuery): BiasSuggestion | null {
  const { byToken, all } = collect(samples);

  const keyed = keyedRatio(byToken, titleTokens(query.title));
  const global =
    all.length >= MIN_GLOBAL_SAMPLES ? { ratio: median(all), count: all.length } : null;
  const pace = keyed ?? global;
  if (pace === null) return null;

  const ratio = clamp(pace.ratio, MIN_RATIO, MAX_RATIO);
  if (ratio >= NEUTRAL_RATIO_MIN && ratio <= NEUTRAL_RATIO_MAX) return null;

  // A task without an estimate is padded from the assumed hour, exactly as the
  // radar and plan-my-day read it: one assumption, spent once, never stored.
  const estimate = query.estimate;
  const base =
    typeof estimate === "number" && Number.isFinite(estimate) && estimate > 0 ? estimate : ASSUMED_ESTIMATE_MINUTES;
  const minutes = ceil5(base * ratio);

  return {
    minutes,
    ratio,
    sampleCount: pace.count,
    source: keyed === null ? "global" : "keyed",
    ...(keyed === null ? {} : { token: keyed.token }),
    message: t("bias.message", { estimate: formatEstimate(minutes) }),
  };
}
