import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { placePopover } from "./placePopover.ts";

/** How long a closed popover is kept mounted when no transition reports back. */
const EXIT_FALLBACK_MS = 260;

export type PopoverOptions = {
  /** Which trigger edge the popover lines up with (default: the end edge). */
  align?: "start" | "end";
  /** Where DOM focus goes on open: the popover (a dialog) or stays on the trigger (a listbox). */
  initialFocus?: "popover" | "trigger";
  /** Called whenever the open state changes, whatever caused it. */
  onOpenChange?: (open: boolean) => void;
};

export type PopoverHandle = {
  open: boolean;
  /** Content is mounted while open and while the exit transition runs. */
  mounted: boolean;
  id: string;
  triggerRef: RefObject<HTMLElement | null>;
  popoverRef: RefObject<HTMLDivElement | null>;
  show: () => void;
  /** Closes; focus returns to the trigger unless `restoreFocus` is false. */
  close: (options?: { restoreFocus?: boolean }) => void;
  toggle: () => void;
};

/**
 * The open/close lifecycle of a `Popover` (see Popover.tsx). It owns the
 * top-layer calls, the JS placement and every way out, so Select and the date
 * field only render their content.
 *
 * Listeners exist only while the popover is open:
 *  - Escape, document capture: closes the popover, returns focus to the
 *    trigger, and is swallowed (preventDefault + stopPropagation) so the sheet
 *    behind it keeps its own Escape for the next press.
 *  - Outside click, document capture: closes without moving focus and is
 *    swallowed, so a click on the scrim never also dismisses the sheet. A click
 *    on the trigger is left to the trigger's own handler (it toggles).
 *  - focusout on the popover and the trigger: focus that leaves both closes
 *    without stealing it back. A null relatedTarget (window blur, a click on
 *    nothing focusable) is ignored; the click handler covers the latter.
 *  - resize, scroll (capture, so the sheet's scroller counts), visualViewport
 *    resize/scroll and a content resize re-place, coalesced to one write per
 *    frame.
 *
 * Focus returns to the trigger on Escape and after a choice (`close()`), not
 * after an outside click or a Tab out.
 */
export function usePopover({ align = "end", initialFocus = "trigger", onOpenChange }: PopoverOptions = {}): PopoverHandle {
  const id = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [exiting, setExiting] = useState(false);
  const latest = useRef({ align, initialFocus, onOpenChange });
  useLayoutEffect(() => {
    latest.current = { align, initialFocus, onOpenChange };
  });
  /** The requested state, readable synchronously from event handlers. */
  const wanted = useRef(false);
  /** The element is in the top layer (set once it has been shown and placed). */
  const shown = useRef(false);

  const change = useCallback((next: boolean) => {
    if (wanted.current === next) return;
    wanted.current = next;
    setOpen(next);
    latest.current.onOpenChange?.(next);
  }, []);
  const show = useCallback(() => change(true), [change]);
  const close = useCallback(
    (options?: { restoreFocus?: boolean }) => {
      change(false);
      if (options?.restoreFocus !== false) triggerRef.current?.focus({ preventScroll: true });
    },
    [change],
  );
  const toggle = useCallback(() => {
    if (wanted.current) close();
    else show();
  }, [close, show]);

  const place = useCallback(() => {
    const el = popoverRef.current;
    const trigger = triggerRef.current;
    if (!el || !trigger || !shown.current) return;
    const box = trigger.getBoundingClientRect();
    // The natural size is measured with the cap lifted, and the minimum width
    // (the trigger's) already in place; layout size ignores the entrance scale.
    el.style.setProperty("--pop-min-w", `${box.width}px`);
    el.style.setProperty("--pop-max-h", "none");
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    const vv = window.visualViewport;
    const viewport = vv
      ? { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height }
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const placed = placePopover({
      trigger: { left: box.left, top: box.top, width: box.width, height: box.height },
      size,
      viewport,
      align: latest.current.align,
    });
    el.style.left = `${placed.left}px`;
    el.style.top = `${placed.top}px`;
    el.style.setProperty("--pop-max-h", `${placed.maxHeight}px`);
    el.style.setProperty("--pop-ox", `${placed.originX}px`);
    el.style.setProperty("--pop-oy", `${placed.originY}px`);
    el.dataset.side = placed.placement;
  }, []);

  // Show and hide the top-layer element with the state. Layout effect: the
  // surface is placed before the browser paints its first frame.
  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!el) return;
    if (open) {
      setExiting(false);
      if (!el.matches(":popover-open")) el.showPopover?.();
      shown.current = true;
      place();
      if (latest.current.initialFocus === "popover") {
        const target = el.querySelector<HTMLElement>("[data-autofocus]") ?? el;
        target.focus({ preventScroll: true });
      }
      return;
    }
    if (!shown.current) return;
    shown.current = false;
    if (el.matches(":popover-open")) el.hidePopover?.();
    setExiting(true);
    let timer = 0;
    const done = () => {
      el.removeEventListener("transitionend", onEnd);
      el.removeEventListener("transitioncancel", onEnd);
      window.clearTimeout(timer);
      setExiting(false);
    };
    const onEnd = (event: Event) => {
      if (event.target === el && (event as TransitionEvent).propertyName === "opacity") done();
    };
    el.addEventListener("transitionend", onEnd);
    el.addEventListener("transitioncancel", onEnd);
    timer = window.setTimeout(done, EXIT_FALLBACK_MS);
    return () => {
      // Reopened mid-exit: the new show owns the element again.
      el.removeEventListener("transitionend", onEnd);
      el.removeEventListener("transitioncancel", onEnd);
      window.clearTimeout(timer);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const el = popoverRef.current;
    const trigger = triggerRef.current;
    if (!el) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (el.contains(target) || trigger?.contains(target) === true);

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const onClick = (event: MouseEvent) => {
      if (inside(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: false });
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next === null || inside(next)) return;
      close({ restoreFocus: false });
    };

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    const onScroll = (event: Event) => {
      // The body scrolling inside the popover moves nothing.
      if (event.target instanceof Node && el.contains(event.target)) return;
      schedule();
    };

    document.addEventListener("keydown", onKey, true);
    document.addEventListener("click", onClick, true);
    el.addEventListener("focusout", onFocusOut);
    trigger?.addEventListener("focusout", onFocusOut);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", onScroll, true);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(el);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("click", onClick, true);
      el.removeEventListener("focusout", onFocusOut);
      trigger?.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", onScroll, true);
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      observer?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [open, close, place]);

  return { open, mounted: open || exiting, id, triggerRef, popoverRef, show, close, toggle };
}
