import assert from "node:assert/strict";
import test from "node:test";
import { createPacer } from "./pacer.ts";

/** A virtual clock and frame queue: tests step time and pump frames by hand,
 * so the pacer's timing rules are asserted exactly, not wall-clock-flaky. */
function virtualPacer(options?: { baseRate?: number; pressure?: number }) {
  let now = 0;
  let emitted = "";
  const frames: Array<() => void> = [];
  const pacer = createPacer({
    emit: text => {
      emitted += text;
    },
    now: () => now,
    schedule: callback => {
      frames.push(callback);
      return () => {
        const index = frames.indexOf(callback);
        if (index >= 0) frames.splice(index, 1);
      };
    },
    ...options,
  });
  return {
    pacer,
    tick(ms: number) {
      now += ms;
    },
    /** Run every scheduled frame once (a browser would run one per frame). */
    pump() {
      const due = frames.splice(0);
      for (const callback of due) callback();
    },
    get emitted() {
      return emitted;
    },
    get frameCount() {
      return frames.length;
    },
  };
}

test("a push schedules exactly one frame; an empty push schedules none", () => {
  const virtual = virtualPacer();
  virtual.pacer.push("");
  assert.equal(virtual.frameCount, 0);
  virtual.pacer.push("hi");
  assert.equal(virtual.frameCount, 1);
  virtual.pacer.push("!");
  assert.equal(virtual.frameCount, 1, "a pending frame is reused, never stacked");
});

test("the drain releases characters at the adaptive rate, not in one dump", () => {
  const virtual = virtualPacer({ baseRate: 100, pressure: 0 });
  virtual.pacer.push("abcdefghij"); // 10 chars, 100 c/s
  virtual.tick(50);
  virtual.pump();
  assert.equal(virtual.emitted, "abcde", "50 ms at 100 c/s reveals 5 characters");
  virtual.tick(50);
  virtual.pump();
  assert.equal(virtual.emitted, "abcdefghij");
  assert.equal(virtual.frameCount, 0, "an empty buffer stops the frame loop");
  assert.equal(virtual.pacer.isPending(), false);
});

test("a growing buffer speeds the reveal up so it never lags more than ~1 s", () => {
  const virtual = virtualPacer({ baseRate: 90, pressure: 2 });
  virtual.pacer.push("x".repeat(1000));
  // 250 ms steps: rate ≈ 90 + 2·buffer, so each step clears about half the
  // backlog — the whole 1000-character dump is on screen inside ~1 s.
  for (let step = 0; step < 5 && virtual.pacer.isPending(); step++) {
    virtual.tick(250);
    virtual.pump();
  }
  assert.equal(virtual.emitted, "x".repeat(1000));
  assert.equal(virtual.pacer.isPending(), false);
  assert.ok(virtual.frameCount === 0);
});

test("deltas arriving mid-drain keep the steady flow", () => {
  const virtual = virtualPacer({ baseRate: 100, pressure: 0 });
  virtual.pacer.push("abc");
  virtual.tick(10);
  virtual.pump(); // 1 char
  virtual.pacer.push("def");
  virtual.tick(40);
  virtual.pump(); // 4 more chars
  assert.equal(virtual.emitted, "abcde");
  assert.ok(virtual.pacer.isPending());
});

test("flush delivers everything at once and stops the loop", () => {
  const virtual = virtualPacer({ baseRate: 100, pressure: 0 });
  virtual.pacer.push("stream");
  virtual.tick(10);
  virtual.pacer.flush();
  assert.equal(virtual.emitted, "stream");
  assert.equal(virtual.pacer.isPending(), false);
  virtual.tick(1000);
  virtual.pump();
  assert.equal(virtual.emitted, "stream", "a flushed pacer emits nothing more");
});

test("flush on an empty pacer is a no-op", () => {
  const virtual = virtualPacer();
  virtual.pacer.flush();
  assert.equal(virtual.emitted, "");
  assert.equal(virtual.pacer.isPending(), false);
});
