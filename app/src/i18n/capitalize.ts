import { getLocale, intlLocale, type Locale } from "./index.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Upper-cases the first grapheme of a formatted date or relative day that opens
 * a heading, a trigger label or a sentence ("martes, 29 de septiembre" ->
 * "Martes, 29 de septiembre"). Spanish `Intl` output is lowercase; English is
 * already capitalised, so it passes through unchanged. Never use it on a date
 * that sits inside a sentence.
 *
 * `locale` is the app language (default: the current one) or any BCP 47 tag.
 */
export function capitalize(text: string, locale: Locale | string = getLocale()): string {
  const first = segmenter.segment(text)[Symbol.iterator]().next();
  if (first.done) return text;
  const tag = locale === "en" || locale === "es" ? intlLocale(locale) : locale;
  return first.value.segment.toLocaleUpperCase(tag) + text.slice(first.value.segment.length);
}
