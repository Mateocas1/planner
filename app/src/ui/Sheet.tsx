import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { animate, usePresence, useReducedMotion } from "motion/react";
import { currentMorph, registerPanel } from "./morph.ts";
import { dur, easeOut, easeOutCss, expandBlur, ms } from "./motion.ts";
import { keepFocusedFieldVisible } from "./viewport.ts";
import { useSwipeDismiss } from "./useSwipeDismiss.ts";
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
   * must only unmount. Owned by the gesture hook below. */
  const { dismissedRef } = useSwipeDismiss({
    surfaceRef: sheetRef,
    scrimRef,
    handleSelector: ".sheet-head",
    reduced,
    // A shared sheet closes through the view transition, which owns the
    // commit: no flight of ours, the close runs at once.
    commitWithoutFlight: () => morphed.current,
    onDismiss: () => closeRef.current(),
    closeStarted: () => !present.current,
  });
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
    if (dismissedRef.current) {
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
      // A popover over the sheet claims Escape first (usePopover prevents it).
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);


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
