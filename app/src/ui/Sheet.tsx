import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { animate, usePresence, useReducedMotion } from "motion/react";
import { currentMorph, registerPanel } from "./morph.ts";
import { dur, easeOut, easeOutCss, expandBlur, ms, phoneQuery } from "./motion.ts";
import { keepFocusedFieldVisible } from "./viewport.ts";
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
import "./Sheet.css";

/** The resting transform every flight ends on: one string, never four props. */
const restTransform = "translate(0px, 0px) scale(1, 1)";

/** One composited transform for a sheet laid over a box `scale` times its size. */
const flightTransform = (x: number, y: number, scaleX: number, scaleY: number) =>
  `translate(${x}px, ${y}px) scale(${scaleX}, ${scaleY})`;

/**
 * The glass sheet (DESIGN.md §3, "Details"): a floating card centred in what the
 * user can see (app.css, S2/S3) that grows out of the element that opened it and
 * returns towards it when it closes. It is rendered inside an AnimatePresence by
 * its owner; the exit keeps it mounted (usePresence + safeToRemove) until the
 * dismissal animation finishes, so Close, Escape and a scrim click all leave the
 * same way, and a panel reopened mid-dismissal flies in again instead of being
 * left where the dismissal stopped.
 *
 * A `shared` sheet leaves the flight to the native view transition started by
 * morph.ts (the row's box becomes the panel's): the owner opens it with
 * morphOpen and closes it with morphClose, and both sides are snapshots, so the
 * panel's text is never drawn at the row's aspect ratio. Mounting inside that
 * transition is what tells the sheet so -- it claims the shared name, puts it
 * on the panel and the scrim, and animates nothing itself. Everything below is
 * then the fallback path: no View Transition API, or reduced motion.
 *
 * The fallback entry is a FLIP on transform only: the sheet is laid out at
 * rest, then starts scaled and offset onto the source's rectangle and flies home
 * on one composited `transform` string (WAAPI, 400 ms ease-out) while its
 * opacity comes up behind it. One string, not x/y/scaleX/scaleY: those
 * shorthands are written by script every frame, while a single transform runs
 * off the main thread. The content behind it comes into focus: a short
 * blur-to-sharp (8 px, 4 px on touch), applied to .sheet-body and cleared when
 * it lands. Never to the sheet itself -- a filter on a backdrop-filter surface
 * makes the glass behind it repaint flat, which is the material it is made of.
 * The content never gets a scale of its own, so the field the sheet focuses
 * keeps its geometry. Without a measurable source (or with reduced motion) the
 * panel pops from its top-left corner over 150 ms and the content rises the last
 * 4 px.
 *
 * The fallback exit covers less ground than the entry: a dismissal says "gone",
 * not "back where it came from", so it travels 45% of the way to the source in
 * 180 ms. With a view transition the exit is a morphed close instead and the
 * sheet unmounts at once: its snapshot is already taken, and a second animation
 * would fight the one the browser is playing.
 */
export function Sheet({
  label,
  className = "",
  origin,
  shared = false,
  onClose,
  children,
}: {
  label: string;
  className?: string;
  origin: HTMLElement | null;
  /** Whether this panel is opened and closed through the view transition in
   * morph.ts (the task details panels are; the creation sheets are not). */
  shared?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const [isPresent, safeToRemove] = usePresence();
  const reduced = useReducedMotion();
  const sheetRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  /** This mount arrived through a view transition, which owns both ends. */
  const morphed = useRef(false);
  /** The entry ran at mount; anything later is a re-entry (see the effect below). */
  const entered = useRef(false);
  /** Presence as of the last commit, so a superseded exit never removes a
   * panel the user has just reopened. */
  const present = useRef(isPresent);
  /** The control inside the panel that had the caret when it was dismissed, so
   * a reopen puts the caret back where the user left it. */
  const lastField = useRef<HTMLElement | null>(null);
  /** The swipe already flew this mount out of the viewport (or the view
   * transition captured it): the presence exit has nothing left to animate and
   * must only unmount. */
  const dismissed = useRef(false);
  /** The latest close callback, read by the gesture effect without re-binding. */
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    present.current = isPresent;
  }, [isPresent]);

  /** Transform that lays the resting sheet over the origin's current box. */
  const flipFrom = (sheet: HTMLElement) => {
    if (!origin?.isConnected) return null;
    const from = origin.getBoundingClientRect();
    const rest = { left: sheet.offsetLeft, top: sheet.offsetTop, width: sheet.offsetWidth, height: sheet.offsetHeight };
    if (from.width === 0 || rest.width === 0) return null;
    return {
      x: from.left - rest.left,
      y: from.top - rest.top,
      scaleX: from.width / rest.width,
      scaleY: from.height / rest.height,
    };
  };

  /**
   * One entrance: the panel travels from the trigger's box to its resting box,
   * and the content behind it comes into focus. Re-runnable -- a panel that is
   * re-admitted while its dismissal still runs flies in again -- so it reads
   * the origin and the current viewport each time.
   */
  const playEntry = (sheet: HTMLElement, body: HTMLElement, scrim: HTMLElement) => {
    animate(scrim, { opacity: [0, 1] }, { duration: 0.2, ease: easeOut });
    const from = reduced ? null : flipFrom(sheet);
    if (!from) {
      // No measurable source, or reduced motion: the panel pops from its own
      // top-left corner and the content rises the last 4 px behind it. This is
      // the one path where a rise is not the same motion twice. With reduced
      // motion neither scale nor rise is handed to Motion at all, so the only
      // animation left is the fade.
      animate(
        sheet,
        reduced ? { opacity: [0, 1] } : { opacity: [0, 1], scale: [0.97, 1] },
        { duration: dur.pop, ease: easeOut },
      );
      animate(
        body,
        reduced ? { opacity: [0, 1] } : { opacity: [0, 1], y: [4, 0] },
        {
          duration: dur.enter,
          ease: easeOut,
          // drop the identity transform once it lands: a composited body would
          // soften the text the sheet has just put the caret in
          onComplete: () => {
            body.style.transform = "";
          },
        },
      );
      return;
    }
    // The flight is native WAAPI with one transform string, so the browser owns
    // it on the compositor even while the form it carries is still settling.
    sheet.animate(
      [
        {
          transform: flightTransform(from.x, from.y, from.scaleX, from.scaleY),
          opacity: 0.4,
        },
        { transform: restTransform, opacity: 1 },
      ],
      { duration: ms(dur.flight), easing: easeOutCss },
    );
    // The panel already carries the movement, so the content only fades in and
    // sharpens: a rise here would be the same motion twice, and the panel never
    // scales the body, so the field the sheet just focused keeps its geometry.
    // The blur is a focus pull, not motion -- 8 px on a fine pointer and 4 px on
    // touch -- and it goes on the body only: a filter on the sheet itself would
    // repaint the glass behind it flat.
    const radius = window.matchMedia("(pointer: coarse)").matches ? expandBlur.coarse : expandBlur.fine;
    animate(body, { opacity: [0, 1] }, { duration: dur.enter, delay: 0.06, ease: easeOut });
    // The blur is native WAAPI so the filter is interpolated on the compositor
    // and, unlike a script-written value, leaves nothing behind: with fill
    // "backwards" it holds the first frame through the delay and hands the body
    // back un-filtered when it lands (no lingering layer under the caret).
    body.animate([{ filter: `blur(${radius}px)` }, { filter: "blur(0px)" }], {
      duration: ms(dur.blur),
      delay: 60,
      easing: easeOutCss,
      fill: "backwards",
    });
  };

  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    const body = bodyRef.current;
    const scrim = scrimRef.current;
    if (!sheet || !body || !scrim) return;
    // Registered before the browser paints, so a dismissal that starts in the
    // same frame as the mount still finds a panel to shrink.
    const unregister = shared ? registerPanel(sheet, scrim) : undefined;
    const transition = shared ? currentMorph() : null;
    if (transition) {
      // The row is growing into this panel: name both sides of the morph and
      // leave the geometry to the browser. A Motion flight here would be a
      // second owner of the same entrance.
      morphed.current = true;
      entered.current = true;
      transition.shared(sheet);
      transition.scrim(scrim);
      return unregister;
    }
    entered.current = true;
    playEntry(sheet, body, scrim);
    return unregister;
    // Measure once at mount: the origin is where the user's eye already is (a
    // re-entry measures again, in the effect below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isPresent) {
      // A panel re-admitted while its dismissal still runs is the same mount:
      // the entry above does not run again, and the dismissal is still filling
      // forwards, which would leave the panel 45% away from its own box at
      // opacity 0. Cancel what the dismissal wrote, drop the inline values it
      // stopped on, and fly in again from the trigger -- which is exactly what
      // reopening a panel should do.
      if (!entered.current) {
        entered.current = true;
        return;
      }
      const sheet = sheetRef.current;
      const body = bodyRef.current;
      const scrim = scrimRef.current;
      if (!sheet || !body || !scrim || morphed.current) return;
      for (const element of [sheet, body, scrim]) {
        for (const animation of element.getAnimations()) animation.cancel();
        element.style.opacity = "";
        element.style.transform = "";
        element.style.filter = "";
      }
      playEntry(sheet, body, scrim);
      // The caret is part of opening a panel: a fresh mount gets it from the
      // field's own autoFocus, and a re-admitted panel takes back the control the
      // user had -- the press that reopened it left the caret on the trigger
      // behind the scrim.
      const field = lastField.current;
      if (field?.isConnected && !sheet.contains(document.activeElement)) field.focus({ preventScroll: true });
      return;
    }
    const sheet = sheetRef.current;
    const scrim = scrimRef.current;
    const body = bodyRef.current;
    if (!sheet || !scrim || !body) {
      safeToRemove?.();
      return;
    }
    if (morphed.current) {
      // The close was a view transition: the panel's snapshot is already
      // taken, so the live panel leaves now and the row grows back on its own.
      safeToRemove?.();
      return;
    }
    // Remember where the caret was inside the panel: if this dismissal is
    // superseded by a reopen, that is where it goes back.
    lastField.current =
      document.activeElement instanceof HTMLElement && sheet.contains(document.activeElement)
        ? document.activeElement
        : null;
    if (dismissed.current) {
      // The swipe already flew the panel out (or the view transition captured
      // it): the exit has nothing left to animate, so only the unmount is left.
      safeToRemove?.();
      return;
    }
    animate(scrim, { opacity: 0 }, { duration: dur.exit, ease: easeOut });
    const to = reduced ? null : flipFrom(sheet);
    // A dismissal that is superseded by a reopen must not remove the panel the
    // user is looking at: the caret and the mount now belong to the new state.
    const done = () => {
      if (!present.current) safeToRemove?.();
    };
    if (!to) {
      animate(sheet, { opacity: 0 }, { duration: dur.exit, ease: easeOut }).then(done);
      return;
    }
    animate(body, { opacity: 0 }, { duration: 0.1, ease: easeOut });
    const away = 0.45;
    // One keyframe: WAAPI takes the start from whatever the sheet is showing,
    // so a dismissal fired mid-entry continues from there instead of snapping
    // back to rest first. `forwards` holds the last frame until the unmount --
    // with fill:none the removed animation would flash the panel back for a
    // frame.
    sheet
      .animate(
        [
          {
            transform: flightTransform(
              to.x * away,
              to.y * away,
              1 + (to.scaleX - 1) * away,
              1 + (to.scaleY - 1) * away,
            ),
            opacity: 0,
          },
        ],
        { duration: ms(dur.exit), easing: easeOutCss, fill: "forwards" },
      )
      .finished.then(done, done);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPresent]);

  // Focus returns to what opened the sheet. The origin is the row (its box is
  // what the panel grew from), and a row is not focusable by itself: the control
  // inside it is the thing the user pressed, so that is where the caret goes.
  //
  // The sheet unmounts when its exit animation is over, which can be a beat
  // after the user moved on: a creation sheet submitted and then a row opened
  // while it was still animating out, or any other control pressed in that
  // window. The caret comes back only if it is still loose -- removing the
  // focused field drops it to <body>. Anything else holding focus is where the
  // user (or the panel they opened next) already is, and this closing sheet has
  // no claim on it.
  useEffect(() => {
    const sheet = sheetRef.current;
    return () => {
      if (!origin?.isConnected) return;
      const active = document.activeElement;
      const loose = active === null || active === document.body || active === sheet || sheet?.contains(active) === true;
      if (!loose) return;
      // A row holds a check and its title button; the button is the control that
      // opened the panel, so it is the one that gets the caret back.
      const control = "button, [href], select, textarea";
      const target = origin.matches(control) ? origin : origin.querySelector<HTMLElement>(control);
      (target ?? origin).focus({ preventScroll: true });
    };
  }, [origin]);


  /* Escape belongs to the sheet, and the sheet is painted the moment it is
     mounted: this is a layout effect so a press that arrives on the first
     frame already finds the listener. A passive effect lands after that paint,
     and a sheet the user can see would then ignore its own dismissal key. */
  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** The sheet's current box as a matrix; identity when nothing is applied. */
  const sheetMatrix = (element: HTMLElement) => {
    const computed = getComputedStyle(element).transform;
    return computed === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(computed);
  };

  /**
   * Swipe to dismiss (odd/tasks/ronda4.md, S1). A pointer drag on the drag
   * handle (the sheet's header, stamped `data-drag-handle`) or on plain,
   * non-scrolled surface content follows the finger 1:1, locks to left, right
   * or down after an 8 px slop -- up rubber-bands and never dismisses -- and
   * on release either commits (the sheet leaves in the drag direction carrying
   * the release velocity, then the ordinary close path runs: same `onClose`,
   * same focus return, and for a shared sheet the same view transition) or
   * springs back. Text fields, buttons and any scroller that can still move in
   * the locked direction never enter the gesture, so selection and scrolling
   * keep working. Reduced motion keeps the commit/cancel decision but follows
   * nothing: a past-threshold release falls through to the existing reduced
   * fade. A pointerdown mid-snap-back retargets from the spring's current
   * value instead of restarting it. The math itself lives in swipeDismiss.ts.
   */
  useEffect(() => {
    const sheet = sheetRef.current;
    const scrim = scrimRef.current;
    if (!sheet || !scrim) return;

    // The header is the drag handle; call sites can stamp their own regions too.
    sheet.querySelector(".sheet-head")?.setAttribute("data-drag-handle", "");

    const interactive = (target: EventTarget | null): boolean =>
      target instanceof Element &&
      !!target.closest(
        "button, a, input, textarea, select, label, [contenteditable], [role='button'], summary",
      );
    const onHandle = (target: EventTarget | null): boolean =>
      target instanceof Element && !!target.closest("[data-drag-handle]");

    /**
     * A scroller that can still move in the locked direction keeps the gesture:
     * the drag belongs to it, not to the dismissal. The sheet's own scroll
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
        for (let node: Element | null = target; node && node !== sheet; node = node.parentElement) {
          if (node instanceof HTMLElement && canScroll(node, "x", direction === "right")) return true;
        }
        return false;
      }
      const towardStart = direction === "down";
      for (let node: Element | null = target; node && node !== sheet; node = node.parentElement) {
        if (node instanceof HTMLElement && canScroll(node, "y", towardStart)) return true;
      }
      return pointerType !== "mouse" && canScroll(sheet, "y", towardStart);
    };

    const velocity = createVelocityTracker();
    const restRadius = () => parseFloat(getComputedStyle(sheet).borderTopLeftRadius) || 0;

    type Gesture = {
      pointerId: number;
      startX: number;
      startY: number;
      /** Offset already on the sheet when the gesture began (a retargeted
       * snap-back), so the drag continues from wherever the spring is. */
      baseX: number;
      baseY: number;
      target: EventTarget | null;
      direction: SwipeDirection | null;
    };
    let gesture: Gesture | null = null;
    let snapback: Animation | null = null;
    let snapbackScrim: Animation | null = null;

    const clearInline = () => {
      delete sheet.dataset.swiping;
      sheet.style.transform = "";
      sheet.style.transformOrigin = "";
      sheet.style.borderRadius = "";
      scrim.style.opacity = "";
    };

    const onPointerDown = (event: PointerEvent) => {
      if (gesture || !event.isPrimary) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      // An entry or exit flight owns the transform; only a snap-back is
      // retargetable.
      if (sheet.getAnimations().some(animation => animation !== snapback)) return;
      const target = event.target;
      if (interactive(target)) return;
      if (!onHandle(target) && !(target instanceof Element)) return;

      let baseX = 0;
      let baseY = 0;
      if (snapback) {
        // Retarget from wherever the spring is now, and freeze that value into
        // the inline styles so cancelling the animations changes nothing.
        const matrix = sheetMatrix(sheet);
        baseX = matrix.e;
        baseY = matrix.f;
        sheet.style.transform = dragTransform(baseX, baseY, matrix.a || 1);
        scrim.style.opacity = getComputedStyle(scrim).opacity;
        sheet.style.borderRadius = getComputedStyle(sheet).borderTopLeftRadius;
        snapback.cancel();
        snapbackScrim?.cancel();
        snapback = null;
        snapbackScrim = null;
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
      sheet.dataset.swiping = "pending";
      try {
        sheet.setPointerCapture(event.pointerId);
      } catch {
        // A synthetic pointer has nothing to capture; the tracked moves on the
        // sheet still drive the gesture.
      }
    };

    const apply = (direction: SwipeDirection, dx: number, dy: number) => {
      const horizontal = direction === "left" || direction === "right";
      const dimension = horizontal ? sheet.offsetWidth : sheet.offsetHeight;
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
      sheet.dataset.swiping = "active";
      sheet.style.transformOrigin = "center";
      sheet.style.transform = dragTransform(x, y, sheetScale(p));
      // The backdrop fades with the drag's progress.
      scrim.style.opacity = String(1 - p);
      // Phone only: the corners round as the sheet shrinks (S1). A full-viewport
      // sheet rests at radius 0, the inset phone sheets at --r-sheet; desktop
      // never touches its radius. The write is a paint of the sheet's own
      // composited layer (will-change is held by data-swiping), never a layout.
      if (window.matchMedia(phoneQuery).matches) {
        sheet.style.borderRadius = `${sheetRadius(restRadius(), p)}px`;
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
      }
      if (reduced) return; // reduced motion: decide on release, never follow
      apply(gesture.direction, dx, dy);
    };

    const springBack = () => {
      const from = sheet.style.transform || restTransform;
      const fromRadius = sheet.style.borderRadius || restRadius();
      const fromScrim = scrim.style.opacity || "1";
      const anim = sheet.animate(
        [
          { transform: from, borderRadius: `${fromRadius}px` },
          { transform: restTransform, borderRadius: `${restRadius()}px` },
        ],
        { duration: 280, easing: easeOutCss },
      );
      // The backdrop comes back with the sheet, from the same value.
      const scrimAnim = scrim.animate([{ opacity: fromScrim }, { opacity: "1" }], {
        duration: 280,
        easing: easeOutCss,
      });
      snapback = anim;
      snapbackScrim = scrimAnim;
      anim.finished.then(
        () => {
          if (snapback === anim) {
            snapback = null;
            snapbackScrim = null;
            clearInline();
          }
        },
        () => {}, // cancelled by a retargeting pointerdown: nothing to clean
      );
    };

    const commit = (
      direction: Exclude<SwipeDirection, "up">,
      dx: number,
      dy: number,
      velocityPxPerMs: number,
    ) => {
      dismissed.current = true;
      if (morphed.current) {
        // A shared sheet closes through the view transition (morph.ts): the
        // browser captures the dragged sheet as the old side and shrinks it
        // into the row, so the live panel must not fly on its own.
        closeRef.current();
        return;
      }
      // Fly out along the drag direction, carrying the release velocity: linear
      // over a velocity-scaled duration. Then the ordinary close path runs.
      sheet.style.pointerEvents = "none";
      scrim.style.pointerEvents = "none";
      const rect = sheet.getBoundingClientRect();
      const remaining = exitDistance(direction, rect, window.innerWidth, window.innerHeight);
      const duration = exitDurationMs(remaining, velocityPxPerMs);
      const endX =
        direction === "left"
          ? dx - (rect.left + rect.width)
          : direction === "right"
            ? dx + (window.innerWidth - rect.left)
            : dx;
      const endY = direction === "down" ? dy + (window.innerHeight - rect.top) : dy;
      const scale = sheetMatrix(sheet).a || 1;
      const flight = sheet.animate(
        [{ transform: sheet.style.transform || restTransform }, { transform: dragTransform(endX, endY, scale) }],
        { duration, easing: "linear", fill: "forwards" },
      );
      scrim.animate([{ opacity: scrim.style.opacity || "1" }, { opacity: "0" }], {
        duration,
        easing: "linear",
        fill: "forwards",
      });
      const done = () => closeRef.current();
      flight.finished.then(done, done);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const g = gesture;
      gesture = null;
      try {
        sheet.releasePointerCapture(event.pointerId);
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
      const dimension = horizontal ? sheet.offsetWidth : sheet.offsetHeight;
      const distance = horizontal ? Math.abs(dx) : Math.abs(dy);
      const raw = velocity.velocity(horizontal ? "x" : "y");
      // The release velocity only counts when it moves the way the sheet is
      // dragged: a release decelerating against the drag is the user pulling
      // the sheet back, not throwing it.
      const dragSign = horizontal ? Math.sign(dx) : Math.sign(dy);
      const velocityAlong = Math.sign(raw) === dragSign ? Math.abs(raw) : 0;
      if (direction !== "up" && shouldCommit(distance, velocityAlong, dimension)) {
        if (reduced) {
          // Reduced motion: no flight of ours; the close path's reduced fade runs.
          clearInline();
          closeRef.current();
          return;
        }
        commit(direction, dx, dy, velocityAlong);
        return;
      }
      if (reduced) {
        clearInline();
        return;
      }
      springBack();
    };

    const onPointerCancel = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      gesture = null;
      // The sheet never followed under reduced motion, and an unlocked drag
      // never moved it: only a real drag needs its spring back.
      if (!reduced && sheet.style.transform) springBack();
      else clearInline();
    };

    sheet.addEventListener("pointerdown", onPointerDown);
    sheet.addEventListener("pointermove", onPointerMove);
    sheet.addEventListener("pointerup", onPointerUp);
    sheet.addEventListener("pointercancel", onPointerCancel);
    return () => {
      sheet.removeEventListener("pointerdown", onPointerDown);
      sheet.removeEventListener("pointermove", onPointerMove);
      sheet.removeEventListener("pointerup", onPointerUp);
      sheet.removeEventListener("pointercancel", onPointerCancel);
      snapback?.cancel();
      snapbackScrim?.cancel();
    };
    // The gesture reads geometry live; `shared` only decides the commit path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, shared]);

  // A field that takes focus while the on-screen keyboard is up must not end up
  // behind it, and neither must the field the sheet already had when the
  // keyboard arrives over the panel. keepFocusedFieldVisible covers both and
  // moves the sheet's own scroller by the overlap -- never the page, and never a
  // field that was already in the clear.
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    return keepFocusedFieldVisible(sheet);
  }, []);

  // A morphed close removes the panel from the new state at once: it must not
  // be painted twice while the row is still growing back. Its snapshot is the
  // panel that was on screen a frame ago, which is what the morph shrinks.
  const gone = !isPresent && morphed.current;

  return (
    <>
      <div
        ref={scrimRef}
        className="scrim"
        aria-hidden="true"
        style={{ pointerEvents: isPresent ? "auto" : "none", display: gone ? "none" : undefined }}
        onClick={onClose}
      />
      <aside
        ref={sheetRef}
        className={`sheet glass glass-thick ${className}`}
        aria-label={label}
        data-state={isPresent ? "open" : "closing"}
        style={{ pointerEvents: isPresent ? "auto" : "none", display: gone ? "none" : undefined }}
      >
        <div ref={bodyRef} className="sheet-body">{children}</div>
      </aside>
    </>
  );
}
