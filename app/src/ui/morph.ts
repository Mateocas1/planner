import { flushSync } from "react-dom";

/**
 * The product's one shared element: a task row that grows into its details
 * panel, and shrinks back into the row when it closes. It runs on the native
 * same-document View Transition API rather than on Motion, because only the
 * browser can morph a snapshot's box without the panel being drawn at the
 * row's aspect ratio. The distortion is handled in CSS (app.css, "view
 * transition: row into panel") by keeping each snapshot at its own aspect and
 * cross-fading them around the geometry change.
 *
 * The whole lifetime of a transition lives here, so nothing else becomes a
 * second owner: the caller supplies a state update, and the Sheet that mounts
 * during that update asks where to put the shared name.
 */

/** The transition name shared by the row and the panel (a <custom-ident>). */
const NAME = "task-morph";

/** The scrim travels with the panel but never changes shape. */
const SCRIM = "sheet-scrim";

/** True while a `morph()` update is being committed: the panel about to mount
 * in this commit is the shared element's new side. */
let pending = false;

/** The panel on screen, so a close can name it before it unmounts. */
let panel: { sheet: HTMLElement; scrim: HTMLElement } | null = null;

let running: ViewTransition | null = null;

/** Bumped per transition: an older transition never releases a newer one's
 * names, which is what a fast open/close race would otherwise do. */
let generation = 0;

/** Every element a name was put on, cleared by the current transition's end. */
let named = new Set<HTMLElement>();

/** A transition in flight, from the panel's point of view. */
export type Morph = {
  /** Puts the shared name on the elements that morph. */
  shared: (...elements: Array<HTMLElement | null | undefined>) => void;
  /** Puts the scrim's own name on elements that only fade. */
  scrim: (...elements: Array<HTMLElement | null | undefined>) => void;
};

function nameAll(name: string, elements: Array<HTMLElement | null | undefined>) {
  for (const element of elements) {
    if (!element) continue;
    element.style.setProperty("view-transition-name", name);
    named.add(element);
  }
}

/** An empty box over the row a closing panel returns to. The row stays in the
 * page -- it is in the list in both states and cannot own the shared name, or
 * two elements would carry it -- so the transition borrows its rectangle
 * instead: the group shrinks onto it and the row keeps painting itself. */
function destination(row: HTMLElement | null | undefined): HTMLElement | null {
  if (!row?.isConnected) return null;
  const rect = row.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const marker = document.createElement("div");
  marker.dataset.morphMarker = "";
  marker.setAttribute("aria-hidden", "true");
  marker.style.cssText = `position:fixed;pointer-events:none;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
  return marker;
}

const naming: Morph = {
  shared: (...elements) => nameAll(NAME, elements),
  scrim: (...elements) => nameAll(SCRIM, elements),
};

/**
 * Whether this environment can morph. Reduced motion is a hard no: the panel
 * then keeps the plain Motion entry from Sheet, which is a fade, not a flight
 * across the screen.
 */
export function morphAvailable(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.startViewTransition === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Registers the panel on screen; returns the function that clears it. */
export function registerPanel(sheet: HTMLElement | null, scrim: HTMLElement | null): () => void {
  panel = sheet && scrim ? { sheet, scrim } : null;
  const registered = panel;
  return () => {
    if (panel === registered) panel = null;
  };
}

/** The morph whose update is committing right now, or null for an ordinary
 * mount. The Sheet asks once, on mount. */
export function currentMorph(): Morph | null {
  if (!pending) return null;
  pending = false;
  return naming;
}

/**
 * Runs `update` inside a native view transition. `from` owns the shared name
 * in the state being left behind; whatever mounts during `update` claims the
 * other side through `currentMorph()`, and `to` names an element that is only
 * discovered after the commit (the row a closing panel returns to).
 *
 * Returns false when the API is missing or motion is reduced; the update still
 * runs, so the fallback is the plain Motion path in Sheet, never a behaviour
 * change.
 */
export function morph(
  update: () => void,
  {
    from,
    to,
    scrim,
    direction = "in",
  }: {
    /** Owns the shared name while the old state is captured. */
    from?: HTMLElement | null;
    /** Owns it once the update has landed (the row a panel returns to). */
    to?: () => HTMLElement | null;
    /** The scrim of the state being left behind, if it is leaving. */
    scrim?: HTMLElement | null;
    direction?: "in" | "out";
  } = {},
): boolean {
  if (!morphAvailable()) {
    update();
    return false;
  }
  // Interruption: a transition still in flight is finished now, so two
  // snapshot layers never stack when the user opens another task or closes
  // this one before it lands.
  running?.skipTransition();
  running = null;
  // A destination marker from a superseded transition cannot clean itself up.
  for (const stale of document.querySelectorAll("[data-morph-marker]")) stale.remove();

  const mine = ++generation;
  const root = document.documentElement;
  /** Names are only read while the snapshots are taken. A destination marker
   * is left alone until the transition is over: taking the element away while
   * the browser still points at it ends the animation early. */
  const unname = (drop: boolean) => {
    for (const element of named) {
      if ("morphMarker" in element.dataset) {
        if (drop) element.remove();
        continue;
      }
      element.style.removeProperty("view-transition-name");
    }
  };

  root.dataset.morph = direction;
  pending = true;
  // The row is still on screen in the new state too, so its name is handed
  // over, never shared: two elements with one name aborts the transition.
  const oldSide = new Set<HTMLElement>();
  if (from) {
    naming.shared(from);
    oldSide.add(from);
  }
  if (scrim) {
    naming.scrim(scrim);
    oldSide.add(scrim);
  }

  const transition = document.startViewTransition(() => {
    for (const element of oldSide) element.style.removeProperty("view-transition-name");
    oldSide.clear();
    flushSync(update);
    const landed = to?.();
    if (landed) naming.shared(landed);
    // The panel that mounted in this commit has claimed the name by now. A
    // stale callback (an open a close already superseded) must not clear the
    // claim of the transition that replaced it.
    if (mine === generation) pending = false;
  });
  running = transition;

  // The names go as soon as the snapshots exist, so a later ordinary mount
  // cannot inherit one. The direction stays for the whole animation: it is what
  // tells the pseudo tree which side fades (CSS cannot see a data attribute on
  // :root from inside the view-transition tree, it only inherits properties).
  const settle = () => {
    if (mine !== generation) return;
    unname(false);
    if (running === transition) running = null;
  };
  const end = () => {
    if (mine !== generation) return;
    unname(true);
    named.clear();
    delete root.dataset.morph;
  };
  transition.ready.then(settle, settle);
  transition.finished.then(end, end);
  return true;
}

/** Opens a panel from the row that was clicked. */
export function morphOpen(update: () => void, row: HTMLElement | null): void {
  morph(update, { from: row, direction: "in" });
}

/** Closes the panel on screen back into the row it came from. */
export function morphClose(update: () => void, row: HTMLElement | null | undefined): void {
  if (!panel?.sheet) {
    // No panel to shrink: the sheet's own exit is the whole animation.
    update();
    return;
  }
  const to = destination(row);
  morph(update, {
    from: panel?.sheet,
    // The scrim is not in the new state, so its old snapshot is all it has:
    // naming it lets it fade out under the panel instead of vanishing.
    scrim: panel?.scrim,
    to: () => {
      if (!to) return null;
      document.body.append(to);
      return to;
    },
    direction: "out",
  });
}
