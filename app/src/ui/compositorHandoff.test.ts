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
  // Played backwards, what is left runs from the current time down to zero.
  assert.equal(holdMs([{ opacity: 0 }, { opacity: 1 }], { endTime: 200 }, 150, -1), 200);
  assert.equal(holdMs([{ opacity: 0 }, { opacity: 1 }], { endTime: 200 }, 100, -2), 100);
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
 * inline style and `animate`, keyframe effects, an Animation class whose
 * playback methods follow the spec closely enough (`updatePlaybackRate` only
 * pends its rate), a clock, and a computed-style read that stands for WebKit's
 * style resolution (it records the inline transition-property in force when
 * the style was resolved). Every guard the handoff adds is recorded. */
function fakeWindow() {
  const resolved: string[] = [];
  const clock = { now: 0 };
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
    endTime: number;
    constructor(target: Element, keyframes: Array<Record<string, unknown>>, pseudoElement: string | null, endTime = 200) {
      this.target = target;
      this.keyframes = keyframes;
      this.pseudoElement = pseudoElement;
      this.endTime = endTime;
    }
    getKeyframes() { return this.keyframes; }
    getComputedTiming() { return { endTime: this.endTime }; }
  }
  class Animation {
    cancelled = 0;
    currentTime = 0;
    playbackRate = 1;
    pendingRate: number | null = null;
    effect: KeyframeEffect;
    constructor(effect: KeyframeEffect) {
      this.effect = effect;
    }
    cancel() { this.cancelled += 1; }
    play() {
      // Auto-rewind: a finished animation starts over from its start.
      if (this.playbackRate > 0 && this.currentTime >= this.effect.endTime) this.currentTime = 0;
      if (this.playbackRate < 0 && this.currentTime <= 0) this.currentTime = this.effect.endTime;
    }
    reverse() {
      this.playbackRate = -this.playbackRate;
      this.play();
    }
    updatePlaybackRate(rate: number) { this.pendingRate = rate; }
    addEventListener() {}
  }
  class CSSAnimation extends Animation {}
  const guards: Array<{ element: Element; duration: number; animation: Animation }> = [];
  class Element {
    style = new Style();
    animate(keyframes: Record<string, unknown>, options: { pseudoElement?: string; duration?: number } = {}) {
      const frames = Object.entries(keyframes).map(([name, values]) => ({ [name]: (values as unknown[])[0] }));
      const animation = new Animation(new KeyframeEffect(this as never, frames, options.pseudoElement ?? null));
      if ("clipPath" in keyframes) guards.push({ element: this, duration: options.duration ?? 0, animation });
      return animation;
    }
  }
  const root = new Element() as Element & { attributes: Map<string, string> };
  root.attributes = new Map();
  Object.assign(root, {
    setAttribute(name: string, value: string) { root.attributes.set(name, value); },
    removeAttribute(name: string) { root.attributes.delete(name); },
  });
  const view = {
    Element,
    KeyframeEffect,
    Animation,
    CSSAnimation,
    performance: { now: () => clock.now },
    getComputedStyle: (element: Element) => {
      resolved.push(element.style.getPropertyValue("transition-property") || "(author)");
      return { clipPath: "none", opacity: "0" };
    },
  };
  const doc = { defaultView: view, documentElement: root, addEventListener() {}, removeEventListener() {} };
  return { doc: doc as unknown as Document, view, Element, Animation, CSSAnimation, KeyframeEffect, guards, resolved, clock, root };
}

type FakeAnimation = {
  cancel: () => void;
  play: () => void;
  reverse: () => void;
  updatePlaybackRate: (rate: number) => void;
  cancelled: number;
  currentTime: number;
};

function animate(element: unknown, keyframes: Record<string, unknown>, options: Record<string, unknown> = {}) {
  return (element as { animate: (k: unknown, o: unknown) => unknown }).animate(keyframes, options) as FakeAnimation;
}

test("a cancelled composited animation commits without starting a CSS transition", () => {
  const { doc, Element, resolved } = fakeWindow();
  const dispose = installCompositorHandoff(doc);
  const element = new Element();
  element.style.setProperty("transition-property", "color");
  const animation = animate(element, { opacity: [1, 0] });
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
  const animation = animate(element, { backgroundColor: ["red", "blue"] });
  resolved.length = 0;
  animation.cancel();
  assert.deepEqual(resolved, [], "no style is resolved for it");
  assert.equal(element.style.getPropertyValue("transition-property"), "");
  dispose();
});

test("a composited animation gets a guard for its run", () => {
  const { doc, Element, guards } = fakeWindow();
  const dispose = installCompositorHandoff(doc);
  const element = new Element();
  animate(element, { opacity: [0, 1] });
  assert.deepEqual(guards.map((g) => g.duration), [250]);
  dispose();
});

test("reverse() covers the way back", () => {
  const { doc, Element, guards, clock } = fakeWindow();
  const dispose = installCompositorHandoff(doc);
  const element = new Element();
  const animation = animate(element, { opacity: [0, 1] });
  // Late in the run, after the first guard has lapsed, it turns around.
  clock.now = 300;
  animation.currentTime = 150;
  animation.reverse();
  assert.deepEqual(guards.map((g) => g.duration), [250, 200], "150 ms back to the start, plus the margin");
  dispose();
});

test("play() after the end covers the replay", () => {
  const { doc, Element, guards, clock } = fakeWindow();
  const dispose = installCompositorHandoff(doc);
  const element = new Element();
  const animation = animate(element, { transform: ["scale(0.95)", "none"] });
  clock.now = 400;
  animation.currentTime = 200;
  animation.play();
  assert.deepEqual(guards.map((g) => g.duration), [250, 250]);
  dispose();
});

test("updatePlaybackRate() covers the run at its new speed", () => {
  const { doc, Element, guards, clock } = fakeWindow();
  const dispose = installCompositorHandoff(doc);
  const element = new Element();
  const animation = animate(element, { opacity: [0, 1] });
  clock.now = 100;
  animation.currentTime = 100;
  // The rate only pends until the animation is ready; the cover must use it.
  animation.updatePlaybackRate(0.5);
  assert.deepEqual(guards.map((g) => g.duration), [250, 250], "100 ms left at half speed, plus the margin");
  dispose();
});

test("a guard still long enough is kept rather than replaced", () => {
  const { doc, Element, guards } = fakeWindow();
  const dispose = installCompositorHandoff(doc);
  const element = new Element();
  const animation = animate(element, { opacity: [0, 1] });
  animation.play();
  assert.equal(guards.length, 1);
  dispose();
});

test("a CSS animation cancelled from script commits without starting a CSS transition", () => {
  const { doc, Element, CSSAnimation, KeyframeEffect, resolved } = fakeWindow();
  const dispose = installCompositorHandoff(doc);
  const element = new Element();
  const animation = new CSSAnimation(new KeyframeEffect(element as never, [{ opacity: 0 }, { opacity: 1 }], null));
  resolved.length = 0;
  animation.cancel();
  assert.equal(animation.cancelled, 1);
  assert.deepEqual(resolved, ["none"]);
  dispose();
});

test("view-transition pseudo-elements get no guard", () => {
  const { doc, Element, guards } = fakeWindow();
  const dispose = installCompositorHandoff(doc);
  const root = new Element();
  animate(root, { opacity: [0, 1] }, { pseudoElement: "::view-transition-new(task-morph)" });
  animate(root, { transform: ["none", "none"] }, { pseudoElement: "::view-transition-group(task-morph)" });
  assert.equal(guards.length, 0);
  dispose();
});

test("the root is marked while the handoff is installed", () => {
  const { doc, root } = fakeWindow();
  const dispose = installCompositorHandoff(doc);
  assert.equal(root.attributes.get("data-compositor-handoff"), "");
  dispose();
  assert.equal(root.attributes.has("data-compositor-handoff"), false);
});

test("the disposer cancels live guards and restores every patched method", () => {
  const { doc, view, Element, Animation, guards, resolved } = fakeWindow();
  const native = {
    animate: view.Element.prototype.animate,
    cancel: Animation.prototype.cancel,
    play: Animation.prototype.play,
    reverse: Animation.prototype.reverse,
    updatePlaybackRate: Animation.prototype.updatePlaybackRate,
  };
  const dispose = installCompositorHandoff(doc);
  const element = new Element();
  const animation = animate(element, { opacity: [0, 1] });
  assert.equal(guards.length, 1);
  dispose();
  assert.equal(guards[0].animation.cancelled, 1, "the live guard is cancelled");
  assert.equal(view.Element.prototype.animate, native.animate);
  assert.equal(Animation.prototype.cancel, native.cancel);
  assert.equal(Animation.prototype.play, native.play);
  assert.equal(Animation.prototype.reverse, native.reverse);
  assert.equal(Animation.prototype.updatePlaybackRate, native.updatePlaybackRate);
  resolved.length = 0;
  animation.cancel();
  assert.deepEqual(resolved, [], "an animation made while installed cancels natively afterwards");
  assert.equal(Object.hasOwn(animation, "cancel"), false, "no patch is left on the instance");
});
