import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { animate, usePresence, useReducedMotion } from "motion/react";
import { easeOut, spring } from "./motion.ts";

/**
 * The glass sheet (DESIGN.md §3, "Details"): a floating panel that grows out
 * of the element that opened it and returns to it when it closes. It is
 * rendered inside an AnimatePresence by its owner; the exit waits for the
 * return animation before the element leaves the DOM.
 *
 * The morph is a FLIP on transform only: the sheet is laid out at rest, then
 * starts scaled and offset onto the source's rectangle and springs home. The
 * content fades in a beat later so it never reads stretched. Without a source
 * (or with reduced motion) the sheet cross-fades instead.
 */
export function Sheet({
  label,
  className = "",
  origin,
  onClose,
  children,
}: {
  label: string;
  className?: string;
  origin: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const [isPresent, safeToRemove] = usePresence();
  const reduced = useReducedMotion();
  const sheetRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);

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
    animate(scrim, { opacity: [0, 1] }, { duration: 0.2, ease: easeOut });
    const from = reduced ? null : flipFrom(sheet);
    if (!from) {
      animate(sheet, { opacity: [0, 1], scale: reduced ? 1 : [0.97, 1] }, { duration: 0.18, ease: easeOut });
      return;
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
    animate(body, { opacity: [0, 1] }, { duration: 0.22, delay: 0.1, ease: easeOut });
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
    animate(scrim, { opacity: 0 }, { duration: 0.16, ease: easeOut });
    const to = reduced ? null : flipFrom(sheet);
    const done = () => safeToRemove?.();
    if (!to) {
      animate(sheet, { opacity: 0 }, { duration: 0.14, ease: easeOut }).then(done);
      return;
    }
    animate(body, { opacity: 0 }, { duration: 0.1, ease: easeOut });
    animate(sheet, { ...to, opacity: 0, filter: "blur(4px)" }, { ...spring.smooth, duration: 0.32 }).then(done);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPresent]);

  // Focus returns to the element that opened the sheet.
  useEffect(() => () => {
    if (origin?.isConnected) origin.focus({ preventScroll: true });
  }, [origin]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div
        ref={scrimRef}
        className="scrim"
        aria-hidden="true"
        style={{ pointerEvents: isPresent ? "auto" : "none" }}
        onClick={onClose}
      />
      <aside
        ref={sheetRef}
        className={`sheet glass glass-sheet ${className}`}
        aria-label={label}
        data-state={isPresent ? "open" : "closing"}
        style={{ pointerEvents: isPresent ? "auto" : "none" }}
      >
        <div ref={bodyRef} className="sheet-body">{children}</div>
      </aside>
    </>
  );
}
