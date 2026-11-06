import assert from "node:assert/strict";
import { test } from "node:test";
import { holdMs, installCompositorHandoff, isCompositedProperty } from "./compositorHandoff.ts";

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

/** The smallest window `installCompositorHandoff` needs: elements with an
 * inline style and `animate`, keyframe effects and a computed-style read that
 * stands for WebKit's style resolution (it records the inline
 * transition-property in force when the style was resolved). */
function fakeWindow() {
  const resolved: string[] = [];
  class Style {
    values = new Map<string, { value: string; priority: string }>();
    getPropertyValue(name: string) { return this.values.get(name)?.value ?? ""; }
    getPropertyPriority(name: string) { return this.values.get(name)?.priority ?? ""; }
    setProperty(name: string, value: string, priority = "") { this.values.set(name, { value, priority }); }
    removeProperty(name: string) { this.values.delete(name); }
  }
  class KeyframeEffect {
    target: Element;
    keyframes: Array<Record<string, unknown>>;
    pseudoElement: string | null;
    constructor(target: Element, keyframes: Array<Record<string, unknown>>, pseudoElement: string | null) {
      this.target = target;
      this.keyframes = keyframes;
      this.pseudoElement = pseudoElement;
    }
    getKeyframes() { return this.keyframes; }
    getComputedTiming() { return { endTime: 200 }; }
  }
  class FakeAnimation {
    cancelled = 0;
    currentTime = 0;
    playbackRate = 1;
    effect: KeyframeEffect;
    constructor(effect: KeyframeEffect) {
      this.effect = effect;
    }
    cancel() { this.cancelled += 1; }
    addEventListener() {}
  }
  class Element {
    style = new Style();
    animate(keyframes: Record<string, unknown>, options: { pseudoElement?: string } = {}) {
      const frames = Object.entries(keyframes).map(([name, values]) => ({ [name]: (values as unknown[])[0] }));
      return new FakeAnimation(new KeyframeEffect(this as never, frames, options.pseudoElement ?? null));
    }
  }
  const view = {
    Element,
    KeyframeEffect,
    performance: { now: () => 0 },
    getComputedStyle: (element: Element) => {
      resolved.push(element.style.getPropertyValue("transition-property") || "(author)");
      return { clipPath: "none", opacity: "0" };
    },
  };
  const doc = { defaultView: view, addEventListener() {}, removeEventListener() {} };
  return { doc: doc as unknown as Document, Element, resolved };
}

test("a cancelled composited animation commits without starting a CSS transition", () => {
  const { doc, Element, resolved } = fakeWindow();
  const dispose = installCompositorHandoff(doc);
  const element = new Element();
  element.style.setProperty("transition-property", "color");
  const animation = (element as unknown as { animate: Element["animate"] }).animate({ opacity: [1, 0] }) as unknown as {
    cancel: () => void;
    cancelled: number;
  };
  resolved.length = 0;
  // Motion's end of an animation: the final value inline, then cancel.
  animation.cancel();
  assert.equal(animation.cancelled, 1, "the native cancel still runs");
  assert.deepEqual(resolved, ["none"], "the commit is resolved once, with transitions off");
  assert.equal(element.style.getPropertyValue("transition-property"), "color", "the inline value comes back");
  dispose();
});

test("animations the compositor never runs keep their own cancel", () => {
  const { doc, Element, resolved } = fakeWindow();
  const dispose = installCompositorHandoff(doc);
  const element = new Element();
  const animation = (element as unknown as { animate: Element["animate"] }).animate({ backgroundColor: ["red", "blue"] }) as unknown as {
    cancel: () => void;
  };
  resolved.length = 0;
  animation.cancel();
  assert.deepEqual(resolved, [], "no style is resolved for it");
  assert.equal(element.style.getPropertyValue("transition-property"), "");
  dispose();
});
