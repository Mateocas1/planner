import { useEffect, useState } from "react";
import type { Transition } from "motion/react";

/**
 * The three springs from odd/design/DESIGN.md. Every animated state change in
 * the app uses one of these, so the product moves with one character:
 * critically damped by default, a little bounce only after a completion.
 */
export const spring = {
  snappy: { type: "spring", bounce: 0, duration: 0.25 },
  smooth: { type: "spring", bounce: 0, duration: 0.4 },
  lively: { type: "spring", bounce: 0.25, duration: 0.45 },
} satisfies Record<string, Transition>;

/** The strong ease-out used for fades and short tweens (CSS --ease-out). */
export const easeOut = [0.23, 1, 0.32, 1] as const;

/**
 * The same curve as `easeOut`, spelled for CSS and WAAPI, which take a string.
 * One curve in the product, one place to change it.
 */
export const easeOutCss = `cubic-bezier(${easeOut.join(", ")})`;

/**
 * The app's timing tokens, in seconds for Motion (WAAPI takes the same tokens
 * millisecond by millisecond through `ms` below). They extend the --dur-* ladder
 * in app.css past its interaction tokens: a page lands in 120 ms (the press
 * budget, nothing held back for an exit), a surface appears in 150 ms, its
 * content lands a beat later, its composited flight runs the modal budget, and
 * a dismissal is gone in 180 ms. A sheet is opened a handful of times an hour,
 * so the panel morph, not the duration, is what makes it legible.
 */
export const dur = {
  page: 0.12,
  pop: 0.15,
  enter: 0.16,
  exit: 0.18,
  flight: 0.4,
  /** The content's blur-to-sharp behind a landed panel: long enough to read as
   *  a focus pull, short enough that the field the panel focuses is crisp again
   *  before the user types (odd/research/melon-expand.md §b). */
  blur: 0.26,
  /** The user bubble's flight from the send button into its thread slot
   *  (Ronda 4 S3): a short spring that still settles inside the 300 ms UI
   *  budget. */
  sendFlight: 0.26,
} as const;

/**
 * easeOutBack (easings.co): the one overshoot curve in the product. WAAPI
 * cannot take a Motion spring, so the user bubble's send flight expresses its
 * short spring as this curve — the pill overshoots its slot by a hair and
 * settles.
 */
export const easeOutBackCss = "cubic-bezier(0.22, 1.2, 0.36, 1)";

/**
 * How far out of focus the content of a panel starts (in px), before the card
 * lands and the text sharpens. The card is close to the eye on a desktop and
 * held at arm's length on a phone -- and the phone is the low-end GPU -- so a
 * coarse pointer gets half the radius. It is never applied to the panel itself:
 * a filter on a backdrop-filter surface repaints the glass flat (Sheet.tsx).
 */
export const expandBlur = { fine: 8, coarse: 4 } as const;

/**
 * The press language (odd/tasks/ronda4.md S2), mirrored from the --press-*
 * tokens in ui/press.css -- the CSS side is authoritative; these constants
 * exist so JS/Motion code and tests can name the same values. A press sinks
 * instantly (`scale`, `downMs`) and releases through the damped
 * `--ease-press-spring` linear() curve with one small overshoot. Large
 * surfaces (rows, calendar blocks) sink to `scaleLarge` instead, and reduced
 * motion takes no transform at all.
 */
export const press = {
  scale: 0.96,
  scaleLarge: 0.99,
  downMs: 80,
  releaseMs: 420,
} as const;

/** The same token in milliseconds, which is what WAAPI's `duration` takes. */
export const ms = (seconds: number) => Math.round(seconds * 1000);

/** True while a media query matches; follows changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/**
 * The phone breakpoint shared by the shell and the calendar (DESIGN.md §3).
 *
 * Width alone was wrong for a phone held sideways: 844x390 is wider than a
 * tablet's portrait width, so it got the desktop sidebar — 244 px of a 390 px
 * screen, with the sign-out row scrolled out of a 370 px column
 * (odd/research/responsive-audit.md F4). A viewport that is both narrow and
 * short is a phone in landscape, and it gets the phone shell. The same string
 * is repeated in the four phone CSS blocks; media queries cannot share a
 * constant.
 */
export const phoneQuery = "(max-width: 760px), (max-width: 1024px) and (max-height: 480px)";

/**
 * The width a seven-column week needs to stay readable. A tablet is wide enough
 * for the desktop shell and far too narrow for seven day columns plus the 56 px
 * gutter: at 768 px each column is 55 px and its block titles truncate to
 * "Wo…" (odd/research/responsive-audit.md F1). Between the phone breakpoint and
 * this one the calendar opens on the day range instead -- the week is a tap
 * away, and a column that cannot hold a word is not a week.
 */
export const narrowQuery = "(max-width: 1000px)";

/** The current instant, refreshed every 30 s so "now" lines and progress move. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
