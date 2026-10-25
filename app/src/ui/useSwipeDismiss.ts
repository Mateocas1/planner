import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { animate, type AnimationPlaybackControls } from "motion/react";
import { phoneQuery } from "./motion.ts";
import {
  createVelocityTracker,
  dragTransform,
  exitDistance,
  exitDurationMs,
  lockDirection,
  progress,
  rubberBand,
  sheetRadius,
  sheetScale,
  shouldCommit,
  type SwipeDirection,
} from "./swipeDismiss.ts";

/** The resting transform every flight ends on: one string, never four props. */
const restTransform = "translate(0px, 0px) scale(1, 1)";

/** Every inline style the gesture owns on the surface and its scrim, back to
 * nothing. The hook owns exactly these -- the caller's own styles are never
 * touched. */
function clearGestureStyles(surface: HTMLElement, scrim: HTMLElement | null) {
  delete surface.dataset.swiping;
  surface.style.transform = "";
  surface.style.transformOrigin = "";
  surface.style.clipPath = "";
  surface.style.opacity = "";
  surface.style.willChange = "";
  surface.style.pointerEvents = "";
  if (scrim) {
    scrim.style.opacity = "";
    scrim.style.pointerEvents = "";
  }
}

/**
 * Swipe-to-dismiss pointer wiring, shared by the Sheet and the ChatPanel
 * (odd/tasks/ronda4.md, S1). Extracted from Sheet.tsx (task T5) -- the gesture
 * itself is the same code, but the commit-flight end deliberately differs from
 * the removed Sheet version: when the flight lands, the hook cancels it, clears
 * its `fill: forwards` hold, and leaves the surface holding an inline
 * `opacity: 0` before running the caller's close path, so the caller's own
 * exit (the closing card's CSS animation, the sheet's presence exit) starts
 * from a hidden surface instead of flashing back to rest for its duration.
 * The Sheet spec pins this ("a committed swipe holds the sheet invisible").
 *
 * pointer drag on the drag handle (stamped `data-drag-handle`, by default the
 * surface's header) or on plain, non-scrolled surface content follows the
 * finger 1:1, locks to left, right or down after an 8 px slop -- up
 * rubber-bands and never dismisses -- and on release either commits (the
 * surface leaves in the drag direction carrying the release velocity, then the
 * caller's close path runs) or springs back on a motion spring that starts at
 * the release velocity. Mouse gestures start on the handle or on surface that
 * is not text: a press on body copy selects, it never moves the surface. Text
 * fields, buttons and any scroller that can still move in the locked direction
 * never enter the gesture, so selection and scrolling keep working, and
 * pointer capture is taken only after the direction locks so a tap's click
 * keeps its target. A surface a call site stamps `data-swipe-dismiss="off"`
 * owns its own gestures: an embedded page turn (ShutdownSheet, ronda4 F3b) is
 * itself a swipe, and it wins over the dismissal -- after the 8 px slop both
 * gestures lock at once and whoever captures the pointer first steals it from
 * the other, which turned a page drag into a whole-sheet dismissal. Reduced
 * motion keeps the commit/cancel decision but
 * follows nothing: a past-threshold release falls through to the caller's
 * reduced close. A pointerdown mid-snap-back retargets from the spring's
 * current value instead of restarting it. The math itself lives in
 * swipeDismiss.ts.
 *
 * The hook owns the gesture's inline styles on the surface (`transform`,
 * `transform-origin`, `border-radius`, `will-change`, `pointer-events` and
 * `data-swiping`); the caller owns everything else. When `active` flips false
 * mid-gesture (the surface closes under the pointer) the gesture aborts and
 * the styles are cleared, so the caller's own close path is never fought; when
 * it flips true again they are cleared once more, so a reopen always starts
 * from a clean surface.
 */
export function useSwipeDismiss({
  surfaceRef,
  scrimRef,
  handleSelector,
  reduced,
  active = true,
  commitWithoutFlight,
  onDismiss,
  closeStarted,
}: {
  /** The draggable surface (the sheet, the chat panel). */
  surfaceRef: RefObject<HTMLElement | null>;
  /** Optional backdrop that fades with the drag's progress, exactly as the
   * Sheet's scrim does. A surface without one simply omits it. */
  scrimRef?: RefObject<HTMLElement | null>;
  /** The first element matching this selector inside the surface is stamped
   * `data-drag-handle` and becomes the mouse drag handle. */
  handleSelector?: string;
  /** Motion's `useReducedMotion` returns `boolean | null`; null reads as
   * false, exactly as it did in the falsy checks this hook replaces. */
  reduced: boolean | null;
  /** While false no listeners are bound: a closed panel never gestures. */
  active?: boolean;
  /** When this returns true at commit, the close runs at once with no flight
   * -- the shared sheet's view transition owns the close and shrinks the
   * dragged sheet itself (Sheet.tsx `morphed`). */
  commitWithoutFlight?: () => boolean;
  /** The caller's close path, run at commit: after the flight (or at once
   * under reduced motion, or at once without a flight above). */
  onDismiss: () => void;
  /** True once the caller's exit has begun. A commit whose exit never starts
   * is a declined commit: the surface is put back where the drag left it. */
  closeStarted?: () => boolean;
}): { dismissedRef: RefObject<boolean> } {
  /** The latest callbacks, read by the gesture effect without re-binding. */
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const commitWithoutFlightRef = useRef(commitWithoutFlight);
  commitWithoutFlightRef.current = commitWithoutFlight;
  const closeStartedRef = useRef(closeStarted);
  closeStartedRef.current = closeStarted;
  const reducedMotion = reduced === true;
  /** The commit flight, so an `active` flip mid-flight can stop it. */
  const flightRef = useRef<Animation | null>(null);
  /** The commit flight's scrim fade, cancelled beside the flight (finding: an
   * uncaptured `fill: forwards` scrim animation would hold the backdrop at
   * opacity 0 with nothing left to stop it). */
  const scrimFlightRef = useRef<Animation | null>(null);
  /** The swipe already flew this mount out of the viewport (or the view
   * transition captured it): the caller's exit has nothing left to animate. */
  const dismissedRef = useRef(false);

  useEffect(() => {
    const surface = surfaceRef.current;
    const scrim = scrimRef?.current ?? null;
    if (!surface || !active) return;

    // The header is the drag handle; call sites can stamp their own regions too.
    if (handleSelector) surface.querySelector(handleSelector)?.setAttribute("data-drag-handle", "");

    const interactive = (target: EventTarget | null): boolean =>
      target instanceof Element &&
      !!target.closest(
        "button, a, input, textarea, select, label, [contenteditable], [role='button'], summary",
      );
    const onHandle = (target: EventTarget | null): boolean =>
      target instanceof Element && !!target.closest("[data-drag-handle]");

    /**
     * A surface that opted out owns its own gestures (see the doc comment):
     * the call site stamps it `data-swipe-dismiss="off"`; everything outside
     * it still dismisses (S1).
     */
    const optedOut = (target: EventTarget | null): boolean =>
      target instanceof Element && !!target.closest('[data-swipe-dismiss="off"]');

    /**
     * Mouse text rule: a mouse gesture starts on the drag handle or on surface
     * that is not text. A pointerdown on (or under) a text-bearing element --
     * one that matches a text tag or carries its own non-empty text nodes --
     * belongs to selection, so the gesture refuses it and the drag selects
     * copy instead of moving the surface. Touch and pen keep the
     * whole-surface behavior: there, selection is not the primary pointer role.
     */
    const TEXT_TAGS = "p, h1, h2, h3, h4, h5, h6, label, li, dd, dt, blockquote, pre, code, [contenteditable]";
    const carriesText = (node: Element): boolean =>
      Array.from(node.childNodes).some(
        child => child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim() !== "",
      );
    const textBlocksMouse = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return true;
      for (let node: Element | null = target; node && node !== surface; node = node.parentElement) {
        if (node.matches(TEXT_TAGS) || carriesText(node)) return true;
      }
      return false;
    };

    /**
     * A scroller that can still move in the locked direction keeps the gesture:
     * the drag belongs to it, not to the dismissal. The surface's own scroll
     * counts on touch -- a down-drag from a scrolled sheet scrolls, and only
     * from the top edge does it dismiss, iOS-style. A mouse drag cannot scroll
     * anything natively, so there only real horizontal scrollers block.
     */
    const scrollerBlocks = (
      target: EventTarget | null,
      direction: SwipeDirection,
      pointerType: string,
    ): boolean => {
      if (!(target instanceof Element)) return true;
      const canScroll = (node: HTMLElement, axis: "x" | "y", towardStart: boolean) => {
        const overflow = getComputedStyle(node)[axis === "x" ? "overflowX" : "overflowY"];
        if (overflow !== "auto" && overflow !== "scroll") return false;
        if (axis === "x") {
          return towardStart
            ? node.scrollLeft > 0
            : node.scrollLeft + node.clientWidth < node.scrollWidth - 1;
        }
        return towardStart
          ? node.scrollTop > 0
          : node.scrollTop + node.clientHeight < node.scrollHeight - 1;
      };
      if (direction === "left" || direction === "right") {
        for (let node: Element | null = target; node && node !== surface; node = node.parentElement) {
          if (node instanceof HTMLElement && canScroll(node, "x", direction === "right")) return true;
        }
        return false;
      }
      const towardStart = direction === "down";
      for (let node: Element | null = target; node && node !== surface; node = node.parentElement) {
        if (node instanceof HTMLElement && canScroll(node, "y", towardStart)) return true;
      }
      return pointerType !== "mouse" && canScroll(surface, "y", towardStart);
    };

    const velocity = createVelocityTracker();
    const restRadius = () => parseFloat(getComputedStyle(surface).borderTopLeftRadius) || 0;

    type Gesture = {
      pointerId: number;
      startX: number;
      startY: number;
      /** Offset already on the surface when the gesture began (a retargeted
       * snap-back), so the drag continues from wherever the spring is. */
      baseX: number;
      baseY: number;
      target: EventTarget | null;
      direction: SwipeDirection | null;
    };
    let gesture: Gesture | null = null;
    let snapback: AnimationPlaybackControls | null = null;
    let snapbackScrim: AnimationPlaybackControls | null = null;
    /** The rounded phone radius already written this gesture (a border-radius
     * write per move repaints the glass for nothing). */
    let lastRadius: number | null = null;

    const clearInline = () => clearGestureStyles(surface, scrim);

    /** A commit that the caller declines must not leave the surface invisible
     * under the flight's `fill: forwards`: if the exit has not started a frame
     * or two after `onDismiss`, put the surface back where the drag left it. */
    const restoreIfDeclined = () => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!surface.isConnected || closeStartedRef.current?.() || !dismissedRef.current) return;
          dismissedRef.current = false;
          clearInline();
        }),
      );
    };

    const onPointerDown = (event: PointerEvent) => {
      if (gesture || !event.isPrimary) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      // An entry or exit flight owns the transform; only a snap-back is
      // retargetable. The spring is Motion-driven and never shows up in
      // getAnimations, so any animation here is one of those flights.
      if (surface.getAnimations().length > 0) return;
      const target = event.target;
      if (interactive(target)) return;
      if (optedOut(target)) return;
      if (!(target instanceof Element)) return;
      // Mouse: the drag handle or a surface that is not text. Touch and pen
      // start from any surface.
      if (event.pointerType === "mouse" && !onHandle(target) && textBlocksMouse(target)) return;

      let baseX = 0;
      let baseY = 0;
      if (snapback) {
        // Retarget from wherever the spring is now. The freeze must happen
        // around the stop: cancelling a Motion spring rewrites its start
        // value, so read the current matrix and scrim first, cancel, then
        // write the frozen values back and continue the drag from them.
        const computed = getComputedStyle(surface).transform;
        const matrix = computed === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(computed);
        const frozenScrim = scrim ? getComputedStyle(scrim).opacity : null;
        const frozenClip = getComputedStyle(surface).clipPath;
        const controls = snapback;
        const scrimControls = snapbackScrim;
        snapback = null;
        snapbackScrim = null;
        controls.cancel();
        scrimControls?.cancel();
        baseX = matrix.e;
        baseY = matrix.f;
        surface.style.transform = dragTransform(baseX, baseY, matrix.a || 1);
        if (scrim && frozenScrim !== null) scrim.style.opacity = frozenScrim;
        surface.style.clipPath = frozenClip;
      }
      gesture = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        baseX,
        baseY,
        target,
        direction: null,
      };
      velocity.reset();
      lastRadius = null;
      surface.dataset.swiping = "pending";
      // No pointer capture here: capture before the slop lock would retarget
      // the click of a tap on a clickable element to the surface, so its
      // onClick never runs. The gesture takes capture only once it has locked
      // a direction and is really moving the surface.
    };

    const apply = (direction: SwipeDirection, dx: number, dy: number) => {
      const horizontal = direction === "left" || direction === "right";
      const dimension = horizontal ? surface.offsetWidth : surface.offsetHeight;
      let x = 0;
      let y = 0;
      let distance = 0;
      if (direction === "up") {
        // Up rubber-bands and never counts toward progress.
        y = dy < 0 ? -rubberBand(-dy, dimension) : dy;
      } else if (horizontal) {
        x = dx;
        distance = Math.abs(dx);
      } else {
        y = dy;
        distance = Math.abs(dy);
      }
      const p = direction === "up" ? 0 : progress(distance, dimension);
      surface.dataset.swiping = "active";
      surface.style.transformOrigin = "center";
      surface.style.transform = dragTransform(x, y, sheetScale(p));
      // The backdrop fades with the drag's progress.
      if (scrim) scrim.style.opacity = String(1 - p);
      // Phone only: the corners round as the surface shrinks (S1). A
      // full-viewport surface rests at radius 0, the inset phone sheets at
      // --r-sheet; desktop never touches its corners. The rounding rides
      // `clip-path: inset(0 round …)`, not `border-radius`: motion stays on
      // transform/opacity/filter/clip-path (AGENTS.md), and a per-move radius
      // write repaints the backdrop-filter glass for a sub-pixel change
      // nobody can see. The write happens only when the rounded value changes,
      // and a rounded 0 means no clip at all.
      if (window.matchMedia(phoneQuery).matches) {
        const radius = Math.round(sheetRadius(restRadius(), p));
        if (radius !== lastRadius) {
          lastRadius = radius;
          surface.style.clipPath = radius > 0 ? `inset(0px round ${radius}px)` : "none";
        }
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      velocity.add(event.clientX, event.clientY, event.timeStamp);
      const dx = event.clientX - gesture.startX + gesture.baseX;
      const dy = event.clientY - gesture.startY + gesture.baseY;
      if (!gesture.direction) {
        const direction = lockDirection(dx, dy);
        if (!direction) return;
        // Eligibility resolves once a direction exists.
        if (scrollerBlocks(gesture.target, direction, event.pointerType)) {
          gesture = null;
          clearInline();
          return;
        }
        gesture.direction = direction;
        // The gesture just claimed the drag: any text selection the press had
        // begun dies here, where `user-select: none` takes over too.
        document.getSelection()?.removeAllRanges();
        // Capture only now, after the lock: before it, a tap's click would be
        // retargeted to the surface and a clickable element would lose it.
        try {
          surface.setPointerCapture(event.pointerId);
        } catch {
          // A synthetic pointer has nothing to capture; the tracked moves on
          // the surface still drive the gesture.
        }
      }
      if (reducedMotion) return; // reduced motion: decide on release, never follow
      apply(gesture.direction, dx, dy);
    };

    /**
     * Spring back from wherever the surface was released, starting at the
     * release velocity so the return reads as one continuous gesture instead
     * of a keyframe restart. A motion spring (bounce ~0.15) keeps a beat of
     * overshoot-and-settle; a retargeting pointerdown still freezes it from
     * the matrix, exactly as before.
     */
    const springBack = (velocityXPxPerMs = 0, velocityYPxPerMs = 0) => {
      const spring = { type: "spring", bounce: 0.15 } as const;
      // Motion reads the current transform (the drag's translate + scale) as
      // the start, so the spring leaves at the velocity the pointer arrived
      // with -- px/ms here, px/s for Motion.
      const anim = animate(
        surface,
        // The corner rounding comes home too (phone only -- finding: on
        // desktop the radius never left rest, so there is nothing to animate).
        // Motion reads the current `inset(0px round Npx)` off the element and
        // interpolates the radius back to the resting one.
        {
          x: 0,
          y: 0,
          scale: 1,
          ...(window.matchMedia(phoneQuery).matches ? { clipPath: `inset(0px round ${restRadius()}px)` } : {}),
        },
        {
          x: { ...spring, velocity: velocityXPxPerMs * 1000 },
          y: { ...spring, velocity: velocityYPxPerMs * 1000 },
          scale: { ...spring },
          ...(window.matchMedia(phoneQuery).matches ? { clipPath: { ...spring } } : {}),
        },
      );
      // The backdrop comes back with the surface, from the same value.
      const scrimAnim = scrim ? animate(scrim, { opacity: 1 }, { ...spring }) : null;
      snapback = anim;
      snapbackScrim = scrimAnim;
      anim.then(
        () => {
          if (snapback === anim) {
            snapback = null;
            snapbackScrim = null;
            clearInline();
          }
        },
        () => {}, // stopped by a retargeting pointerdown: nothing to clean
      );
    };

    const commit = (
      direction: Exclude<SwipeDirection, "up">,
      dx: number,
      dy: number,
      velocityPxPerMs: number,
    ) => {
      dismissedRef.current = true;
      if (commitWithoutFlightRef.current?.()) {
        // A shared sheet closes through the view transition (morph.ts): the
        // browser captures the dragged sheet as the old side and shrinks it
        // into the row, so the live panel must not fly on its own.
        onDismissRef.current();
        restoreIfDeclined();
        return;
      }
      // Fly out along the drag direction, carrying the release velocity: linear
      // over a velocity-scaled duration. Then the caller's close path runs.
      surface.style.pointerEvents = "none";
      if (scrim) scrim.style.pointerEvents = "none";
      const rect = surface.getBoundingClientRect();
      const remaining = exitDistance(direction, rect, window.innerWidth, window.innerHeight);
      const duration = exitDurationMs(remaining, velocityPxPerMs);
      const endX =
        direction === "left"
          ? dx - (rect.left + rect.width)
          : direction === "right"
            ? dx + (window.innerWidth - rect.left)
            : dx;
      const endY = direction === "down" ? dy + (window.innerHeight - rect.top) : dy;
      const computed = getComputedStyle(surface).transform;
      const scale = (computed === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(computed)).a || 1;
      const flight = surface.animate(
        [{ transform: surface.style.transform || restTransform }, { transform: dragTransform(endX, endY, scale) }],
        { duration, easing: "linear", fill: "forwards" },
      );
      flightRef.current = flight;
      const scrimFlight = scrim?.animate([{ opacity: scrim.style.opacity || "1" }, { opacity: "0" }], {
        duration,
        easing: "linear",
        fill: "forwards",
      });
      if (scrimFlight) scrimFlightRef.current = scrimFlight;
      const done = () => {
        // The guard: a flight the cleanup cancelled rejects its `finished`, and
        // that must never run the close path -- the caller already closed (or
        // is unmounting) and a second `onDismiss` could double-close.
        if (flightRef.current !== flight) return;
        flightRef.current = null;
        scrimFlightRef.current = null;
        // The flight is over: stop holding the end state with `fill` and hold
        // it with an inline opacity instead, so the caller's own exit (the
        // closing card's CSS animation) starts from a hidden surface instead
        // of flashing back to rest for its duration. The gesture's inline
        // transform and clip are cleared here -- the surface is invisible, so
        // nothing can flash.
        flight.cancel();
        scrimFlight?.cancel();
        clearInline();
        surface.style.opacity = "0";
        onDismissRef.current();
        restoreIfDeclined();
      };
      flight.finished.then(done, () => {});
      scrimFlight?.finished.catch(() => {}); // cancelled beside the flight: nothing to do
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const g = gesture;
      gesture = null;
      try {
        surface.releasePointerCapture(event.pointerId);
      } catch {
        // Nothing was captured (synthetic pointer): nothing to release.
      }
      const dx = event.clientX - g.startX + g.baseX;
      const dy = event.clientY - g.startY + g.baseY;
      const direction = g.direction;
      if (!direction) {
        // Never locked: a plain press or a scroller that kept the gesture.
        clearInline();
        return;
      }
      const horizontal = direction === "left" || direction === "right";
      const dimension = horizontal ? surface.offsetWidth : surface.offsetHeight;
      const distance = horizontal ? Math.abs(dx) : Math.abs(dy);
      // The release velocity is read at the release's own timestamp: a pointer
      // that stopped holding its flick before lifting throws nothing.
      const rawX = velocity.velocity("x", event.timeStamp);
      const rawY = velocity.velocity("y", event.timeStamp);
      const raw = horizontal ? rawX : rawY;
      // The release velocity only counts when it moves the way the surface is
      // dragged: a release decelerating against the drag is the user pulling
      // the surface back, not throwing it.
      const dragSign = horizontal ? Math.sign(dx) : Math.sign(dy);
      const velocityAlong = Math.sign(raw) === dragSign ? Math.abs(raw) : 0;
      if (direction !== "up" && shouldCommit(distance, velocityAlong, dimension)) {
        if (reducedMotion) {
          // Reduced motion: no flight of ours; the close path's reduced fade runs.
          clearInline();
          onDismissRef.current();
          return;
        }
        commit(direction, dx, dy, velocityAlong);
        return;
      }
      if (reducedMotion) {
        clearInline();
        return;
      }
      springBack(rawX, rawY);
    };

    const onPointerCancel = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      gesture = null;
      // The surface never followed under reduced motion, and an unlocked drag
      // never moved it: only a real drag needs its spring back.
      if (!reducedMotion && surface.style.transform) springBack();
      else clearInline();
    };

    surface.addEventListener("pointerdown", onPointerDown);
    // Moves, the release and cancellation are tracked on the document: a touch
    // pointer implicitly captures to its target, but a mouse has no implicit
    // capture, so a drag that leaves the surface -- which is what a dismissal
    // is -- would stop being tracked before the gesture ever locks a
    // direction. The handlers are no-ops without an active gesture, and no
    // capture is taken before the lock, so a tap's click still keeps its own
    // target.
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);
    return () => {
      surface.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerCancel);
      // The surface deactivated or unmounted under the pointer: abort the
      // gesture and the running return, and hand the surface back clean so the
      // caller's own close path is never fought.
      if (gesture) {
        gesture = null;
        clearGestureStyles(surface, scrim);
      }
      snapback?.cancel();
      snapbackScrim?.cancel();
      flightRef.current?.cancel();
      flightRef.current = null;
      scrimFlightRef.current?.cancel();
      scrimFlightRef.current = null;
    };
    // The gesture reads geometry live; the commit path is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion, active, surfaceRef, scrimRef, handleSelector]);

  // The clean-up above must also run before the caller's entrance paints when
  // the surface becomes active again: a hold left by a commit flight would
  // otherwise be read by the entrance's implicit end keyframe.
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!active || !surface) return;
    // A reopen always starts clean -- the dismissed state included: a mount
    // that already flew once must still run its next exit normally.
    dismissedRef.current = false;
    clearGestureStyles(surface, scrimRef?.current ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, surfaceRef, scrimRef]);

  return { dismissedRef };
}
