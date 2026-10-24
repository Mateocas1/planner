import assert from "node:assert/strict";
import test from "node:test";
import { shouldRevealAtSignIn } from "./desktop-autostart.ts";

const today = "2026-10-22";
const brief = "Today: 3 blocks, first at 09:00. First free slot 10:30.";

test("a sign-in launch shows the window when today's brief applies", () => {
  assert.equal(shouldRevealAtSignIn({ storedDay: null, today, blockCount: 3, briefText: brief }), true);
});

test("yesterday's dismissal does not hide today's brief", () => {
  assert.equal(shouldRevealAtSignIn({ storedDay: "2026-10-21", today, blockCount: 3, briefText: brief }), true);
});

test("a day without blocks stays in the tray", () => {
  assert.equal(shouldRevealAtSignIn({ storedDay: null, today, blockCount: 0, briefText: null }), false);
});

test("a brief dismissed today stays in the tray", () => {
  assert.equal(shouldRevealAtSignIn({ storedDay: today, today, blockCount: 3, briefText: brief }), false);
});

test("no brief sentence means nothing to show", () => {
  assert.equal(shouldRevealAtSignIn({ storedDay: null, today, blockCount: 3, briefText: null }), false);
});
