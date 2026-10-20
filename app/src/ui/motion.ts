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
 * Sheet tempos, in seconds for Motion. They extend the --dur-* ladder in app.css
 * past its interaction tokens: a surface appears in 150 ms, its content lands a
 * beat later, and a dismissal is gone in 180 ms. A sheet is opened a handful of
 * times an hour, so it sits at the fast end of the modal budget: the panel morph,
 * not the duration, is what makes it legible.
 */
export const dur = {
  pop: 0.15,
  enter: 0.16,
  exit: 0.18,
} as const;

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

/** The current instant, refreshed every 30 s so "now" lines and progress move. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
