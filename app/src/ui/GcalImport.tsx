import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "../desktop.ts";
import { removeImported, writeImportPlan } from "../data/gcal.ts";
import { cleanupHolidayTasks, removeHolidays } from "../data/holidays.ts";
import {
  eventWindow,
  googleMessages,
  listCalendars,
  listEvents,
  loadGis,
  requestToken,
  cancelSignIn,
  keepTokenIfLive,
  revokeToken,
  truncatedNote,
  type EventList,
  type GcalCalendar,
} from "../data/google-client.ts";
import type { BlockView, TaskView } from "../data/store.ts";
import type { Holiday } from "../domain/holidays.ts";
import {
  importDocId,
  importedIds,
  planHolidayCleanup,
  planImport,
  selectHolidayTasks,
  type GcalEvent,
  type ImportPlan,
  type ImportSkipReason,
  type ImportSkips,
} from "../domain/gcalImport.ts";
import { CloseIcon } from "./icons.tsx";
import { Sheet } from "./Sheet.tsx";
import { useOnline } from "./SyncStatus.tsx";
import { dateKey } from "./time.ts";
import type { UndoableDelete } from "./UndoToast.tsx";
import "./GcalImport.css";

/**
 * The import from Google Calendar (value roadmap §1 and §5 row 4b).
 *
 * The sheet is a preview, not a wizard: one screen states what the chosen
 * calendars and range would create, counts what the mapper will skip and why,
 * and only then writes. Everything it shows comes from `domain/gcalImport.ts`,
 * which is also what `data/gcal.ts` writes, so the numbers on this screen are
 * the documents that land -- the UI never maps an event itself.
 *
 * The token lives in this component's state and nowhere else: never in
 * localStorage, never in Firestore. Closing the sheet drops it and revokes it at
 * Google, and the next open asks Google again. That is the token model (no
 * server, no refresh token), not an oversight.
 *
 * The GIS script is warmed when the sheet mounts, not when Connect is pressed,
 * so the token request happens inside the click's user gesture even on a cold
 * cache; a load that hangs is abandoned with a sentence (see data/google-client).
 *
 * Motion is the sheet's own (ui/Sheet.tsx): the panel grows out of the entry the
 * user pressed and returns to it, the content fades and sharpens once, and
 * nothing here animates a count or a row. A preview that is being read must not
 * move.
 */

/** The ranges the sheet offers, in days from today. 90 is the roadmap default. */
const ranges = [30, 90, 180] as const;
type Range = (typeof ranges)[number];

type Phase = "idle" | "connecting" | "loading" | "preview";

/** One line of feedback: an error, or the result of a removal. */
type Notice = { tone: "error" | "ok"; text: string };

/** How each skip bucket reads in the sheet. The mapper's names are internal. */
const skipLabels: Record<ImportSkipReason, string> = {
  cancelled: "cancelled",
  declined: "declined",
  workingLocation: "working location",
  outOfOffice: "out of office",
  focusTime: "focus time",
  imported: "already imported",
  unusable: "unusable",
};

function plural(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

/** "2 work blocks and 1 task", or the one noun when the other count is zero.
 * Holiday labels come last and only when there are some. */
function itemsSentence(blocks: number, tasks: number, holidays = 0): string {
  const parts = [
    ...(blocks === 0 ? [] : [plural(blocks, "work block")]),
    ...(tasks === 0 ? [] : [plural(tasks, "task")]),
    ...(holidays === 0 ? [] : [plural(holidays, "holiday label")]),
  ];
  return parts.length <= 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** What the import button is about to do, in one sentence. */
function previewSentence(blocks: number, tasks: number, holidays: number): string {
  const items = itemsSentence(blocks, tasks, holidays);
  return items === "" ? "Nothing new to import." : `${items} to import`;
}

/** The skipped buckets as one quiet line, biggest reasons first (by the order
 * the mapper declares them, which is the order a person reads them). */
function skippedSentence(skips: ImportSkips): string {
  const parts = (Object.keys(skipLabels) as ImportSkipReason[])
    .filter(reason => skips[reason] > 0)
    .map(reason => `${skips[reason]} ${skipLabels[reason]}`);
  return parts.length === 0 ? "" : `Skipped: ${parts.join(", ")}.`;
}

/** The toast sentence after a successful import. */
export function importedMessage(counts: { blocks: number; tasks: number; holidays?: number }): string {
  return `Imported ${itemsSentence(counts.blocks, counts.tasks, counts.holidays ?? 0)}`;
}

function removedMessage(counts: { blocks: number; tasks: number }): string {
  const items = itemsSentence(counts.blocks, counts.tasks);
  return items === "" ? "There was nothing imported to remove." : `Removed ${items}.`;
}

function emptySkips(): ImportSkips {
  return { cancelled: 0, declined: 0, workingLocation: 0, outOfOffice: 0, focusTime: 0, imported: 0, unusable: 0 };
}

export function GcalImportSheet({
  uid,
  blocks,
  tasks,
  holidays,
  timeZone,
  origin,
  onClose,
  onOfferUndo,
}: {
  uid: string;
  blocks: BlockView[];
  tasks: TaskView[];
  holidays: Holiday[];
  timeZone: string;
  origin: HTMLElement | null;
  onClose: () => void;
  /** Offers the import as one undoable action in the shell's toast. */
  onOfferUndo: (item: UndoableDelete) => void;
}) {
  const online = useOnline();
  const [phase, setPhase] = useState<Phase>("idle");
  const [token, setToken] = useState<string | null>(null);
  const [calendars, setCalendars] = useState<GcalCalendar[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [range, setRange] = useState<Range>(90);
  const [events, setEvents] = useState<Record<string, EventList>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  // The day the sheet was opened on: the window is a decision the user made by
  // opening this sheet, not one that moves while they read the preview.
  const [today] = useState(() => dateKey(new Date(), timeZone));

  /** What the planner already holds, so the plan is idempotent by construction. */
  const existing = useMemo(
    () => ({
      blockIds: blocks.map(block => block.id),
      taskIds: tasks.map(task => task.id),
      eventIds: blocks.flatMap(block => (block.source === undefined ? [] : [block.source.eventId])),
      holidays,
    }),
    [blocks, tasks, holidays],
  );

  // One mapper call per selected calendar: the calendar id is part of every
  // deterministic document id, so the plans cannot share one call. The mapper
  // is defensive by design; this try/catch is the backstop that keeps a shape it
  // did not anticipate from blanking the app during render -- the sheet says so
  // in place and leaves the import untouched.
  const planning = useMemo(() => {
    try {
      return {
        plans: chosen.map(id => planImport({ calendarId: id, events: events[id]?.events ?? [], timeZone, existing })),
        error: "",
      };
    } catch {
      return { plans: [] as ImportPlan[], error: "These events could not be read. Nothing was changed." };
    }
  }, [chosen, events, timeZone, existing]);
  const plans = planning.plans;

  /** How many events a capped read did read, or null when the whole window
   * arrived: a read the page limit cut short says so, because its count is not
   * the count of the window. */
  const capped = useMemo(() => {
    let count: number | null = null;
    for (const id of chosen) {
      const list = events[id];
      if (list?.truncated === true) count = (count ?? 0) + list.events.length;
    }
    return count;
  }, [chosen, events]);

  const totals = useMemo(() => {
    const skipped = emptySkips();
    let blockCount = 0;
    let taskCount = 0;
    let holidayCount = 0;
    for (const plan of plans) {
      blockCount += plan.blocks.length;
      taskCount += plan.tasks.length;
      holidayCount += plan.holidays.length;
      for (const reason of Object.keys(skipped) as ImportSkipReason[]) skipped[reason] += plan.skipped[reason];
    }
    return { blocks: blockCount, tasks: taskCount, holidays: holidayCount, skipped };
  }, [plans]);

  /** Tasks an earlier import made out of a Google holiday calendar, proven by the
   * calendar key in their id and the account's own calendar list, and what
   * replacing them with labels would write and delete. Nothing is deleted
   * without the confirmation below. */
  const cleanup = useMemo(() => {
    const read = new Map<string, GcalEvent>();
    for (const id of chosen) {
      for (const event of events[id]?.events ?? []) {
        if (typeof event?.id === "string") read.set(importDocId(id, event.id), event);
      }
    }
    const selected = selectHolidayTasks(tasks, calendars);
    return { selected, plan: planHolidayCleanup(selected, read, holidays.map(holiday => holiday.id)) };
  }, [tasks, calendars, chosen, events, holidays]);

  /** Everything imported so far, for the removal safety net. */
  const imported = useMemo(() => importedIds(blocks, tasks), [blocks, tasks]);
  const importedTotal = imported.blockIds.length + imported.taskIds.length;

  // Warm the GIS script as the sheet opens, not when Connect is pressed: the
  // consent popup has to open inside the click's user gesture, and a cold cache
  // would spend that gesture on a script load. A failure here is not reported --
  // pressing Connect retries the load and speaks if it fails again.
  // The desktop shell has no GIS: it signs in through the system browser.
  useEffect(() => {
    if (!isTauri()) void loadGis().catch(() => undefined);
  }, []);

  // The token is handed back to Google when it is replaced or the sheet goes
  // away: the import is over, and the residual hour of validity buys nothing.
  // It is already memory-only; this narrows the window rather than changing the
  // model, and a failed revoke is not worth telling the user about.
  useEffect(() => {
    if (token === null) return undefined;
    return () => revokeToken(token);
  }, [token]);

  // Closing the sheet mid-sign-in cancels the pending flow (the loopback port
  // closes) and any token that still arrives afterwards is revoked and dropped.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      cancelSignIn();
    };
  }, []);

  const connect = useCallback(async () => {
    setNotice(null);
    setPhase("connecting");
    try {
      const accessToken = await requestToken();
      if (!keepTokenIfLive(accessToken, live.current)) return;
      setToken(accessToken);
      setPhase("loading");
      const list = await listCalendars(accessToken);
      if (!live.current) return;
      setCalendars(list);
      // The owner's decision: the primary calendar is what an import starts
      // from; the others are one checkbox away.
      const first = list.find(calendar => calendar.primary) ?? list[0];
      setChosen(first === undefined ? [] : [first.id]);
      if (list.length === 0) {
        setToken(null);
        setPhase("idle");
        setNotice({ tone: "error", text: "This Google account has no calendars to read." });
      }
    } catch (cause) {
      // A closed popup, a blocked one or a refused consent all land here, and
      // all of them leave the import untouched: the sheet goes back to the step
      // that can be retried.
      setToken(null);
      setPhase("idle");
      setNotice({ tone: "error", text: cause instanceof Error ? cause.message : googleMessages.failed });
    }
  }, []);

  // Fetch the window for the selected calendars. A new range, a new calendar or
  // a retry after connecting all run through this one effect, so the preview can
  // never show counts from a window the user is no longer looking at.
  useEffect(() => {
    if (token === null || chosen.length === 0) return;
    let live = true;
    setPhase("loading");
    const window = eventWindow(today, range, timeZone);
    void (async () => {
      try {
        const pages = await Promise.all(chosen.map(id => listEvents(token, id, window)));
        if (!live) return;
        setEvents(Object.fromEntries(chosen.map((id, index) => [id, pages[index]])));
        setNotice(null);
        setPhase("preview");
      } catch (cause) {
        if (!live) return;
        // An expired token cannot be refreshed without a new gesture, so the
        // sheet returns to the connect step instead of offering a retry that
        // would fail the same way.
        setToken(null);
        setEvents({});
        setPhase("idle");
        setNotice({ tone: "error", text: cause instanceof Error ? cause.message : googleMessages.failed });
      }
    })();
    return () => {
      live = false;
    };
  }, [token, chosen, range, today, timeZone]);

  function toggle(calendarId: string) {
    setChosen(current =>
      current.includes(calendarId) ? current.filter(id => id !== calendarId) : [...current, calendarId],
    );
  }

  async function runImport() {
    if (busy || !online) return;
    setBusy(true);
    setNotice(null);
    const batch: { blocks: ImportPlan["blocks"]; tasks: ImportPlan["tasks"]; holidays: ImportPlan["holidays"] } = { blocks: [], tasks: [], holidays: [] };
    const counts = { blocks: 0, tasks: 0, holidays: 0 };
    try {
      for (const plan of plans) {
        if (plan.blocks.length === 0 && plan.tasks.length === 0 && plan.holidays.length === 0) continue;
        const written = await writeImportPlan(uid, plan);
        counts.blocks += written.blocks;
        counts.tasks += written.tasks;
        counts.holidays += written.holidays;
        batch.blocks.push(...plan.blocks);
        batch.tasks.push(...plan.tasks);
        // Only labels that did not exist before: undoing the import must never
        // delete a label the user already had (and may have reclassified).
        batch.holidays.push(...plan.holidays.filter(holiday => !holidays.some(stored => stored.id === holiday.id)));
      }
      // The undo is exactly this batch, not everything ever imported: the ids
      // are already known, so the compensating delete is bounded to these.
      onOfferUndo({
        message: importedMessage(counts),
        restore: async () => {
          await removeImported(uid, batch.blocks, batch.tasks);
          await removeHolidays(uid, batch.holidays.map(holiday => holiday.id));
        },
      });
      onClose();
    } catch {
      setNotice({
        tone: "error",
        text: "The import stopped partway. Run it again to finish; the imported documents keep their ids, so nothing is duplicated.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function runCleanup() {
    if (busy || !online) return;
    setBusy(true);
    setNotice(null);
    try {
      const counts = await cleanupHolidayTasks(uid, cleanup.plan);
      setConfirmCleanup(false);
      setNotice({ tone: "ok", text: `Replaced ${plural(counts.tasks, "holiday task")} with holiday labels.` });
    } catch {
      setNotice({ tone: "error", text: "Nothing was deleted. Try again." });
    } finally {
      setBusy(false);
    }
  }

  async function runRemove() {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const counts = await removeImported(uid, blocks, tasks);
      setConfirmRemove(false);
      setNotice({ tone: "ok", text: removedMessage(counts) });
    } catch {
      setNotice({ tone: "error", text: "Nothing was removed. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet label="Import from Google Calendar" className="gcal-sheet" origin={origin} onClose={onClose}>
      <div className="sheet-form">
        <header className="sheet-head">
          <span className="sheet-kind">Import from Google Calendar</span>
          <button type="button" className="icon-button" aria-label="Cancel" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <p className="gcal-lead">
          {phase === "preview"
            ? "Nothing has been written yet. Check the counts, then import."
            : "Import copies the events in the range you pick. It reads Google and never writes back; the Google sign-in is kept in this tab only."}
        </p>

        {!online && (
          <p className="gcal-note is-warn" role="status">
            You are offline. Importing needs a connection.
          </p>
        )}

        {/* Both primary buttons autofocus: the panel opens on the action that
            moves the flow forward, so a keyboard user never has to tab past the
            close control to start it. */}
        {phase === "idle" && (
          <button type="button" className="button-primary" autoFocus disabled={!online} onClick={() => void connect()}>
            Connect Google Calendar
          </button>
        )}

        {phase === "connecting" && (
          <p className="gcal-note" role="status">Waiting for Google…</p>
        )}

        {phase === "loading" && (
          <p className="gcal-note" role="status">Reading your Google calendars…</p>
        )}

        {phase === "preview" && (
          <>
            <fieldset className="gcal-field">
              <legend className="sheet-section-title">Range</legend>
              <div className="gcal-range">
                {ranges.map(days => (
                  <label key={days} className="gcal-range-option">
                    <input
                      type="radio"
                      name="gcal-range"
                      value={days}
                      checked={range === days}
                      onChange={() => setRange(days)}
                    />
                    <span>{days} days</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="gcal-field">
              <legend className="sheet-section-title">Calendars</legend>
              <div className="gcal-calendars">
                {calendars.map(calendar => (
                  <label key={calendar.id} className="gcal-calendar">
                    <input
                      type="checkbox"
                      className="check"
                      checked={chosen.includes(calendar.id)}
                      onChange={() => toggle(calendar.id)}
                    />
                    <span className="gcal-calendar-name">{calendar.summary}</span>
                    {calendar.primary === true && <span className="gcal-tag">Primary</span>}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="gcal-counts">
              {/* A shape the mapper did not anticipate is a sentence and an
                  untouched import, never a blank screen. */}
              {planning.error !== "" ? (
                <p className="inline-error" role="alert">{planning.error}</p>
              ) : (
                <>
                  <p className="gcal-summary">{previewSentence(totals.blocks, totals.tasks, totals.holidays)}</p>
                  {skippedSentence(totals.skipped) !== "" && (
                    <p className="gcal-note">{skippedSentence(totals.skipped)}</p>
                  )}
                  {capped !== null && (
                    <p className="gcal-note is-warn" role="status">{truncatedNote(capped)}</p>
                  )}
                </>
              )}
            </div>

            <button
              type="button"
              className="button-primary"
              autoFocus
              disabled={busy || !online || totals.blocks + totals.tasks + totals.holidays === 0}
              onClick={() => void runImport()}
            >
              {busy ? "Importing…" : `Import ${plural(totals.blocks + totals.tasks + totals.holidays, "item")}`}
            </button>
          </>
        )}

        {notice !== null && (
          <p className={notice.tone === "error" ? "inline-error" : "gcal-note"} role={notice.tone === "error" ? "alert" : "status"}>
            {notice.text}
          </p>
        )}

        {phase === "preview" && cleanup.selected.length > 0 && !confirmCleanup && (
          <button type="button" className="link-button gcal-remove" onClick={() => setConfirmCleanup(true)}>
            Clean up holiday tasks ({cleanup.selected.length})
          </button>
        )}

        {confirmCleanup && (
          <div className="gcal-confirm" role="group" aria-label="Clean up holiday tasks">
            <p className="gcal-confirm-text">
              Delete {plural(cleanup.plan.deletable.length, "task")} an earlier import made from your Google holiday
              calendars? They become holiday labels first. Tasks you created and tasks from other calendars are not touched.
              {cleanup.plan.kept > 0 && ` ${plural(cleanup.plan.kept, "holiday task")} without a usable date will stay.`}
            </p>
            <div className="gcal-confirm-actions">
              <button
                type="button"
                className="button-danger"
                disabled={busy || !online || cleanup.plan.deletable.length === 0}
                onClick={() => void runCleanup()}
              >
                Clean up
              </button>
              <button type="button" className="button" onClick={() => setConfirmCleanup(false)}>
                Keep
              </button>
            </div>
          </div>
        )}

        {importedTotal > 0 && !confirmRemove && (
          <button type="button" className="link-button gcal-remove" onClick={() => setConfirmRemove(true)}>
            Remove imported events ({importedTotal})
          </button>
        )}

        {confirmRemove && (
          <div className="gcal-confirm" role="group" aria-label="Remove imported events">
            <p className="gcal-confirm-text">
              Remove {plural(importedTotal, "imported item")}? Blocks and tasks you created are not touched.
            </p>
            <div className="gcal-confirm-actions">
              <button type="button" className="button-danger" disabled={busy} onClick={() => void runRemove()}>
                Remove
              </button>
              <button type="button" className="button" onClick={() => setConfirmRemove(false)}>
                Keep
              </button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
