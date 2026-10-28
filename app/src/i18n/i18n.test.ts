import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { dictionaries } from "./dictionaries.ts";
import {
  getLocale,
  intlLocale,
  interpolate,
  parseLocale,
  resolveLocale,
  selectPlural,
  setDeviceLanguage,
  setSyncedLanguage,
  t,
} from "./index.ts";
import { formatDateKey } from "../ui/format.ts";
import { formatWall } from "../ui/time.ts";

const placeholders = (template: string) => [...template.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

type Entry = string | { one: string; other: string };
const entryOf = (locale: "en" | "es", key: string): Entry => (dictionaries[locale] as Record<string, Entry>)[key];

describe("dictionaries", () => {
  const enKeys = Object.keys(dictionaries.en).sort();

  it("carry the same keys in both languages", () => {
    assert.deepEqual(Object.keys(dictionaries.es).sort(), enKeys);
  });

  it("carry the same placeholders for every key, plural forms included", () => {
    for (const key of enKeys) {
      const en = entryOf("en", key);
      const es = entryOf("es", key);
      assert.equal(typeof en, typeof es, `${key}: plural in one language only`);
      if (typeof en === "string" || typeof es === "string") {
        assert.deepEqual(placeholders(String(es)), placeholders(String(en)), key);
        continue;
      }
      assert.ok(typeof en !== "string" && typeof es !== "string");
      for (const form of ["one", "other"] as const) {
        assert.deepEqual(placeholders(es[form]), placeholders(en[form]), `${key}.${form}`);
      }
      assert.ok(placeholders(en.one).includes("count") && placeholders(es.one).includes("count"), `${key}: count missing`);
    }
  });

  it("have no empty message", () => {
    for (const locale of ["en", "es"] as const) {
      for (const [key, value] of Object.entries(dictionaries[locale] as Record<string, Entry>)) {
        const forms = typeof value === "string" ? [value] : [value.one, value.other];
        for (const form of forms) assert.notEqual(form.trim(), "", `${locale}.${key}`);
      }
    }
  });
});

describe("interpolate and selectPlural", () => {
  it("fills named placeholders and leaves other text alone", () => {
    assert.equal(interpolate("Hello {name}, {n} left", { name: "Ana", n: 3 }), "Hello Ana, 3 left");
    assert.equal(interpolate("No params"), "No params");
  });

  it("picks one/other per language", () => {
    const entry = { one: "{count} block", other: "{count} blocks" };
    for (const [locale, count, expected] of [
      ["en", 0, "other"],
      ["en", 1, "one"],
      ["en", 2, "other"],
      ["es", 0, "other"],
      ["es", 1, "one"],
      ["es", 2, "other"],
      ["es", 1_000_000, "other"],
    ] as const) {
      assert.equal(selectPlural(entry, count, locale), entry[expected], `${locale} ${count}`);
    }
  });
});

describe("parseLocale", () => {
  it("accepts only the two languages", () => {
    assert.equal(parseLocale("en"), "en");
    assert.equal(parseLocale("es"), "es");
    for (const bad of ["fr", "EN", "", null, undefined, 3, {}]) assert.equal(parseLocale(bad), null);
  });
});

describe("resolveLocale: device override ?? synced account choice ?? cached last ?? en", () => {
  it("prefers the device override over everything", () => {
    assert.equal(resolveLocale({ override: "en", synced: "es", cached: "es" }), "en");
    assert.equal(resolveLocale({ override: "es", synced: "en", cached: "en" }), "es");
  });

  it("uses the synced choice when there is no override", () => {
    assert.equal(resolveLocale({ override: null, synced: "es", cached: "en" }), "es");
  });

  it("uses the cached last language while the profile is unknown", () => {
    assert.equal(resolveLocale({ override: null, synced: undefined, cached: "es" }), "es");
  });

  it("falls back to English when a loaded profile has no choice, whatever the cache says", () => {
    assert.equal(resolveLocale({ override: null, synced: null, cached: "es" }), "en");
  });

  it("defaults to English with nothing at all (no browser detection)", () => {
    assert.equal(resolveLocale({ override: null, synced: undefined, cached: null }), "en");
  });
});

describe("the language store", () => {
  afterEach(() => {
    setDeviceLanguage(null);
    setSyncedLanguage(undefined);
  });

  it("starts in English and translates through the current language", () => {
    assert.equal(getLocale(), "en");
    assert.equal(t("settings.language.title"), "Language");
  });

  it("applies device override ?? synced in order and reports each switch", () => {
    setSyncedLanguage("es");
    assert.equal(getLocale(), "es");
    assert.equal(t("settings.language.title"), "Idioma");
    setDeviceLanguage("en");
    assert.equal(getLocale(), "en");
    setDeviceLanguage(null);
    assert.equal(getLocale(), "es");
    setSyncedLanguage(null);
    assert.equal(getLocale(), "en");
  });
});

describe("locale-aware formatting", () => {
  afterEach(() => setDeviceLanguage(null));
  const day = Date.UTC(2026, 8, 29);

  it("keeps the English output as it was (en-US)", () => {
    assert.equal(intlLocale("en"), "en-US");
    assert.equal(formatWall(day, { weekday: "long", month: "long", day: "numeric" }), "Tuesday, September 29");
    assert.equal(formatDateKey("2026-09-29", "2026-09-01"), "Tue, Sep 29");
    assert.equal(formatDateKey("2026-09-01", "2026-09-01"), "today");
    assert.equal(formatDateKey("2026-09-02", "2026-09-01"), "tomorrow");
  });

  it("follows the app language in Spanish", () => {
    setDeviceLanguage("es");
    assert.equal(formatWall(day, { weekday: "long", month: "long", day: "numeric" }), "martes, 29 de septiembre");
    assert.equal(formatDateKey("2026-09-01", "2026-09-01"), "hoy");
    assert.equal(formatDateKey("2026-09-02", "2026-09-01"), "mañana");
    assert.match(formatDateKey("2026-09-29", "2026-09-01"), /^mar,? 29 sept?\.?$/);
  });
});
