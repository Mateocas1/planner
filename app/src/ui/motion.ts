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

/** The phone breakpoint shared by the shell and the calendar (DESIGN.md §3). */
export const phoneQuery = "(max-width: 760px)";

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
