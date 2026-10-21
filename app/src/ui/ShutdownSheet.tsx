import { useEffect, useRef, useState } from "react";
import type { BlockView, TaskView } from "../data/store.ts";
import { closeDay, undoCloseDay } from "../data/tasks.ts";
import {
  dayLeftovers,
  nextDayKey,
  planCloseDay,
  type ShutdownPlan,
} from "../planning/shutdown.ts";
import { type WorkWindow } from "../planning/window.ts";
import { formatDateKey } from "./format.ts";
import { CloseIcon } from "./icons.tsx";
import { useMediaQuery } from "./motion.ts";
import { PageTurn } from "./PageTurn.tsx";
import { Sheet } from "./Sheet.tsx";
import {
  closeAnnouncement,
  closeFailedMessage,
  closeToastMessage,
  firstFreeSlot,
  leftoverSummary,
  minutesLabel,
  turnHint,
} from "./shutdownRitual.ts";
import { dateKey, formatWall, keyToWallUtc, wallMinutes } from "./time.ts";
import type { UndoableDelete } from "./UndoToast.tsx";
import { settle } from "./write.ts";
import "./ShutdownSheet.css";

/**
 * The shutdown ritual (distinctive roadmap F3, F3c): a sheet with two pages.
 *
 * The Today page counts what the day left behind -- the tasks completed today
 * and the ones still open that had a block today or are due today or overdue --
 * and the Tomorrow page is pre-rendered beneath it. Turning today to tomorrow
 * (`ui/PageTurn.tsx`, F3b) *is* the close: the write starts at the commit
 * moment, the animation only carries the page. A refused write springs the page
 * back and says so, because one `writeBatch` either lands whole or not at all.
 *
 * Nothing here decides what the roll is. `planning/shutdown.ts` computes the
 * deadline moves and the `lastShutdown` stamp, `data/tasks.ts` commits them as
 * one batch and undoes them against the state the app holds; this surface shows
 * the plan, commits it, announces it and offers the exact undo. That is why the
 * summary the user reads is exactly what the batch writes.
 *
 * Reduced motion keeps the gesture and drops the travel (PageTurn), and the
 * Tomorrow page arrives on an opacity fade instead of a page landing.
 */

/** How long the page's flight gets before the Tomorrow page replaces it, so the
 *  turn lands before the content it reveals is the content on screen. */
const turnLandingMs = 420;

export function ShutdownSheet({
  uid,
  tasks,
  blocks,
  timeZone,
  workWindow,
  now,
  lastShutdown,
  origin,
  onClose,
  onOfferUndo,
}: {
  uid: string;
  tasks: TaskView[];
  blocks: BlockView[];
  timeZone: string;
  /** The profile's one working window, for tomorrow's first free slot (W1). */
  workWindow: WorkWindow;
  now: Date;
  /** `profile.lastShutdown` as a day key: this day is already closed on some device. */
  lastShutdown?: string;
  origin: HTMLElement | null;
  onClose: () => void;
  /** The shell's single undo offer; the roll is undoable from wherever it ran. */
  onOfferUndo: (item: UndoableDelete) => void;
}) {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const touch = useMediaQuery("(pointer: coarse)");
  const today = dateKey(now, timeZone);
  const tomorrow = nextDayKey(today);
  const groups = dayLeftovers({ tasks, blocks, today, timeZone });
  const summary = leftoverSummary({ done: groups.done.length, leftOver: groups.leftOver.length });

  const tomorrowBlocks = blocks
    .filter(block => dateKey(new Date(block.start), timeZone) === tomorrow)
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
  const tomorrowFree = firstFreeSlot(
    tomorrowBlocks.map(block => {
      const startMinutes = wallMinutes(new Date(block.start), timeZone);
      const endMinutes = wallMinutes(new Date(block.end), timeZone);
      // A block that ends before it starts crossed midnight: tomorrow owns the
      // part before it, which is the rest of the working window.
      return { startMinutes, endMinutes: endMinutes <= startMinutes ? 1440 : endMinutes };
    }),
    workWindow,
    workWindow.startMinutes,
  );

  const [turned, setTurned] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);
  const committing = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  /* The undo runs after the close, from a callback the shell kept: it must read
     the state the app holds *then*, not the state of the render that offered it
     (the profile stamp it is checked against arrives with the close's own
     write). Refs, not the closed-over props, are what make the inverse exact. */
  const liveTasks = useRef(tasks);
  const liveStamp = useRef(lastShutdown);
  liveTasks.current = tasks;
  liveStamp.current = lastShutdown;

  // The page has been turned to tomorrow: the heading is where the eye (and a
  // screen reader) must be, not the page that just left.
  useEffect(() => {
    if (turned) heading.current?.focus();
  }, [turned]);

  /**
   * The close itself: compute the plan from the state on screen, commit it as
   * one batch, then announce it and offer the undo. Returns whether the turn
   * happened, which is what PageTurn uses to spring back.
   */
  async function commit(): Promise<boolean> {
    if (committing.current || turned) return false;
    committing.current = true;
    setError(null);
    try {
      const plan = planCloseDay({ tasks, blocks, today, timeZone, lastShutdown });
      // A day closed on another device writes nothing and is already tomorrow's
      // starting point: the turn has nothing to roll, so it simply lands.
      if (plan.alreadyClosed) {
        await land();
        setAnnouncement(closeAnnouncement({ moved: 0, tomorrowKey: tomorrow }));
        setTurned(true);
        return true;
      }
      if (plan.refused !== undefined) {
        setError(closeFailedMessage);
        return false;
      }
      // `settle` accepts the write as soon as Firestore queues it locally, so a
      // close works offline; a validation rejection still arrives before the
      // turn lands and is thrown here.
      await settle(closeDay(uid, plan));
      await land();
      setTurned(true);
      setAnnouncement(closeAnnouncement({ moved: plan.moves.length, tomorrowKey: tomorrow }));
      onOfferUndo({ message: closeToastMessage, restore: () => reopen(plan) });
      return true;
    } catch {
      setError(closeFailedMessage);
      return false;
    } finally {
      committing.current = false;
    }
  }

  /** Lets the page's flight finish before the content it revealed replaces it. */
  function land(): Promise<void> {
    if (reduced) return Promise.resolve();
    return new Promise(resolve => window.setTimeout(resolve, turnLandingMs));
  }

  /**
   * Criterion 4's undo: the exact inverse, checked against the state the app
   * holds now (`data/tasks.ts undoCloseDay`). A refused undo wrote nothing, so
   * the sheet goes back to today either way instead of claiming a revert it
   * could not make.
   */
  async function reopen(plan: ShutdownPlan): Promise<void> {
    try {
      const undo = undoCloseDay(uid, plan, { tasks: liveTasks.current, lastShutdown: liveStamp.current });
      await settle(undo);
      /* A refused undo wrote nothing: a later close owns the stamp, so this
         close's deadlines are not this close's to put back any more. */
      const result = await undo.catch(() => undefined);
      setError(result?.refused === "later-close" ? "The day was closed again, so nothing was undone." : null);
      setAnnouncement("");
      setTurned(false);
    } catch {
      setError("The undo could not be saved.");
    }
  }

  const tomorrowDate = formatWall(keyToWallUtc(tomorrow), { weekday: "long", month: "long", day: "numeric" });

  const tomorrowPage = (
    <div className="shutdown-page shutdown-tomorrow">
      <header className="shutdown-head">
        <div>
          {/* The turn lands here: the heading is what the eye and the screen
              reader are given after the commit (F3, "Screen reader"). */}
          <h2 id="shutdown-tomorrow" ref={heading} tabIndex={-1} className="shutdown-kind">Tomorrow</h2>
          <p className="shutdown-date">{tomorrowDate}</p>
        </div>
        <button type="button" className="icon-button" aria-label="Cancel" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      {tomorrowBlocks.length === 0 ? (
        <p className="shutdown-empty">Tomorrow. Nothing planned yet.</p>
      ) : (
        <ol className="group shutdown-list">
          {tomorrowBlocks.map(block => (
            <li key={block.id} className="row">
              <time className="shutdown-time">
                {minutesLabel(wallMinutes(new Date(block.start), timeZone))}
              </time>
              <span className="row-main">
                <span className="row-title" title={blockName(block)}>{blockName(block)}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {tomorrowFree === undefined ? null : <p className="shutdown-note">First free slot {minutesLabel(tomorrowFree)}.</p>}
    </div>
  );

  function blockName(block: BlockView): string {
    if (block.taskId === undefined) return "Work block";
    return tasks.find(task => task.id === block.taskId)?.title ?? "Work block";
  }

  return (
    <Sheet label="Close the day" className="shutdown-sheet" origin={origin} onClose={onClose}>
      {turned ? (
        tomorrowPage
      ) : (
        <PageTurn className="shutdown-turn" onTurn={commit} nextPage={tomorrowPage}>
          <div className="shutdown-page">
            <header className="shutdown-head">
              <div>
                <p className="shutdown-kind">Today</p>
                <p className="shutdown-date">{formatWall(keyToWallUtc(today), { weekday: "long", month: "long", day: "numeric" })}</p>
              </div>
              <button type="button" className="icon-button" aria-label="Cancel" onClick={onClose}>
                <CloseIcon />
              </button>
            </header>

            <p className="shutdown-summary">{summary}</p>

            {/* A refused close says nothing changed where the eye already is:
                above the two lists, not under them. */}
            {error && <p className="inline-error" role="alert">{error}</p>}

            <div className="shutdown-groups">
              <section className="list-section" aria-labelledby="shutdown-done">
                <div className="section-head">
                  <h3 id="shutdown-done" className="section-title">Done</h3>
                  <span className="section-meta">{groups.done.length}</span>
                </div>
                {groups.done.length === 0 ? (
                  <p className="group group-empty">Nothing done today.</p>
                ) : (
                  <ul className="group shutdown-list">
                    {groups.done.map(task => (
                      <li key={task.id} className="row">
                        <span className="row-main">
                          <span className="row-title" title={task.title}>{task.title}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="list-section" aria-labelledby="shutdown-left">
                <div className="section-head">
                  <h3 id="shutdown-left" className="section-title">Left over</h3>
                  <span className="section-meta">{groups.leftOver.length}</span>
                </div>
                {groups.leftOver.length === 0 ? (
                  <p className="group group-empty">Nothing left over.</p>
                ) : (
                  <ul className="group shutdown-list">
                    {groups.leftOver.map(task => (
                      <li key={task.id} className="row">
                        <span className="row-main">
                          <span className="row-title" title={task.title}>{task.title}</span>
                          <span className="row-meta">{task.deadline === undefined ? "No deadline" : formatDateKey(task.deadline, today)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <p className="shutdown-hint">{turnHint({ touch })}</p>

            <div className="shutdown-actions">
              <button type="button" className="button-primary" onClick={() => void commit()}>
                Close day
              </button>
            </div>

          </div>
        </PageTurn>
      )}
      {/* The result is announced once, outside the turning page: the page that
          carried the summary has just been turned away, and a live region that
          unmounts with it announces nothing. */}
      <p className="shutdown-live" role="status" aria-live="polite">{announcement}</p>
      {turned && (
        <div className="shutdown-actions">
          <button type="button" className="button" onClick={onClose}>Done</button>
        </div>
      )}
    </Sheet>
  );
}
