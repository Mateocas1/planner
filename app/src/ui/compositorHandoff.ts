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
  const left = (end - currentTime) / Math.abs(playbackRate);
  return left > 0 ? left + MARGIN_MS : null;
}

type Guard = { animation: Animation; until: number };

/** Patches `Element.prototype.animate` and listens for CSS transitions and
 * animations. Returns a disposer. */
export function installCompositorHandoff(doc: Document = document): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};
  const proto = view.Element.prototype;
  const nativeAnimate = proto.animate;
  /** One guard per element and pseudo-element, extended rather than stacked. */
  const guards = new WeakMap<Element, Map<string, Guard>>();

  const guard = (element: Element, pseudo: string | null, ms: number) => {
    const key = pseudo ?? "";
    let byPseudo = guards.get(element);
    if (!byPseudo) guards.set(element, (byPseudo = new Map()));
    const now = view.performance.now();
    const current = byPseudo.get(key);
    if (current && current.until >= now + ms) return;
    current?.animation.cancel();
    try {
      const clip = view.getComputedStyle(element, pseudo).clipPath || "none";
      const animation = nativeAnimate.call(element, { clipPath: [clip, clip] }, {
        duration: ms,
        ...(pseudo ? { pseudoElement: pseudo } : {}),
      });
      const entry = { animation, until: now + ms };
      byPseudo.set(key, entry);
      const release = () => {
        if (byPseudo.get(key) === entry) byPseudo.delete(key);
      };
      animation.addEventListener("finish", release);
      animation.addEventListener("cancel", release);
    } catch {
      // A pseudo-element this engine cannot animate from script: leave it be.
    }
  };

  const cover = (animation: Animation) => {
    const effect = animation.effect;
    if (!(effect instanceof view.KeyframeEffect) || !effect.target) return;
    const ms = holdMs(
      effect.getKeyframes() as Array<Record<string, unknown>>,
      effect.getComputedTiming(),
      typeof animation.currentTime === "number" ? animation.currentTime : 0,
      animation.playbackRate,
    );
    if (ms !== null) guard(effect.target, effect.pseudoElement, ms);
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
  return () => {
    proto.animate = nativeAnimate;
    doc.removeEventListener("transitionrun", onTransition, true);
    doc.removeEventListener("animationstart", onAnimation, true);
  };
}
