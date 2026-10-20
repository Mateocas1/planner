import assert from "node:assert/strict";
import test from "node:test";
import { dateKey, timeLabel, toZonedInstant, wallMinutes } from "./time.ts";

/** The instant a stored zoned string denotes, in epoch ms. */
const ms = (instant: string) => Date.parse(instant);

test("a datetime-local value becomes the instant whose wall clock it names", () => {
  // UTC has no offset, so the two readings coincide.
  assert.equal(toZonedInstant("2026-03-02T09:30", "UTC"), "2026-03-02T09:30:00+00:00");

  // America/Sao_Paulo is UTC-3 all year: 09:30 local is 12:30Z.
  const saoPaulo = toZonedInstant("2026-03-02T09:30", "America/Sao_Paulo");
  assert.equal(saoPaulo, "2026-03-02T09:30:00-03:00");
  assert.equal(ms(saoPaulo), Date.parse("2026-03-02T12:30:00Z"));
  assert.equal(timeLabel(new Date(saoPaulo), "America/Sao_Paulo"), "09:30");
  assert.equal(dateKey(new Date(saoPaulo), "America/Sao_Paulo"), "2026-03-02");

  // Europe/Madrid is UTC+1 in winter and UTC+2 in summer.
  assert.equal(toZonedInstant("2026-01-15T09:30", "Europe/Madrid"), "2026-01-15T09:30:00+01:00");
  assert.equal(toZonedInstant("2026-07-15T09:30", "Europe/Madrid"), "2026-07-15T09:30:00+02:00");
  assert.equal(ms(toZonedInstant("2026-07-15T09:30", "Europe/Madrid")), Date.parse("2026-07-15T07:30:00Z"));
});

test("a wall time after a DST switch keeps the offset in force at that moment", () => {
  // Madrid springs forward at 02:00 local on 2026-03-29; 09:30 that day is CEST.
  const afterSwitch = toZonedInstant("2026-03-29T09:30", "Europe/Madrid");
  assert.equal(afterSwitch, "2026-03-29T09:30:00+02:00");
  assert.equal(timeLabel(new Date(afterSwitch), "Europe/Madrid"), "09:30");
  // The day before still uses CET.
  assert.equal(timeLabel(new Date(toZonedInstant("2026-03-28T09:30", "Europe/Madrid")), "Europe/Madrid"), "09:30");
});

test("an instant's wall minutes are the input's minutes", () => {
  const instant = toZonedInstant("2026-03-02T23:45", "Asia/Tokyo");
  assert.equal(wallMinutes(new Date(instant), "Asia/Tokyo"), 23 * 60 + 45);
  assert.equal(dateKey(new Date(instant), "Asia/Tokyo"), "2026-03-02");
});
