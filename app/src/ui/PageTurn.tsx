import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { animate } from "motion/react";
import { dur, easeOut, spring, useMediaQuery } from "./motion.ts";
import {
  activateDistance,
  draggedOffset,
  isEdgeGuarded,
  pageTurnDecision,
  pointerVelocity,
  turnProgress,
  type PointerSample,
} from "./pageTurn.ts";
import "./PageTurn.css";

/**
 * Closing the day by turning the page (distinctive roadmap F3, "The page-turn
 * gesture"): a left drag on Today carries the day off like a leaf of a book,
 * and the next day waits beneath it.
 *
 * One gesture, three inputs: Pointer Events cover mouse, pen and touch, so the
 * page follows the finger 1:1 (a direct transform write per move, no
 * re-render), and only `transform` and `opacity` ever move. Vertical scrolling
 * is the browser's (`touch-action: pan-y`), a control keeps its own press, and
 * a vertical drag abandons the gesture -- the page is never a scroll trap.
 *
 * Releasing asks ui/pageTurn.ts. A commit runs the page off on `spring.smooth`
 * and then hands the turn to `onTurn`, which owns what turning the day means
 * (F3c: the shutdown roll). Returning `false`, or throwing, means the turn did
 * not happen and the page springs back on `spring.snappy`: the animation is
 * never the gate, the write is.
 *
 * Reduced motion keeps the gesture and drops the travel: no page follows the
 * finger, a release is a 150 ms opacity shutter, and a cancel is instant.
 */

/** A running animation on the page, as this component uses it. */
type Flight = { stop: () => void; finished: Promise<unknown> };

/** What `onTurn` answers. `false` means the turn did not happen: spring back. */
export type TurnOutcome = boolean | void;

/** The page where a turn starts and where a cancel ends. */
const restTransform = "translate3d(0px, 0px, 0px)";
/** A throw hands its speed to the spring, capped so a hard flick cannot fling
 *  the page past the edge and back. */
const maxThrowVelocity = 1500;
const underRest = { transform: "scale(0.96)", opacity: 0.6 } as const;
const underLanded = { transform: "scale(1)", opacity: 1 } as const;

/** The page beneath at `progress`: it comes up from 96% and 60% opacity. */
const underAt = (progress: number) => ({
  transform: `scale(${0.96 + 0.04 * progress})`,
  opacity: 0.6 + 0.4 * progress,
});

/** The lifted page's shadow, 0..1 of its 35% ceiling, read by PageTurn.css. */
const progressOf = (dx: number, width: number) => String(turnProgress(dx, width));

/**
 * The press that may become a drag. `base` is where the page already is when
 * the press lands (a settling page is grabbed where it stopped, not at rest).
 */
type Candidate = {
  pointerId: number;
  startX: number;
  startY: number;
  base: number;
  active: boolean;
  samples: PointerSample[];
};

/**
 * Presses that belong to something else: the page's own controls, and anything
 * a caller marks `data-no-page-turn` (a block, a dragged row). The gesture is
 * for the page, never for the things on it.
 */
const controlSelector = "button, a, input, select, textarea, label, [role='button'], [role='checkbox'], [role='switch'], [contenteditable], [data-no-page-turn]";

function ownsPress(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(controlSelector) !== null;
}

/** Where a page element currently is, as read by a press that interrupts it. */
function translateXOf(element: HTMLElement): number {
  const { transform } = getComputedStyle(element);
  return transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
}

export function PageTurn({
  children,
  nextPage,
  onTurn,
  surfaceLabel,
  className,
}: {
  /** The page the user is on. */
  children: ReactNode;
  /** The page beneath it, revealed as the top one leaves. Omit when there is none yet. */
  nextPage?: ReactNode;
  /** What turning the day means. See the file header. */
  onTurn: () => TurnOutcome | Promise<TurnOutcome>;
  /** Names the page for assistive tech ("Today"), when the content does not. */
  surfaceLabel?: string;
  className?: string;
}) {
  const [phase, setPhase] = useState<"rest" | "drag" | "commit" | "cancel">("rest");
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const pageRef = useRef<HTMLDivElement | null>(null);
  const underRef = useRef<HTMLDivElement | null>(null);
  const flightRef = useRef<Flight | null>(null);
  const candidateRef = useRef<Candidate | null>(null);
  const liveRef = useRef(true);
  /** Which sequence owns the page: a grab or a new sequence abandons the last. */
  const runRef = useRef(0);

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      runRef.current += 1;
      flightRef.current?.stop();
    };
  }, []);

  /** Stops any flight in progress and reports where the page stopped. */
  const stopFlight = useCallback((): number => {
    runRef.current += 1;
    flightRef.current?.stop();
    flightRef.current = null;
    return pageRef.current ? translateXOf(pageRef.current) : 0;
  }, []);

  const ask = useCallback(async (): Promise<boolean> => {
    try {
      return (await onTurn()) !== false;
    } catch {
      return false;
    }
  }, [onTurn]);

  /** Puts the page back where it was: the cancel motion, and the one a refused turn gets. */
  const springBack = useCallback(
    async (run: number) => {
      const page = pageRef.current;
      const under = underRef.current;
      setPhase("cancel");
      if (reduced) {
        if (page) page.style.removeProperty("--page-turn-progress");
        setPhase("rest");
        return;
      }
      const flights: Promise<unknown>[] = [];
      if (page) {
        const flight: Flight = animate(page, { transform: restTransform }, spring.snappy);
        flightRef.current = flight;
        flights.push(flight.finished.catch(() => undefined));
      }
      if (under) flights.push(animate(under, underRest, spring.snappy).finished.catch(() => undefined));
      await Promise.all(flights);
      if (run !== runRef.current || !liveRef.current) return;
      flightRef.current = null;
      page?.style.removeProperty("--page-turn-progress");
      setPhase("rest");
    },
    [reduced],
  );

  /** Runs the page off, then asks what turning it means. */
  const commit = useCallback(
    async (run: number, velocity: number) => {
      const page = pageRef.current;
      const under = underRef.current;
      const width = page?.offsetWidth ?? 0;
      setPhase("commit");

      if (reduced) {
        // Gentler, not zero: a 150 ms shutter on opacity, no travel at all.
        if (page) {
          const shutter: Flight = animate(page, { opacity: 0.15 }, { duration: dur.pop, ease: easeOut });
          flightRef.current = shutter;
          await shutter.finished.catch(() => undefined);
        }
        if (run !== runRef.current || !liveRef.current) return;
        const turned = await ask();
        if (run !== runRef.current || !liveRef.current) return;
        if (page) {
          const back: Flight = animate(page, { opacity: 1 }, { duration: dur.pop, ease: easeOut });
          flightRef.current = back;
          await back.finished.catch(() => undefined);
        }
        flightRef.current = null;
        if (run !== runRef.current || !liveRef.current) return;
        if (turned) return setPhase("commit");
        setPhase("rest");
        return;
      }

      if (page) {
        // The page keeps the speed it was thrown with, so a flick lands before
        // a drag of the same distance would.
        const transition =
          velocity < 0
            ? { ...spring.smooth, velocity: Math.max(-maxThrowVelocity, velocity * 1000) }
            : spring.smooth;
        const flight: Flight = animate(page, { transform: `translate3d(${-width}px, 0px, 0px)` }, transition);
        flightRef.current = flight;
        if (under) animate(under, underLanded, spring.smooth);
        await flight.finished.catch(() => undefined);
        flightRef.current = null;
      }
      if (run !== runRef.current || !liveRef.current) return;

      const turned = await ask();
      if (run !== runRef.current || !liveRef.current) return;
      // The write outranks the animation: a refused turn never leaves the day off-screen.
      if (!turned) return void springBack(run);
      page?.style.removeProperty("--page-turn-progress");
      setPhase("commit");
    },
    [ask, reduced, springBack],
  );

  /** The drag itself: where the page sits, and the page beneath it. */
  const follow = useCallback((dx: number) => {
    const page = pageRef.current;
    if (page) {
      page.style.transform = `translate3d(${draggedOffset(dx)}px, 0px, 0px)`;
      page.style.setProperty("--page-turn-progress", progressOf(dx, page.offsetWidth));
    }
    const under = underRef.current;
    if (under) Object.assign(under.style, underAt(turnProgress(dx, page?.offsetWidth ?? 0)));
  }, []);

  const release = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary) return; // a second finger never joins a turn
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (candidateRef.current) return;
    if (ownsPress(event.target)) return;
    // The outer 16 px belong to the browser's back gesture, not to the page.
    if (isEdgeGuarded(event.clientX, window.innerWidth)) return;
    const base = stopFlight();
    candidateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      base,
      active: false,
      samples: [],
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const candidate = candidateRef.current;
    if (!candidate || candidate.pointerId !== event.pointerId) return;
    const dx = candidate.base + event.clientX - candidate.startX;
    const dy = event.clientY - candidate.startY;
    if (!candidate.active) {
      // Vertical first: the page scrolls, the gesture lets go.
      if (Math.abs(dy) >= activateDistance && Math.abs(dy) >= Math.abs(dx)) {
        candidateRef.current = null;
        return;
      }
      if (Math.abs(dx) < activateDistance || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
      candidate.active = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      // A press that slid into a horizontal drag may already have begun a text
      // selection; the page is the thing being dragged now.
      window.getSelection()?.removeAllRanges();
      setPhase("drag");
    }
    candidate.samples.push({ t: event.timeStamp, x: event.clientX });
    if (candidate.samples.length > 12) candidate.samples.shift();
    if (!reduced) follow(dx);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const candidate = candidateRef.current;
    if (!candidate || candidate.pointerId !== event.pointerId) return;
    candidateRef.current = null;
    release(event);
    if (!candidate.active) return;
    const page = pageRef.current;
    const dx = candidate.base + event.clientX - candidate.startX;
    const samples = [...candidate.samples, { t: event.timeStamp, x: event.clientX }];
    const velocity = pointerVelocity(samples, event.timeStamp);
    const run = ++runRef.current;
    const decision = pageTurnDecision({ dx, width: page?.offsetWidth ?? 0, velocity });
    if (decision === "commit") void commit(run, velocity);
    else void springBack(run);
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const candidate = candidateRef.current;
    if (!candidate || candidate.pointerId !== event.pointerId) return;
    candidateRef.current = null;
    release(event);
    if (!candidate.active) return;
    void springBack(++runRef.current);
  };

  return (
    <div
      className={`page-turn${className ? ` ${className}` : ""}`}
      data-page-turn-state={phase}
      data-page-turn-next={nextPage === undefined ? "false" : "true"}
      aria-label={surfaceLabel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {nextPage !== undefined && (
        // Pre-rendered and inert: nothing beneath the page answers a press or a
        // tab stop until the turn has committed.
        <div ref={underRef} className="page-turn-under" data-page-turn-under="" inert={phase !== "commit"} aria-hidden="true">
          {nextPage}
        </div>
      )}
      <div ref={pageRef} className="page-turn-top" data-page-turn-page="">
        {children}
      </div>
    </div>
  );
}
