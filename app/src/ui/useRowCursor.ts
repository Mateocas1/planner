import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { rowCursorSelector, shortcutEvent, type SurfaceAction } from "./shortcuts.ts";

/**
 * The row cursor (distinctive roadmap F6): `j` and `k` walk a surface's rows by
 * moving real DOM focus to each row's own control, so assistive tech announces
 * the row the cursor is on and every native affordance (Enter, space, the tab
 * order) keeps working.
 *
 * The list keeps one tab stop, not one per row (roving tabindex): the control
 * under the cursor carries `tabindex="0"` and the others are taken out of the
 * tab order by their own renderer, which reads `activeId` through
 * `shortcuts.ts`'s `rovingTabIndex`. Moving the cursor never scrolls the page
 * itself: `focus()` brings the row into view inside whichever scroller owns it.
 *
 * The scope is the surface's own container, so two surfaces can never fight
 * over the same event; only the mounted view answers.
 *
 * The listener is a layout effect on purpose: a surface is painted the moment
 * its markup is, so a key pressed on it must find it already listening. A
 * passive effect lands after that paint, and the shell publishes a shortcut
 * synchronously from the key press -- a `j` on a view that has just been
 * switched to used to fall into that gap.
 */
export function useRowCursor(scope: RefObject<HTMLElement | null>) {
  const [activeId, setActiveId] = useState<string | null>(null);

  useLayoutEffect(() => {
    const move = (step: 1 | -1) => {
      const rows = Array.from(scope.current?.querySelectorAll<HTMLElement>(rowCursorSelector) ?? []).filter(
        row => row.getClientRects().length > 0 && !(row as HTMLButtonElement).disabled,
      );
      if (rows.length === 0) return;
      // Nothing focused yet means "before the first row", so the first press
      // lands there; past either end the cursor stays put instead of wrapping.
      const current = indexOfFocus(rows);
      const target = rows[Math.min(rows.length - 1, Math.max(0, current + step))];
      if (target === undefined) return;
      target.focus();
      setActiveId(target.dataset.rowCursor ?? null);
    };
    const onAction = (event: Event) => {
      const action = (event as CustomEvent<SurfaceAction>).detail;
      if (action === "next") move(1);
      else if (action === "previous") move(-1);
    };
    window.addEventListener(shortcutEvent, onAction);
    return () => window.removeEventListener(shortcutEvent, onAction);
  }, [scope]);

  /* A row reached by pointer or by Tab is the cursor's new position too, so the
     single tab stop follows the caret instead of staying on the first row. */
  const onRowFocus = useCallback((id: string) => setActiveId(id), []);

  return { activeId, onRowFocus };
}

/**
 * Runs the actions the shell publishes for the surface that owns the focused
 * row. The handler is read from a ref, so a re-render never leaves a stale
 * listener and a listener never has to be re-registered to see new state.
 *
 * Subscribing is a layout effect for the same reason the cursor's is: the
 * shell publishes from the key press, and a surface that is on screen has to
 * be listening already. Measured under load, the passive effect landed ~70 ms
 * after the paint, and a `b` pressed in that window opened nothing.
 */
export function useSurfaceShortcuts(handler: (action: SurfaceAction) => void) {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  }, [handler]);
  useLayoutEffect(() => {
    const listener = (event: Event) => latest.current((event as CustomEvent<SurfaceAction>).detail);
    window.addEventListener(shortcutEvent, listener);
    return () => window.removeEventListener(shortcutEvent, listener);
  }, []);
}

/**
 * Which row the caret is on. A row holds several controls (a check, its title,
 * a drag grip), so focus anywhere inside the row counts as focus on that row.
 */
function indexOfFocus(rows: readonly HTMLElement[]): number {
  const active = document.activeElement;
  if (active === null) return -1;
  const direct = rows.indexOf(active as HTMLElement);
  if (direct !== -1) return direct;
  const owner = active.closest("[data-task-id], [data-series-id], [data-block]");
  return owner === null ? -1 : rows.findIndex(row => owner.contains(row));
}
