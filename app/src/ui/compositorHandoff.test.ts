import assert from "node:assert/strict";
import { test } from "node:test";
import { holdMs, isCompositedProperty } from "./compositorHandoff.ts";

test("isCompositedProperty knows the properties WebKit hands to its compositor", () => {
  for (const name of ["opacity", "transform", "translate", "scale", "rotate", "filter", "backdrop-filter", "backdropFilter"]) {
    assert.equal(isCompositedProperty(name), true, name);
  }
  for (const name of ["color", "background-color", "clip-path", "clipPath", "width", "--custom", "offset", "easing"]) {
    assert.equal(isCompositedProperty(name), false, name);
  }
});

test("holdMs covers what is left of a composited animation plus a margin", () => {
  assert.equal(holdMs([{ opacity: 0 }, { opacity: 1 }], { endTime: 200 }, 0, 1), 250);
  // Mid-flight: only the remaining part needs cover.
  assert.equal(holdMs([{ transform: "scale(0.9)" }, { transform: "none" }], { endTime: 400 }, 150, 1), 300);
  // A slower playback rate stretches the remaining wall-clock time.
  assert.equal(holdMs([{ opacity: 0 }, { opacity: 1 }], { endTime: 200 }, 0, 0.5), 450);
});

test("holdMs leaves alone what never reaches the compositor or never ends", () => {
  // Nothing composited: the animation already runs on the main thread.
  assert.equal(holdMs([{ backgroundColor: "red" }, { backgroundColor: "blue" }], { endTime: 200 }, 0, 1), null);
  // clip-path keeps the whole effect off the compositor, and the guard's own
  // clip-path would override the animated one.
  assert.equal(holdMs([{ opacity: 0, clipPath: "inset(0)" }, { opacity: 1, clipPath: "inset(10%)" }], { endTime: 200 }, 0, 1), null);
  // An endless animation has no end frame to drop.
  assert.equal(holdMs([{ opacity: 0 }, { opacity: 1 }], { endTime: Infinity }, 0, 1), null);
  // Already over, or paused at zero speed.
  assert.equal(holdMs([{ opacity: 0 }, { opacity: 1 }], { endTime: 200 }, 200, 1), null);
  assert.equal(holdMs([{ opacity: 0 }, { opacity: 1 }], { endTime: 200 }, 0, 0), null);
});
