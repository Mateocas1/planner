import assert from "node:assert/strict";
import test from "node:test";
import { defaultWorkWindow, freeSlots, mergeIntervals, parseWorkWindow, validateWorkWindow } from "./window.ts";

/**
 * The original `freeSlots` body, copied verbatim from `ui/Calendar.tsx` (base
 * commit b940c39) with its module constants. The parity tests below assert the
 * extracted module produces exactly the same output, so the Plan feature is
 * provably unchanged.
 */
function legacyFreeSlots(items: { startMinutes: number; endMinutes: number }[], fromMinutes: number | null): [number, number][] {
  const planFrom = 8 * 60;
  const planUntil = 21 * 60;
  let cursor = Math.max(planFrom, fromMinutes === null ? 0 : Math.ceil((fromMinutes + 5) / 15) * 15);
  const slots: [number, number][] = [];
  for (const item of [...items].sort((left, right) => left.startMinutes - right.startMinutes)) {
    if (item.endMinutes <= cursor) continue;
    if (item.startMinutes > cursor) slots.push([cursor, Math.min(item.startMinutes, planUntil)]);
    cursor = Math.max(cursor, item.endMinutes);
    if (cursor >= planUntil) break;
  }
  if (cursor < planUntil) slots.push([cursor, planUntil]);
  return slots.filter(([start, end]) => end > start);
}

/** Every fixture below must produce byte-identical output from both versions. */
function assertParity(items: { startMinutes: number; endMinutes: number }[], fromMinutes: number | null, expected: [number, number][]) {
  const legacy = legacyFreeSlots(items, fromMinutes);
  const extracted = freeSlots(items, defaultWorkWindow, fromMinutes);
  assert.deepEqual(extracted, legacy, "extracted freeSlots must match the original Calendar output");
  assert.deepEqual(extracted, expected, "the fixture's expected slots must hold");
}

test("freeSlots parity: an empty day starts at the quarter hour after now", () => {
  // 12:00 is 12:15 rounded to the next quarter; the window ends at 21:00.
  assertParity([], 720, [[735, 1260]]);
});

test("freeSlots parity: overlapping blocks contribute their union only", () => {
  // 09:00-12:00 and 11:00-14:00 overlap; the free ranges are 08:00-09:00 and 14:00-21:00.
  assertParity(
    [
      { startMinutes: 540, endMinutes: 720 },
      { startMinutes: 660, endMinutes: 840 },
    ],
    null,
    [
      [480, 540],
      [840, 1260],
    ],
  );
});

test("freeSlots parity: a DST day keeps the 08:00-21:00 window in wall minutes", () => {
  // The module works on wall minutes, so a DST day is the same fixture: the
  // window is 13 h of wall clock and the blocks sit at the same wall times.
  assertParity(
    [
      { startMinutes: 570, endMinutes: 690 },
      { startMinutes: 780, endMinutes: 900 },
    ],
    null,
    [
      [480, 570],
      [690, 780],
      [900, 1260],
    ],
  );
});

test("freeSlots parity: a block crossing midnight is clipped at the day's end", () => {
  // layoutBlocks clips a cross-midnight block at 24:00, so this day sees a
  // single 09:00-24:00 run: only 08:00-09:00 is free.
  assertParity([{ startMinutes: 540, endMinutes: 1440 }], null, [[480, 540]]);
});

test("freeSlots parity: blocks before now are skipped and only the tail is free", () => {
  // Three blocks end before 16:40, so the single free range starts at 16:45.
  assertParity(
    [
      { startMinutes: 840, endMinutes: 900 },
      { startMinutes: 540, endMinutes: 600 },
      { startMinutes: 660, endMinutes: 720 },
    ],
    1000,
    [[1005, 1260]],
  );
});

test("mergeIntervals unions overlapping and adjacent ranges in order", () => {
  // Overlaps collapse to one range.
  assert.deepEqual(
    mergeIntervals([
      { startMinutes: 540, endMinutes: 720 },
      { startMinutes: 660, endMinutes: 840 },
    ]),
    [{ startMinutes: 540, endMinutes: 840 }],
  );
  // Touching ranges merge, because the gap between them is empty.
  assert.deepEqual(
    mergeIntervals([
      { startMinutes: 720, endMinutes: 900 },
      { startMinutes: 540, endMinutes: 720 },
    ]),
    [{ startMinutes: 540, endMinutes: 900 }],
  );
  // Disjoint ranges stay apart, sorted by start.
  assert.deepEqual(
    mergeIntervals([
      { startMinutes: 200, endMinutes: 300 },
      { startMinutes: 0, endMinutes: 100 },
    ]),
    [
      { startMinutes: 0, endMinutes: 100 },
      { startMinutes: 200, endMinutes: 300 },
    ],
  );
  // One nested range and the empty input.
  assert.deepEqual(
    mergeIntervals([
      { startMinutes: 0, endMinutes: 1440 },
      { startMinutes: 480, endMinutes: 600 },
    ]),
    [{ startMinutes: 0, endMinutes: 1440 }],
  );
  assert.deepEqual(mergeIntervals([]), []);
});

test("validateWorkWindow rejects end <= start", () => {
  assert.throws(() => validateWorkWindow({ startMinutes: 600, endMinutes: 300 }), { message: "work window end must be after start" });
  // Equal start and end is also invalid.
  assert.throws(() => validateWorkWindow({ startMinutes: 480, endMinutes: 480 }), { message: "work window end must be after start" });
  // Valid windows must not throw.
  assert.doesNotThrow(() => validateWorkWindow({ startMinutes: 480, endMinutes: 1260 }));
  assert.doesNotThrow(() => validateWorkWindow(defaultWorkWindow));
});

test("parseWorkWindow defaults to 08:00-21:00 when the stored window is absent", () => {
  assert.deepEqual(defaultWorkWindow, { startMinutes: 480, endMinutes: 1260 });
  assert.deepEqual(parseWorkWindow(undefined), defaultWorkWindow);
  assert.deepEqual(parseWorkWindow({}), defaultWorkWindow);
  // A profile written before W1 has only a timezone.
  assert.deepEqual(parseWorkWindow({ timeZone: "Europe/Madrid" }), defaultWorkWindow);
});

test("parseWorkWindow falls back to the default when the stored window is invalid", () => {
  // Inverted, equal, non-numeric, negative and past midnight all fall back.
  assert.deepEqual(parseWorkWindow({ workStart: 600, workEnd: 300 }), defaultWorkWindow);
  assert.deepEqual(parseWorkWindow({ workStart: 480, workEnd: 480 }), defaultWorkWindow);
  assert.deepEqual(parseWorkWindow({ workStart: "08:00", workEnd: 1260 }), defaultWorkWindow);
  assert.deepEqual(parseWorkWindow({ workStart: -60, workEnd: 1260 }), defaultWorkWindow);
  assert.deepEqual(parseWorkWindow({ workStart: 0, workEnd: 1441 }), defaultWorkWindow);
});

test("parseWorkWindow reads a valid stored window", () => {
  assert.deepEqual(parseWorkWindow({ workStart: 9 * 60, workEnd: 17 * 60 }), { startMinutes: 9 * 60, endMinutes: 17 * 60 });
  assert.deepEqual(parseWorkWindow({ workStart: 0, workEnd: 1440 }), { startMinutes: 0, endMinutes: 1440 });
  // The default round-trips.
  assert.deepEqual(parseWorkWindow({ workStart: 480, workEnd: 1260 }), defaultWorkWindow);
  // A numeric encoding (real Firestore) reads the same as its string form.
  assert.deepEqual(parseWorkWindow({ workStart: "540", workEnd: "1020" }), { startMinutes: 540, endMinutes: 1020 });
});
