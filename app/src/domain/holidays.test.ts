import assert from "node:assert/strict";
import test from "node:test";
import { classifyHoliday, effectiveKind, isHolidayCalendar, parseHoliday } from "./holidays.ts";

test("Google holiday calendars are recognised by their id suffix and nothing else", () => {
  assert.equal(isHolidayCalendar("en.usa#holiday@group.v.calendar.google.com"), true);
  assert.equal(isHolidayCalendar("es.ar#holiday@group.v.calendar.google.com"), true);
  assert.equal(isHolidayCalendar("ES.AR#HOLIDAY@group.v.calendar.google.com"), true);
  assert.equal(isHolidayCalendar("primary"), false);
  assert.equal(isHolidayCalendar("me@gmail.com"), false);
  assert.equal(isHolidayCalendar("abc123@group.calendar.google.com"), false);
  assert.equal(isHolidayCalendar("fake#holiday@group.v.calendar.google.com.evil.example"), false);
});

test("English Google descriptions: public holiday and observance", () => {
  assert.equal(classifyHoliday({ summary: "Independence Day", description: "Public holiday" }), "public");
  assert.equal(
    classifyHoliday({
      summary: "Halloween",
      description: "Observance\nTo hide observances, go to Google Calendar Settings > Holidays in United States",
    }),
    "observance",
  );
  assert.equal(classifyHoliday({ summary: "Boxing Day", description: "Bank holiday" }), "public");
});

test("Spanish Google descriptions: feriado, observancia and día no laborable", () => {
  assert.equal(classifyHoliday({ summary: "Día de la Independencia", description: "Feriado" }), "public");
  assert.equal(classifyHoliday({ summary: "Día del Trabajador", description: "Día festivo" }), "public");
  assert.equal(classifyHoliday({ summary: "Día de la Madre", description: "Observancia" }), "observance");
  assert.equal(classifyHoliday({ summary: "Día no laborable con fines turísticos", description: "Feriado" }), "nonWorking");
  assert.equal(classifyHoliday({ summary: "Puente", description: "Día no laborable" }), "nonWorking");
  assert.equal(classifyHoliday({ summary: "Día del Árbol", description: "Observancia\nPara ocultar las observancias, ve a Configuración" }), "observance");
});

test("explicit non-working wording beats the holiday category, and the hint is never the category", () => {
  assert.equal(classifyHoliday({ summary: "Non-working day", description: "Public holiday" }), "nonWorking");
  // The hint below mentions observances but the category line is a public holiday.
  assert.equal(
    classifyHoliday({ summary: "Navidad", description: "Public holiday\nTo hide observances, go to Settings" }),
    "public",
  );
});

test("HTML in a description is read as text, and an unknown line is other", () => {
  assert.equal(classifyHoliday({ summary: "X", description: "<b>Public holiday</b><br>More" }), "public");
  assert.equal(classifyHoliday({ summary: "Mystery day", description: "Something else" }), "other");
  assert.equal(classifyHoliday({ summary: "Mystery day" }), "other");
  assert.equal(classifyHoliday({ summary: 5, description: null }), "other");
});

test("the user's override wins over the classifier", () => {
  assert.equal(effectiveKind({ kind: "public" }), "public");
  assert.equal(effectiveKind({ kind: "public", kindOverride: "nonWorking" }), "nonWorking");
});

test("a stored holiday is read defensively", () => {
  const source = { provider: "gcal", calendarId: "es.ar#holiday@group.v.calendar.google.com", eventId: "e1" };
  const holiday = parseHoliday("gcal_x_e1", { date: "2026-12-25", title: " Navidad ", kind: "public", kindOverride: "nonWorking", hidden: true, source });
  assert.deepEqual(holiday, { id: "gcal_x_e1", date: "2026-12-25", title: "Navidad", kind: "public", kindOverride: "nonWorking", hidden: true, source });
  assert.equal(parseHoliday("a", { date: "2026-12-25", title: "", kind: "public", source }), null);
  assert.equal(parseHoliday("a", { date: "nope", title: "T", kind: "public", source }), null);
  assert.equal(parseHoliday("a", { date: "2026-12-25", title: "T", kind: "public" }), null);
  assert.equal(parseHoliday("a", { date: "2026-12-25", title: "T", kind: "weird", kindOverride: "nope", source })?.kind, "other");
  assert.equal(parseHoliday("a", { date: "2026-12-25", title: "T", kind: "weird", kindOverride: "nope", source })?.kindOverride, undefined);
});
