import { arrayUnion, deleteField, doc, getDoc, setDoc, updateDoc, type Firestore } from "firebase/firestore";
import { requireInstant } from "../domain/model.ts";
import {
  emptyWeekState,
  isWeekKey,
  MAX_NOTE_CHARS,
  parseWeeklyReviewNote,
  parseWeeklyReviewState,
  weeklyReviewSteps,
  type WeeklyReviewNote,
  type WeeklyReviewState,
  type WeeklyReviewStep,
} from "../planning/weekly.ts";
import { db } from "./client.ts";

/**
 * Firestore writes for the weekly review: one document
 * per ISO week under `users/{uid}/weeklyReview/{week}` holding the week's
 * state (steps done, skipped flag, snooze) and its reflection note, plus the
 * `someday` flag the Clean-up step sets on tasks.
 *
 * The paths follow the profile's own rule: everything lives under the signed-in
 * user's subtree, which `firestore.rules` already restricts to its owner, so
 * no new rule is needed — and rules cannot additively validate the shape of
 * one collection (Firestore allows are OR-ed, so a narrower match cannot
 * tighten the owner wildcard). Shape is therefore validated here, before any
 * write, exactly like `data/tasks.ts` validates through the domain module: a
 * rejected note or state never reaches Firestore.
 *
 * Every write is a plain merged set, never a transaction: transactions fail
 * offline, and recording a step, a skip or a snooze on a train has to keep
 * working. Replays are last-writer-wins, the app's rule for every field write.
 *
 * These helpers take the database as a parameter with the app's client as its
 * default, so the emulator suite can drive them against its own authenticated
 * client; the surfaces call them without the argument.
 */

/** One week's document: state fields and (optionally) the reflection note. */
export type StoredWeeklyReview = WeeklyReviewState & { note?: WeeklyReviewNote };

function requireWeek(week: string): string {
  if (!isWeekKey(week)) throw new Error(`week must be an ISO week key (YYYY-Www), got ${JSON.stringify(week)}`);
  return week;
}

function requireTaskId(taskId: string): string {
  if (typeof taskId !== "string" || taskId === "" || taskId.includes("/")) throw new Error("task ID is invalid");
  return taskId;
}

/** The document reference of one week's review. */
export function weeklyReviewDocument(uid: string, week: string, database: Firestore = db) {
  return doc(database, `users/${uid}/weeklyReview/${requireWeek(week)}`);
}

/**
 * Writes one week's state: its `skipped` flag and its snooze — every field
 * the state model owns except the step marks. `stepsDone` is deliberately
 * never written here: step changes go through `markWeeklyStepDone`'s
 * array-union, so saving a state read earlier cannot clobber the mark another
 * device queued offline (last-writer-wins is the app's rule per field, and
 * the step list is one field a whole-array write would take over). The note
 * is a separate concern and is left alone.
 */
export async function saveWeeklyReviewState(uid: string, state: WeeklyReviewState, database: Firestore = db) {
  requireWeek(state.week);
  if (!Array.isArray(state.stepsDone) || state.stepsDone.some(step => !(weeklyReviewSteps as readonly string[]).includes(step))) {
    throw new Error("weekly review steps must be review, cleanup, plan or reflect");
  }
  if (typeof state.skipped !== "boolean") throw new Error("skipped must be a boolean");
  if (state.snoozedUntil !== undefined) requireInstant(state.snoozedUntil);
  await setDoc(
    weeklyReviewDocument(uid, state.week, database),
    {
      week: state.week,
      skipped: state.skipped,
      ...(state.snoozedUntil === undefined ? { snoozedUntil: deleteField() } : { snoozedUntil: state.snoozedUntil }),
    },
    { merge: true },
  );
}

/** Marks one step of the week as walked. The array-union transform queues
 *  offline and merges with the other device's marks instead of overwriting
 *  them, so two devices can both finish a step while offline. */
export async function markWeeklyStepDone(uid: string, week: string, step: WeeklyReviewStep, database: Firestore = db) {
  requireWeek(week);
  if (!(weeklyReviewSteps as readonly string[]).includes(step)) {
    throw new Error(`weekly review step must be review, cleanup, plan or reflect, got ${JSON.stringify(step)}`);
  }
  await setDoc(weeklyReviewDocument(uid, week, database), { week, stepsDone: arrayUnion(step) }, { merge: true });
}

/** Marks the week skipped: nothing proposes itself until next week. */
export async function skipWeeklyReview(uid: string, week: string, database: Firestore = db) {
  await setDoc(weeklyReviewDocument(uid, week, database), { week, skipped: true }, { merge: true });
}

/** Holds the nudge until the given zoned instant (the "Later" action, +2 h). */
export async function snoozeWeeklyReview(uid: string, week: string, until: string, database: Firestore = db) {
  requireWeek(week);
  requireInstant(until);
  await setDoc(weeklyReviewDocument(uid, week, database), { week, snoozedUntil: until }, { merge: true });
}

/** Clears the week's snooze (the review was opened by hand). */
export async function clearWeeklyReviewSnooze(uid: string, week: string, database: Firestore = db) {
  await setDoc(weeklyReviewDocument(uid, week, database), { week, snoozedUntil: deleteField() }, { merge: true });
}

/**
 * Writes the reflection note (what worked, what did not, one intention).
 * The text is trimmed and capped at `MAX_NOTE_CHARS` — an oversized note is
 * rejected rather than truncated, because a silently cut note is not the note
 * anybody wrote. `createdAt` is when the note was first written: the write
 * reads the stored note through the same tolerant parser every reader uses and
 * keeps its instant, stamping `updatedAt` instead, so an edit never re-dates
 * the note. The read is a getDoc against the local cache first, so it works
 * offline; the first write ever simply stamps now.
 */
export async function saveWeeklyReviewNote(uid: string, week: string, text: string, database: Firestore = db) {
  requireWeek(week);
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed === "") throw new Error("the reflection note must not be empty");
  if (trimmed.length > MAX_NOTE_CHARS) throw new Error(`the reflection note must be at most ${MAX_NOTE_CHARS} characters`);
  const reference = weeklyReviewDocument(uid, week, database);
  const stored = parseWeeklyReviewNote((await getDoc(reference)).data(), week);
  await setDoc(
    reference,
    {
      week,
      note: {
        text: trimmed,
        createdAt: stored?.createdAt ?? new Date().toISOString(),
        ...(stored === undefined ? {} : { updatedAt: new Date().toISOString() }),
      },
    },
    { merge: true },
  );
}

/** Reads one week's document as its state and note, both tolerant of bad data. */
export async function readWeeklyReview(uid: string, week: string, database: Firestore = db): Promise<StoredWeeklyReview> {
  const data = (await getDoc(weeklyReviewDocument(uid, week, database))).data();
  const note = parseWeeklyReviewNote(data, week);
  return { ...parseWeeklyReviewState(data, week), ...(note === undefined ? {} : { note }) };
}

/**
 * Flags or unflags a task as "someday" (S3's Clean-up action). The model has
 * no someday shelf of its own, so the flag is a new additive boolean field on
 * the task document: absent means "not someday", exactly like every other
 * optional task field. It lives here rather than in `data/tasks.ts` because
 * the weekly review owns the action; the flag is deliberately plain data so a
 * later surface (a someday list, the radar) can read it without this module.
 */
export async function setTaskSomeday(uid: string, taskId: string, someday: boolean, database: Firestore = db) {
  requireTaskId(taskId);
  await updateDoc(
    doc(database, `users/${uid}/tasks/${taskId}`),
    someday ? { someday: true } : { someday: deleteField() },
  );
}

/** True when the task document carries the someday flag. */
export function parseTaskSomeday(data: Record<string, unknown> | undefined): boolean {
  return data?.someday === true;
}
