/**
 * Glass lens gate (glass-direction §2 refraction, §5 G5).
 *
 * The lens is a `feDisplacementMap` (`#glass-lens`, defined in index.html) used
 * as a `backdrop-filter` on the floating compose button — the one `.fab.glass-lens`
 * host, rendered only at phone widths (App.tsx). The tab and nav pills never
 * carry it: they sit inside `.glass` chrome, a backdrop root, so the map would
 * sample an already-flat surface and never be perceptible (glass.css). It is a
 * delight layer on a Chromium-only rendering path, so it ships under a gate
 * rather than as a fallback we have to detect in CSS:
 *
 * - Blink only. Gecko and WebKit get the thin blur they already have.
 * - Fine pointer with hover. A phone never pays for a filter it cannot see follow.
 * - No reduced motion, no reduced transparency, no data saver.
 * - Wide viewport only: the filter is off at phone widths (≤ 390px). With the
 *   FAB capped at 760px, both conditions hold only in the 391–760px window.
 *
 * The predicate is pure so the whole matrix is tested without simulating engines.
 */

const WIDE = "(min-width: 391px)";
const FINE_POINTER = "(hover: hover) and (pointer: fine)";
const CALM = "(prefers-reduced-motion: reduce)";
const CLEAR = "(prefers-reduced-transparency: reduce)";
const FILTER = "url(#glass-lens)";

export type LensEnv = {
  /** Blink-based browser: the only engine that renders the displacement map. */
  blink: boolean;
  /** The browser accepts a `url()` filter in `backdrop-filter`. */
  displacement: boolean;
  hoverFine: boolean;
  calm: boolean;
  clear: boolean;
  saveData: boolean;
  wide: boolean;
};

/** True only when every condition for the lens holds. */
export function shouldEnableLens(env: LensEnv): boolean {
  return (
    env.blink &&
    env.displacement &&
    env.hoverFine &&
    !env.calm &&
    !env.clear &&
    !env.saveData &&
    env.wide
  );
}

/** Blink detection by engine, not by product name: every Chromium browser
 * carries `Chrome/` in its UA string, Safari and Firefox never do. */
export function isBlink(userAgent: string): boolean {
  return /(Chrome|Chromium)\//.test(userAgent) && !/Firefox|FxiOS/.test(userAgent);
}

type Connection = EventTarget & { saveData?: boolean };

/** Sets `html[data-lens]` and keeps it in step with the media queries it reads.
 * Returns a disposer. */
export function installLens(doc: Document = document): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};

  const queries = [WIDE, FINE_POINTER, CALM, CLEAR].map((query) => view.matchMedia(query));
  const [wide, fine, calm, clear] = queries;
  const connection = (view.navigator as Navigator & { connection?: Connection }).connection;
  const blink = isBlink(view.navigator.userAgent);
  const displacement = view.CSS.supports("backdrop-filter", FILTER);

  const sync = () => {
    const enabled = shouldEnableLens({
      blink,
      displacement,
      hoverFine: fine.matches,
      calm: calm.matches,
      clear: clear.matches,
      saveData: connection?.saveData === true,
      wide: wide.matches,
    });
    doc.documentElement.toggleAttribute("data-lens", enabled);
  };

  for (const query of queries) query.addEventListener("change", sync);
  connection?.addEventListener("change", sync);
  sync();

  return () => {
    for (const query of queries) query.removeEventListener("change", sync);
    connection?.removeEventListener("change", sync);
    doc.documentElement.removeAttribute("data-lens");
  };
}
