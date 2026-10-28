import { useEffect, useRef, useState } from "react";
import type { BlockView, TaskView } from "../data/store.ts";
import { closeDay, undoCloseDay } from "../data/tasks.ts";
import {
  dayLeftovers,
  nextDayKey,
  planCloseDay,
  type ShutdownPlan,
  type ShutdownState,
} from "../planning/shutdown.ts";
import { type WorkWindow } from "../planning/window.ts";
import { t } from "../i18n/index.ts";
import { formatDateKey } from "./format.ts";
import { CloseIcon } from "./icons.tsx";
import { useMediaQuery } from "./motion.ts";
import { PageTurn } from "./PageTurn.tsx";
import { Sheet } from "./Sheet.tsx";
import {
  claimCloseDay,
  closeAnnouncement,
  closeFailedMessage,
  closeToastMessage,
  dayChangedMessage,
  firstFreeSlot,
  lateCloseFailure,
  leftoverSummary,
  minutesLabel,
  releaseCloseDay,
  turnHint,
  undoMessage,
  type UndoOutcome,
} from "./shutdownRitual.ts";
import { dateKey, formatWall, keyToWallUtc, wallMinutes } from "./time.ts";
import type { UndoableDelete } from "./UndoToast.tsx";
import { settle, settleTracked } from "./write.ts";
import "./ShutdownSheet.css";
import { capitalize } from "../i18n/capitalize.ts";

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
 *
 * Three rules keep the write honest, and none of them is the animation's job
 * (F3c review): the commit re-reads the clock, so a sheet left open past
 * midnight writes nothing; only one close of a day can be in flight, so a
 * reopened sheet cannot start a second batch; and a close the server rejects
 * after the local acceptance is taken back -- the page returns to Today, says
 * nothing changed, and the undo offer goes with it. The undo compares against
 * the state the *shell* holds at the moment it runs, which outlives this sheet.
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
  storedShutdown,
  weeklyOffer = false,
  onOpenWeeklyReview,
  origin,
  onClose,
  onOfferUndo,
  onWithdrawUndo,
  onProblem,
  getShutdownState,
}: {
  uid: string;
  tasks: TaskView[];
  blocks: BlockView[];
  timeZone: string;
  /** The profile's one working window, for tomorrow's first free slot (W1). */
  workWindow: WorkWindow;
  now: Date;
  /** `profile.storedLastShutdown` exactly as stored: the plan records it so the
   *  undo puts a hand-edited value back instead of deleting it (F3c item 6). */
  storedShutdown?: unknown;
  /** True while a weekly review moment is due (S3): the turned page then ends
   *  with "Close the week too?" — the shutdown chain takes the place of a
   *  second nudge on the day the day was closed. */
  weeklyOffer?: boolean;
  /** Opens the weekly review the chain offers; the sheet closes first, the
   *  shell navigates. */
  onOpenWeeklyReview?: () => void;
  origin: HTMLElement | null;
  onClose: () => void;
  /** The shell's single undo offer, and its withdrawal: the roll is undoable
   *  from wherever it ran, and a rejected roll must stop offering. */
  onOfferUndo: (item: UndoableDelete) => number;
  onWithdrawUndo: (id: number) => void;
  /** Where a failure goes once this sheet is off screen: the shell's toast. */
  onProblem: (message: string) => void;
  /** The state the app holds now -- the store's tasks and the profile's raw
   *  stamp at the moment Undo runs, never the render that offered it. */
  getShutdownState: () => ShutdownState;
}) {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  /* A phone reports a coarse pointer, and a touchscreen that also has a mouse
     reports fine: the hint names the gesture that works on the device in hand,
     so a device that can be touched gets the thumb's sentence. */
  const touch = useMediaQuery("(pointer: coarse)") || navigator.maxTouchPoints > 0;
  /* The day this sheet is about. It is state, not a value read at every render:
     the commit re-reads the clock and moves it forward when midnight has passed
     (see commit), because a page that silently swapped days under an open sheet
     would be the same bug it is guarding against. */
  const [today, setToday] = useState(() => dateKey(now, timeZone));
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
  /* These two outlive the sheet, because the offer they describe does: the id of
     the offer this close made (so a rejected batch can withdraw exactly it) and
     whether the close's own batch was rejected -- a rejection is not a later
     close, and must never be reported as one. */
  const offeredUndo = useRef<number | null>(null);
  const rejected = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

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
    /* The day is the day at the commit, never the day the sheet was mounted
       with: past midnight, closing what is on screen would stamp yesterday.
       Nothing is written; the sheet re-reads the day and shows it instead. */
    const currentDay = dateKey(new Date(), timeZone);
    if (currentDay !== today) {
      setToday(currentDay);
      setError(dayChangedMessage());
      return false;
    }
    /* One close per owner and day, across sheet instances: a sheet reopened
       while a batch is pending cannot start a second one. The claim is released
       once the write is accepted locally, which is the window it guards. */
    if (!claimCloseDay(uid, today)) return false;
    committing.current = true;
    // A rejected close is history once a new one starts: this attempt's undo
    // must not inherit the previous attempt's failure.
    rejected.current = false;
    offeredUndo.current = null;
    setError(null);
    try {
      const plan = planCloseDay({ tasks, blocks, today, timeZone, lastShutdown: storedShutdown });
      // A day closed on another device writes nothing and is already tomorrow's
      // starting point: the turn has nothing to roll, so it simply lands.
      if (plan.alreadyClosed) {
        await land();
        setAnnouncement(closeAnnouncement({ moved: 0, tomorrowKey: tomorrow }));
        setTurned(true);
        return true;
      }
      if (plan.refused !== undefined) {
        setError(closeFailedMessage());
        return false;
      }
      /* `settleTracked` accepts the close as soon as Firestore queues it
         locally, so a close works offline, and hands back the server's later
         rejection: a validation rejection still arrives before the turn lands
         and is thrown here.

         A rejection after that point means the day was never closed, so the
         page must come home and the offer to undo it must go -- at once, and
         from wherever the user is by then. */
      const write = settleTracked(closeDay(uid, plan));
      await write.accepted;
      await land();
      setTurned(true);
      setAnnouncement(closeAnnouncement({ moved: plan.moves.length, tomorrowKey: tomorrow }));
      offeredUndo.current = onOfferUndo({ message: closeToastMessage(), restore: () => reopen(plan) });
      void write.late.then(() => retract());
      return true;
    } catch {
      setError(closeFailedMessage());
      return false;
    } finally {
      committing.current = false;
      releaseCloseDay(uid, today);
    }
  }

  /** Lets the page's flight finish before the content it revealed replaces it. */
  function land(): Promise<void> {
    if (reduced) return Promise.resolve();
    return new Promise(resolve => window.setTimeout(resolve, turnLandingMs));
  }

  /**
   * The server rejected the close this sheet had already announced: the day is
   * not closed, so the page returns to Today with the failed close's sentence
   * and the undo offer is withdrawn. The offer promised to revert a batch that
   * never landed, and reporting a later close would describe a write nobody
   * made. This runs after the sheet may be gone, which is why the withdrawal is
   * the shell's.
   */
  function retract(): void {
    const failure = lateCloseFailure();
    rejected.current = true;
    if (failure.withdrawUndo && offeredUndo.current !== null) {
      onWithdrawUndo(offeredUndo.current);
      offeredUndo.current = null;
    }
    setAnnouncement("");
    setTurned(false);
    report(failure.message);
  }

  /** Says what went wrong where it is still visible: this sheet's own line while
   *  it is on screen, the shell's toast once the offer has outlived it. */
  function report(message: string | null): void {
    setError(message);
    if (message !== null && !alive.current) onProblem(message);
  }

  /**
   * Criterion 4's undo: the exact inverse, checked against the state the app
   * holds now (`data/tasks.ts undoCloseDay`, `getShutdownState`). A refusal and
   * a write the server rejected both say so instead of silently returning to
   * Today, and the sheet goes back to Today either way.
   */
  async function reopen(plan: ShutdownPlan): Promise<void> {
    let outcome: UndoOutcome = { kind: "unsaved" };
    try {
      const undo = undoCloseDay(uid, plan, getShutdownState());
      await settle(undo);
      // A write accepted locally and rejected by the server: nothing was undone.
      const result = await undo.catch(() => undefined);
      outcome = rejected.current
        ? { kind: "rejected" }
        : result === undefined
          ? { kind: "unsaved" }
          : result.refused === undefined
            ? { kind: "reverted" }
            : { kind: "refused", refusal: result.refused };
    } catch {
      outcome = { kind: "unsaved" };
    }
    report(undoMessage(outcome));
    setAnnouncement("");
    setTurned(false);
  }

  const tomorrowDate = capitalize(formatWall(keyToWallUtc(tomorrow), { weekday: "long", month: "long", day: "numeric" }));

  const tomorrowPage = (
    <div className="shutdown-page shutdown-tomorrow">
      <header className="shutdown-head">
        <div>
          {/* The turn lands here: the heading is what the eye and the screen
              reader are given after the commit (F3, "Screen reader"). */}
          <h2 id="shutdown-tomorrow" ref={heading} tabIndex={-1} className="shutdown-kind">{t("shutdown.tomorrow")}</h2>
          <p className="shutdown-date">{tomorrowDate}</p>
        </div>
        <button type="button" className="icon-button" aria-label={t("shutdown.cancel")} onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      {tomorrowBlocks.length === 0 ? (
        <p className="shutdown-empty">{t("shutdown.nothingPlanned")}</p>
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
      {tomorrowFree === undefined ? null : <p className="shutdown-note">{t("shutdown.firstFree", { time: minutesLabel(tomorrowFree) })}</p>}
    </div>
  );

  function blockName(block: BlockView): string {
    if (block.taskId === undefined) return t("shutdown.workBlock");
    return tasks.find(task => task.id === block.taskId)?.title ?? t("shutdown.workBlock");
  }

  return (
    <Sheet label={t("shutdown.sheetLabel")} className="shutdown-sheet" origin={origin} onClose={onClose}>
      {turned ? (
        tomorrowPage
      ) : (
        <PageTurn className="shutdown-turn" onTurn={commit} nextPage={tomorrowPage}>
          <div className="shutdown-page">
            <header className="shutdown-head">
              <div>
                <p className="shutdown-kind">{t("shutdown.today")}</p>
                <p className="shutdown-date">{capitalize(formatWall(keyToWallUtc(today), { weekday: "long", month: "long", day: "numeric" }))}</p>
              </div>
              <button type="button" className="icon-button" aria-label={t("shutdown.cancel")} onClick={onClose}>
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
                  <h3 id="shutdown-done" className="section-title">{t("shutdown.doneHeading")}</h3>
                  <span className="section-meta">{groups.done.length}</span>
                </div>
                {groups.done.length === 0 ? (
                  <p className="group group-empty">{t("shutdown.nothingDone")}</p>
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
                  <h3 id="shutdown-left" className="section-title">{t("shutdown.leftOverHeading")}</h3>
                  <span className="section-meta">{groups.leftOver.length}</span>
                </div>
                {groups.leftOver.length === 0 ? (
                  <p className="group group-empty">{t("shutdown.nothingLeft")}</p>
                ) : (
                  <ul className="group shutdown-list">
                    {groups.leftOver.map(task => (
                      <li key={task.id} className="row">
                        <span className="row-main">
                          <span className="row-title" title={task.title}>{task.title}</span>
                          <span className="row-meta">{task.deadline === undefined ? t("shutdown.noDeadline") : formatDateKey(task.deadline, today)}</span>
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
                {t("shutdown.closeDay")}
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
          {/* The week's chain (S3): on the day the review is due, the ritual
              offers it here — one door, not a second nudge waiting outside. */}
          {weeklyOffer && onOpenWeeklyReview !== undefined && (
            <button
              type="button"
              className="button-primary"
              onClick={onOpenWeeklyReview}
            >
              {t("shutdown.closeWeekToo")}
            </button>
          )}
          <button type="button" className="button" onClick={onClose}>{t("shutdown.doneButton")}</button>
        </div>
      )}
    </Sheet>
  );
}
