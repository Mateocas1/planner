import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { animate, usePresence, useReducedMotion } from "motion/react";
import { currentMorph, registerPanel } from "./morph.ts";
import { dur, easeOut, spring } from "./motion.ts";

/**
 * The glass sheet (DESIGN.md §3, "Details"): a floating panel that grows out
 * of the element that opened it and returns towards it when it closes. It is
 * rendered inside an AnimatePresence by its owner; the exit keeps it mounted
 * (usePresence + safeToRemove) until the dismissal animation finishes, so
 * Close, Escape and a scrim click all leave the same way.
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
 * rest, then starts scaled and offset onto the source's rectangle and springs
 * home. The content fades in a beat later and never scales, so the field the
 * sheet focuses keeps its geometry. Without a measurable source (or with
 * reduced motion) the panel pops from its top-left corner over 150 ms and the
 * content rises the last 4 px.
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
      transition.shared(sheet);
      transition.scrim(scrim);
      return unregister;
    }
    animate(scrim, { opacity: [0, 1] }, { duration: 0.2, ease: easeOut });
    const from = reduced ? null : flipFrom(sheet);
    if (!from) {
      // No measurable source, or reduced motion: the panel pops from its own
      // top-left corner and the content rises the last 4 px behind it. This is
      // the one path where a rise is not the same motion twice.
      animate(sheet, { opacity: [0, 1], scale: reduced ? 1 : [0.97, 1] }, { duration: dur.pop, ease: easeOut });
      animate(
        body,
        { opacity: [0, 1], y: reduced ? 0 : [4, 0] },
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
      return unregister;
    }
    animate(
      sheet,
      {
        x: [from.x, 0],
        y: [from.y, 0],
        scaleX: [from.scaleX, 1],
        scaleY: [from.scaleY, 1],
        opacity: [0.4, 1],
        filter: ["blur(6px)", "blur(0px)"],
      },
      spring.smooth,
    );
    // The panel already carries the movement, so the content only fades in: a
    // rise here would be the same motion twice, and the panel never scales the
    // body, so the field the sheet just focused keeps its geometry.
    animate(body, { opacity: [0, 1] }, { duration: dur.enter, delay: 0.1, ease: easeOut });
    return unregister;
    // Measure once at mount: the origin is where the user's eye already is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isPresent) return;
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
    animate(scrim, { opacity: 0 }, { duration: dur.exit, ease: easeOut });
    const to = reduced ? null : flipFrom(sheet);
    const done = () => safeToRemove?.();
    if (!to) {
      animate(sheet, { opacity: 0 }, { duration: dur.exit, ease: easeOut }).then(done);
      return;
    }
    animate(body, { opacity: 0 }, { duration: 0.1, ease: easeOut });
    const away = 0.45;
    animate(
      sheet,
      {
        x: to.x * away,
        y: to.y * away,
        scaleX: 1 + (to.scaleX - 1) * away,
        scaleY: 1 + (to.scaleY - 1) * away,
        opacity: 0,
        filter: "blur(4px)",
      },
      { duration: dur.exit, ease: easeOut },
    ).then(done);
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


  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

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
        className={`sheet glass glass-sheet ${className}`}
        aria-label={label}
        data-state={isPresent ? "open" : "closing"}
        style={{ pointerEvents: isPresent ? "auto" : "none", display: gone ? "none" : undefined }}
      >
        <div ref={bodyRef} className="sheet-body">{children}</div>
      </aside>
    </>
  );
}
