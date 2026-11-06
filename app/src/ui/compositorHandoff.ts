/**
 * WebKitGTK end-of-animation guard (odd/tasks/ronda6-linux.md S5).
 *
 * On the Linux desktop shell (WebKitGTK 2.54, DMABUF renderer) an animation
 * that WebKit runs on its compositor -- opacity, transform, filter, from WAAPI,
 * Motion, a CSS transition or a CSS animation alike -- presents one stale
 * frame when it ends: the layer shows an earlier state of the animation
 * before the final one lands. The New task sheet's scrim blinks off as its
 * fade lands, the sheet vanishes for a frame as its flight lands, and a
 * closed sheet flashes back once before it unmounts (frame captures in
 * odd/runs/r6-motion.md). WebView2 and the browsers do not do this.
 *
 * WebKit only hands an element's animations to the compositor when every
 * effect on it can run there. So while a composited animation runs, this guard
 * adds one more effect to the same element that cannot: a `clip-path` held at
 * the element's own computed value, a visual no-op. The animation then runs on
 * the main thread (still a composited layer property, no layout or paint) and
 * its last frame is the one the page commits. The guard outlives the animation
 * by a short margin so the hand-back never happens mid-flight.
 *
 * The same engine also starts CSS transitions from the wrong value when a
 * script animation ends. Motion ends one by writing its final value inline and
 * cancelling it; WebKit takes the transition's start from the value under the
 * animation, not the one it showed. Wherever a transition applies -- every
 * element under reduced motion, where app.css gives `all` a 1 ms transition --
 * the element paints its pre-animation value for one frame: the reduced-motion
 * New task close showed the whole panel and scrim again just before they
 * unmounted. So a cancel resolves that commit with transitions turned off.
 *
 * A View Transition's pseudo-elements get no guard: the morph showed no stale
 * frame without one (0/12, odd/runs/r6-motion2.md), and the guard only moved
 * its snapshots onto the main thread. While installed, the root carries
 * `data-compositor-handoff` so app.css can drop the snapshot blur, the
 * costliest part of the morph on this engine (odd/research/audit-r7.md R7-08).
 *
 * Installed only when the shell marks the page as WebKitGTK
 * (`window.__WEBKITGTK__`, src-tauri/src/window.rs); no other engine runs it.
 * Durations, curves and the reduced-motion paths are untouched.
 */

/** Properties WebKit animates on its compositor, in CSS and camelCase form. */
const COMPOSITED = new Set([
  "opacity",
  "transform",
  "translate",
  "scale",
  "rotate",
  "filter",
  "backdrop-filter",
  "backdropFilter",
  "-webkit-backdrop-filter",
  "webkitBackdropFilter",
]);

/** How long the guard outlives the animation it covers. */
const MARGIN_MS = 50;

export function isCompositedProperty(name: string): boolean {
  return COMPOSITED.has(name);
}

/** Whether any keyframe animates a property WebKit composites. */
export function touchesComposited(keyframes: ReadonlyArray<Record<string, unknown>>): boolean {
  return keyframes.some((frame) => Object.keys(frame).some(isCompositedProperty));
}

/**
 * How long an animation needs cover, in wall-clock milliseconds, or null when
 * it needs none: nothing composited, a clip-path of its own (already off the
 * compositor, and the guard's clip-path would override it), no end, or no time
 * left.
 */
export function holdMs(
  keyframes: ReadonlyArray<Record<string, unknown>>,
  timing: { endTime?: CSSNumberish | null },
  currentTime: number,
  playbackRate: number,
): number | null {
  let composited = false;
  for (const frame of keyframes) {
    for (const name of Object.keys(frame)) {
      if (name === "clipPath") return null;
      if (isCompositedProperty(name)) composited = true;
    }
  }
  const end = typeof timing.endTime === "number" ? timing.endTime : Infinity;
  if (!composited || !Number.isFinite(end) || playbackRate === 0) return null;
  // Played backwards, what is left runs from the current time down to zero.
  const left = (playbackRate > 0 ? end - currentTime : currentTime) / Math.abs(playbackRate);
  return left > 0 ? left + MARGIN_MS : null;
}

type Guard = { animation: Animation; until: number };

/** Pseudo-elements of a View Transition (see the header). */
const isViewTransition = (pseudo: string | null) => pseudo?.startsWith("::view-transition") === true;

/** Patches `Element.prototype.animate` and the playback methods of
 * `Animation.prototype`, and listens for CSS transitions and animations.
 * Returns a disposer that puts everything back and drops the live guards. */
export function installCompositorHandoff(doc: Document = document): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};
  const proto = view.Element.prototype;
  const nativeAnimate = proto.animate;
  const animationProto = view.Animation.prototype;
  const native = {
    cancel: animationProto.cancel,
    play: animationProto.play,
    reverse: animationProto.reverse,
    updatePlaybackRate: animationProto.updatePlaybackRate,
  };
  /** One guard per element and pseudo-element, extended rather than stacked. */
  const guards = new WeakMap<Element, Map<string, Guard>>();
  /** Every guard still running, for the disposer. */
  const live = new Set<Animation>();

  const guard = (element: Element, pseudo: string | null, ms: number) => {
    const key = pseudo ?? "";
    let byPseudo = guards.get(element);
    if (!byPseudo) guards.set(element, (byPseudo = new Map()));
    const now = view.performance.now();
    const current = byPseudo.get(key);
    if (current && current.until >= now + ms) return;
    if (current) native.cancel.call(current.animation);
    try {
      const clip = view.getComputedStyle(element, pseudo).clipPath || "none";
      const animation = nativeAnimate.call(element, { clipPath: [clip, clip] }, {
        duration: ms,
        ...(pseudo ? { pseudoElement: pseudo } : {}),
      });
      const entry = { animation, until: now + ms };
      byPseudo.set(key, entry);
      live.add(animation);
      const release = () => {
        live.delete(animation);
        if (byPseudo.get(key) === entry) byPseudo.delete(key);
      };
      animation.addEventListener("finish", release);
      animation.addEventListener("cancel", release);
    } catch {
      // A pseudo-element this engine cannot animate from script: leave it be.
    }
  };

  /** `rate` stands in for a playback rate that is still pending. */
  const cover = (animation: Animation, rate = animation.playbackRate) => {
    const effect = animation.effect;
    if (!(effect instanceof view.KeyframeEffect) || !effect.target || isViewTransition(effect.pseudoElement)) return;
    const ms = holdMs(
      effect.getKeyframes() as Array<Record<string, unknown>>,
      effect.getComputedTiming(),
      typeof animation.currentTime === "number" ? animation.currentTime : 0,
      rate,
    );
    if (ms !== null) guard(effect.target, effect.pseudoElement, ms);
  };

  /** Turns a cancel into a commit no CSS transition starts from (see above):
   * the element's style is resolved once, right after the native cancel, with
   * `transition-property: none` inline, and the inline value is put back. It
   * patches the prototype, so a CSS animation or transition cancelled from
   * script gets it too. */
  animationProto.cancel = function cancel(this: Animation) {
    const effect = this.effect;
    const element = effect instanceof view.KeyframeEffect && !effect.pseudoElement ? effect.target : null;
    const style = (element as HTMLElement | null)?.style;
    if (!element || !style || !touchesComposited((effect as KeyframeEffect).getKeyframes() as Array<Record<string, unknown>>)) {
      native.cancel.call(this);
      return;
    }
    const previous = style.getPropertyValue("transition-property");
    const priority = style.getPropertyPriority("transition-property");
    style.setProperty("transition-property", "none", "important");
    try {
      native.cancel.call(this);
      void view.getComputedStyle(element).opacity;
    } finally {
      if (previous) style.setProperty("transition-property", previous, priority);
      else style.removeProperty("transition-property");
    }
  };

  /** A replay, a turn-around or a new speed starts a run the first guard was
   * not sized for. */
  animationProto.play = function play(this: Animation) {
    native.play.call(this);
    cover(this);
  };
  animationProto.reverse = function reverse(this: Animation) {
    native.reverse.call(this);
    cover(this);
  };
  animationProto.updatePlaybackRate = function updatePlaybackRate(this: Animation, rate: number) {
    native.updatePlaybackRate.call(this, rate);
    cover(this, rate);
  };

  proto.animate = function animate(this: Element, ...args: Parameters<Element["animate"]>) {
    const animation = nativeAnimate.apply(this, args);
    cover(animation);
    return animation;
  };

  /** The CSS animation or transition an event is about, on its element. */
  const coverEvent = (event: Event, match: (animation: Animation) => boolean) => {
    const target = event.target;
    if (!(target instanceof view.Element)) return;
    const pseudo = (event as TransitionEvent | AnimationEvent).pseudoElement || null;
    for (const animation of target.getAnimations({ subtree: pseudo !== null })) {
      const effect = animation.effect as KeyframeEffect | null;
      if (effect?.target === target && (effect.pseudoElement ?? null) === pseudo && match(animation)) cover(animation);
    }
  };

  const onTransition = (event: TransitionEvent) => {
    if (!isCompositedProperty(event.propertyName)) return;
    coverEvent(event, (animation) =>
      animation instanceof view.CSSTransition && animation.transitionProperty === event.propertyName,
    );
  };
  const onAnimation = (event: AnimationEvent) => {
    coverEvent(event, (animation) =>
      animation instanceof view.CSSAnimation && animation.animationName === event.animationName,
    );
  };

  doc.addEventListener("transitionrun", onTransition, true);
  doc.addEventListener("animationstart", onAnimation, true);
  doc.documentElement.setAttribute("data-compositor-handoff", "");
  return () => {
    proto.animate = nativeAnimate;
    Object.assign(animationProto, native);
    for (const animation of live) native.cancel.call(animation);
    live.clear();
    doc.documentElement.removeAttribute("data-compositor-handoff");
    doc.removeEventListener("transitionrun", onTransition, true);
    doc.removeEventListener("animationstart", onAnimation, true);
  };
}
