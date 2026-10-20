/**
 * Pointer sheen (glass-direction §4.2).
 *
 * One delegated pointermove listener writes the pointer position into two custom
 * properties on the hovered `[data-sheen]` element; the CSS turns them into a
 * `transform` on a fixed radial, so a move costs one composited frame and no
 * layout. The element's rect is measured once when the pointer enters it and
 * re-read only on scroll or resize, never per frame.
 *
 * Installed only for a fine pointer with motion allowed. On a coarse pointer or
 * under `prefers-reduced-motion` no listener exists at all, so a tap writes
 * nothing. `main.tsx` calls this once, outside React: StrictMode remounts must
 * not stack listeners.
 */

const TARGET = "[data-sheen]";
const FINE_POINTER = "(hover: hover) and (pointer: fine)";
const CALM = "(prefers-reduced-motion: reduce)";

type Tracked = { element: HTMLElement; rect: DOMRect };

/** Installs the sheen and follows pointer-capability changes. Returns a disposer. */
export function installSheen(doc: Document = document): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};

  const pointer = view.matchMedia(FINE_POINTER);
  const calm = view.matchMedia(CALM);
  let teardown: (() => void) | null = null;

  const sync = () => {
    const wanted = pointer.matches && !calm.matches;
    if (wanted && !teardown) {
      teardown = listen(doc);
    } else if (!wanted && teardown) {
      teardown();
      teardown = null;
    }
  };

  pointer.addEventListener("change", sync);
  calm.addEventListener("change", sync);
  sync();

  return () => {
    pointer.removeEventListener("change", sync);
    calm.removeEventListener("change", sync);
    teardown?.();
    teardown = null;
  };
}

function listen(doc: Document): () => void {
  const view = doc.defaultView!;
  let tracked: Tracked | null = null;
  let frame = 0;
  let x = 0;
  let y = 0;

  const paint = () => {
    frame = 0;
    if (!tracked) return;
    // Custom properties only: this path never reads or writes layout.
    tracked.element.style.setProperty("--sheen-x", `${x}px`);
    tracked.element.style.setProperty("--sheen-y", `${y}px`);
  };

  const forget = () => {
    if (frame) {
      view.cancelAnimationFrame(frame);
      frame = 0;
    }
    if (tracked) {
      tracked.element.style.removeProperty("--sheen-x");
      tracked.element.style.removeProperty("--sheen-y");
    }
    tracked = null;
  };

  const retarget = (element: HTMLElement | null) => {
    if (element === tracked?.element) return;
    forget();
    if (element) {
      // The one layout read, cached until the pointer leaves, scrolls or resizes.
      tracked = { element, rect: element.getBoundingClientRect() };
    }
  };

  const refresh = () => {
    if (tracked) tracked.rect = tracked.element.getBoundingClientRect();
  };

  const onPointerMove = (event: PointerEvent) => {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>(TARGET) : null;
    retarget(element);
    if (!tracked) return;
    x = event.clientX - tracked.rect.left;
    y = event.clientY - tracked.rect.top;
    if (!frame) frame = view.requestAnimationFrame(paint);
  };

  const onPointerOut = (event: PointerEvent) => {
    if (!tracked) return;
    const next = event.relatedTarget;
    if (next instanceof Node && tracked.element.contains(next)) return;
    forget();
  };

  doc.addEventListener("pointermove", onPointerMove, { passive: true });
  doc.addEventListener("pointerout", onPointerOut, { passive: true });
  view.addEventListener("scroll", refresh, { passive: true, capture: true });
  view.addEventListener("resize", refresh, { passive: true });

  return () => {
    forget();
    doc.removeEventListener("pointermove", onPointerMove);
    doc.removeEventListener("pointerout", onPointerOut);
    view.removeEventListener("scroll", refresh, { capture: true });
    view.removeEventListener("resize", refresh);
  };
}
