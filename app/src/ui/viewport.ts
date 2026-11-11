import { useEffect, useState } from "react";

/**
 * The on-screen keyboard's covered band, published to CSS as `--kb-inset`.
 *
 * Two different platform behaviours need covering. Chrome on Android resizes
 * the layout viewport for the keyboard unless the viewport meta says
 * `interactive-widget=resizes-content` (index.html now does), and iOS Safari
 * never resizes it: only `window.visualViewport` shrinks, and the layout
 * viewport -- what `position: fixed`, `100vh` and `dvh` measure against -- keeps
 * its height, so a bottom-anchored sheet ends up under the keyboard. Neither
 * `100vh` nor `dvh` sees that, because the keyboard is not browser chrome.
 *
 * So the covered band is measured, not assumed: the layout viewport keeps its
 * height (window.innerHeight), the visual viewport shows the rest, and its
 * offsetTop is how far the platform panned it. A panned visual viewport moves
 * the covered band down with it, which is why offsetTop is subtracted: without
 * it a sheet would be lifted by the keyboard's height instead of by how much of
 * it is actually covered. Where the browser does resize the layout viewport
 * (Chrome with resizes-content, or a browser that zooms), the two terms cancel
 * to zero and no second offset is applied.
 *
 * The value is in CSS pixels and is published on `:root`, so it lands before
 * the next paint (a custom property is not an animation: bottom and height are
 * layout properties, and keeps layout off the compositor). It is
 * rounded: sub-pixel keyboard heights would otherwise thrash the layout while
 * the keyboard animates in.
 *
 * Sources: CSS Viewport 1 §interactive-widget (drafts.csswg.org/css-viewport-1),
 * MDN VisualViewport (height, offsetTop) and the WebKit bug 259770 tracking
 * `interactive-widget` on iOS, where it is still unimplemented.
 */

const insetProperty = "--kb-inset";

/** The part of the layout viewport the on-screen keyboard covers, in CSS px. */
export function keyboardInset(): number {
  const viewport = window.visualViewport;
  // No API (older WebKit, test browsers): the CSS fallbacks stay at zero and
  // every surface keeps the geometry it had before the keyboard existed.
  if (!viewport) return 0;
  // A pinch-zoomed page shrinks the same numbers for a different reason. The
  // inset describes an overlay widget over an unscaled page, never a magnified
  // window, so a scaled visual viewport publishes nothing.
  if (viewport.scale > 1.001) return 0;
  const covered = window.innerHeight - viewport.height - viewport.offsetTop;
  return covered > 0 ? Math.round(covered) : 0;
}

/**
 * Follows the visual viewport for as long as the caller is mounted.
 *
 * Chrome fires `resize` when the keyboard opens, iOS also fires `scroll` while
 * it pans the visual viewport to the focused field, and both can fire many times
 * in a frame: the handler coalesces them into one write per animation frame, so
 * the layout is invalidated once per painted frame and never per event. The
 * cleanup removes the listeners and the property, which keeps a StrictMode
 * remount from stacking a second listener or leaving a stale inset behind.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    if (!viewport) return;
    let frame = 0;
    const publish = () => {
      frame = 0;
      root.style.setProperty(insetProperty, `${keyboardInset()}px`);
    };
    const schedule = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(publish);
    };
    publish();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    return () => {
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
      root.style.removeProperty(insetProperty);
    };
  }, []);
}

/**
 * Scrolls a focused field's own scroller just enough to clear the keyboard, and
 * never more: a field already in the clear is left exactly where the user's
 * scroll put it. `scrollIntoView` is not used because it also scrolls ancestors
 * -- the page behind a fixed sheet -- and it cannot be told to stop at the
 * keyboard's edge.
 */
export function revealFocusedField(scroller: HTMLElement, field: HTMLElement): void {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const visibleBottom = viewport.offsetTop + viewport.height;
  const overlap = field.getBoundingClientRect().bottom - visibleBottom;
  if (overlap <= 0) return;
  // +8: the field clears the keyboard's edge instead of sitting on it.
  scroller.scrollTop += overlap + 8;
}

/**
 * Keeps whatever holds focus inside `container` clear of the keyboard for as long
 * as the caller is mounted, and returns the undo.
 *
 * Two triggers, because the platform has two sequences. A focus while the
 * keyboard is already up is the small one. The common one on iOS is the other:
 * focus first, then the visual viewport shrinks a beat later as the keyboard
 * animates in, with no second focus event to react to -- so the sheet, resized
 * for the band that has just got smaller, must re-reveal the field it already
 * holds. That second case is watched on the sheet's own box rather than on the
 * viewport event: a ResizeObserver runs after layout, so it reads the geometry
 * the new inset produced, whatever order the variable and the listeners landed
 * in. Both runs are no-ops while the field is in the clear, so this never fights
 * a scroll the user started.
 */
export function keepFocusedFieldVisible(container: HTMLElement): () => void {
  const reveal = () => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !container.contains(active)) return;
    revealFocusedField(container, active);
  };
  container.addEventListener("focusin", reveal);
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reveal);
  observer?.observe(container);
  return () => {
    container.removeEventListener("focusin", reveal);
    observer?.disconnect();
  };
}

/**
 * True while an on-screen keyboard covers a real part of the page.
 *
 * Read from the same measurement the sheets size themselves against
 * (this file), so "the keyboard is up" means here exactly what it means
 * to the panel this line sits in. The listener is coalesced by the browser's
 * own viewport events; the value only flips when a keyboard opens or closes.
 */
export function useKeyboardUp(): boolean {
  const [up, setUp] = useState(() => keyboardInset() > 0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setUp(keyboardInset() > 0);
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return up;
}
