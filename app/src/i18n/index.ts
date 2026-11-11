import { useEffect, useSyncExternalStore } from "react";
import { dictionaries } from "./dictionaries.ts";
import type { Args, MessageKey, Plural } from "./types.ts";

/**
 * The app's language: a tiny typed dictionary, no library.
 *
 * The effective language is `device override ?? synced account choice ?? en`:
 *
 * - the **device override** is `localStorage["planner-language"]`, set when the
 *   user picks "only on this device";
 * - the **synced choice** is the optional `language` field of the Firestore
 *   profile, fed in by the signed-in shell through `setSyncedLanguage`. `undefined`
 *   means the profile is not known yet (signed out, loading, offline error) and
 *   the last effective language, cached in `localStorage["planner-language-last"]`,
 *   stands in; `null` means the profile loaded and holds no choice (English);
 * - there is no browser-language detection: English is the unconditional default.
 *
 * The cache is what the windows without a profile (auth form, quick-add window,
 * focus pill) read synchronously at start; the `storage` event keeps them in step
 * when the main window changes it. `t()` reads the module-level current language,
 * so pure `.ts` modules call it without threading a locale, and in Node (no
 * `window`) it is English.
 */

export const locales = ["en", "es"] as const;
export type Locale = (typeof locales)[number];

export type { MessageKey } from "./types.ts";

export const languageStorageKey = "planner-language";
export const lastLanguageStorageKey = "planner-language-last";

/** The names of the languages, each in its own language and never translated. */
export const languageNames: Record<Locale, string> = { en: "English", es: "Español" };

export function parseLocale(value: unknown): Locale | null {
  return value === "en" || value === "es" ? value : null;
}

/** The BCP 47 tag `Intl` formats with: `en` keeps the en-US output the app always had. */
export function intlLocale(locale: Locale): string {
  return locale === "en" ? "en-US" : "es";
}

export type LanguageSources = {
  /** This device's explicit choice, if any. */
  override: Locale | null;
  /** The account's choice: `undefined` = profile unknown, `null` = profile has none. */
  synced: Locale | null | undefined;
  /** The last effective language this browser used. */
  cached: Locale | null;
};

export function resolveLocale({ override, synced, cached }: LanguageSources): Locale {
  return override ?? (synced === undefined ? cached : synced) ?? "en";
}

/* ---------- messages ---------- */

/** Fills `{name}` placeholders; an absent param leaves its placeholder visible. */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** `one` when the language's plural rules say so, `other` otherwise (Spanish `many` falls to `other`). */
export function selectPlural(entry: Plural, count: number, locale: Locale): string {
  return new Intl.PluralRules(intlLocale(locale)).select(count) === "one" ? entry.one : entry.other;
}

/** Translates a key in the current language. Unknown keys and missing params are type errors. */
export function t<K extends MessageKey>(key: K, ...args: Args<K>): string {
  const params = args[0] as Record<string, string | number> | undefined;
  const entry: string | Plural = dictionaries[current][key];
  if (typeof entry === "string") return interpolate(entry, params);
  return interpolate(selectPlural(entry, Number(params?.count ?? 0), current), params);
}

/* ---------- the store ---------- */

const browser = typeof window !== "undefined";

function readStorage(key: string): Locale | null {
  if (!browser) return null;
  try {
    return parseLocale(window.localStorage.getItem(key));
  } catch {
    /* storage can be blocked (private mode): the session still switches, it just forgets */
    return null;
  }
}

function writeStorage(key: string, value: Locale | null): void {
  if (!browser) return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* see readStorage */
  }
}

let sources: LanguageSources = {
  override: readStorage(languageStorageKey),
  synced: undefined,
  cached: readStorage(lastLanguageStorageKey),
};
let current: Locale = resolveLocale(sources);

/** What the hooks see: replaced (never mutated) when something changes. */
export type LanguageState = { locale: Locale; override: Locale | null };
let snapshot: LanguageState = { locale: current, override: sources.override };
const listeners = new Set<() => void>();

function paint(locale: Locale): void {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

function update(next: LanguageSources): void {
  sources = next;
  const locale = resolveLocale(next);
  // Remember what the user last saw, but only from a real source: a cache read
  // back into the cache would pin a stale language forever.
  if (next.override !== null || next.synced !== undefined) writeStorage(lastLanguageStorageKey, locale);
  if (locale === snapshot.locale && next.override === snapshot.override) return;
  current = locale;
  snapshot = { locale, override: next.override };
  paint(locale);
  for (const listener of listeners) listener();
}

/** Sets (or clears, with `null`) this device's override. */
export function setDeviceLanguage(locale: Locale | null): void {
  writeStorage(languageStorageKey, locale);
  update({ ...sources, override: locale });
}

/** Feeds the profile's choice in: `undefined` profile unknown, `null` no choice stored. */
export function setSyncedLanguage(synced: Locale | null | undefined): void {
  update({ ...sources, synced });
}

export function getLocale(): Locale {
  return current;
}

if (browser) {
  paint(current);
  window.addEventListener("storage", event => {
    if (event.key !== null && event.key !== languageStorageKey && event.key !== lastLanguageStorageKey) return;
    update({
      ...sources,
      override: readStorage(languageStorageKey),
      cached: readStorage(lastLanguageStorageKey),
    });
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The effective language and whether this device pins it. Re-renders on a switch. */
export function useLanguage(): LanguageState {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/** The effective language; call it at a root that renders text so `t()` re-resolves. */
export function useLocale(): Locale {
  return useLanguage().locale;
}

/**
 * Mounted by the signed-in shell with the profile's choice (`undefined` while
 * the profile is loading or failed to load). Signing out forgets it, so the
 * auth form falls back to the cached language.
 */
export function useSyncedLanguage(synced: Locale | null | undefined): void {
  useEffect(() => {
    setSyncedLanguage(synced);
  }, [synced]);
  useEffect(() => () => setSyncedLanguage(undefined), []);
}
