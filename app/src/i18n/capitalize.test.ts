import assert from "node:assert/strict";
import test from "node:test";
import { capitalize } from "./capitalize.ts";

test("capitalize upper-cases the first letter and leaves the rest alone", () => {
  assert.equal(capitalize("martes, 29 de septiembre", "es"), "Martes, 29 de septiembre");
  assert.equal(capitalize("mañana", "es"), "Mañana");
  assert.equal(capitalize("tomorrow", "en"), "Tomorrow");
  assert.equal(capitalize("Mon, Sep 29", "en"), "Mon, Sep 29");
});

test("capitalize handles accents, digits and an empty string", () => {
  assert.equal(capitalize("él", "es"), "Él");
  assert.equal(capitalize("29 sept", "es"), "29 sept");
  assert.equal(capitalize("", "es"), "");
});

test("capitalize upper-cases a whole first grapheme", () => {
  // "e" + combining acute is one grapheme: the base letter changes, the mark stays.
  assert.equal(capitalize("e\u0301cole", "es"), "E\u0301cole");
  assert.equal(capitalize("ǆ", "en"), "Ǆ");
});

test("capitalize follows the locale's own case rules", () => {
  assert.equal(capitalize("istanbul", "tr"), "İstanbul");
  assert.equal(capitalize("istanbul", "en"), "Istanbul");
});
