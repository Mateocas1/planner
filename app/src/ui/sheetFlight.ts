/**
 * The content blur of a creation sheet's flight, as a pure decision. Where the
 * compositor handoff is installed (WebKitGTK, compositorHandoff.ts) the filter
 * would run on the main thread behind the guard, one blurred repaint of the
 * body per frame, on top of the sheet's own backdrop blur. There the content
 * only fades, as the details morph already does for its snapshots (app.css,
 * audit-r7 R7-08); every other engine keeps the focus pull.
 */

/** Keyframes for the body's focus pull, or null when it should not animate a filter. */
export function bodyBlurFlight(radius: number, handoff: boolean): Keyframe[] | null {
  if (handoff || radius <= 0) return null;
  return [{ filter: `blur(${radius}px)` }, { filter: "blur(0px)" }];
}

/** Whether the root carries the marker compositorHandoff.ts sets while installed. */
export const handoffActive = (root: Pick<Element, "hasAttribute">): boolean =>
  root.hasAttribute("data-compositor-handoff");
