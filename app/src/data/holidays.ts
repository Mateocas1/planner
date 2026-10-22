import { deleteField, doc, updateDoc, writeBatch, type Firestore } from "firebase/firestore";
import { isHolidayKind, type Holiday, type HolidayKind } from "../domain/holidays.ts";
import { db } from "./client.ts";
import { trackRemoval } from "./pending.ts";

/**
 * Holiday label writes against `users/{uid}/holidays/{importDocId}` (S11).
 * A holiday is only ever written by an import, which owns `date`, `title`,
 * `kind` and `source`, or by the user, who owns `kindOverride` and `hidden`.
 * The two sets never overlap, so an import rewrites its fields with a merge
 * and a re-import can never undo what the user decided.
 */

/** Firestore's limit on operations in one batched write. */
const MAX_BATCH_WRITES = 500;

/** The fields an import owns; `kindOverride` and `hidden` are never in it. */
export function holidayImportFields(holiday: Holiday): Record<string, unknown> {
  return { date: holiday.date, title: holiday.title, kind: holiday.kind, source: holiday.source };
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) result.push(values.slice(start, start + size));
  return result;
}

/** Writes the labels under their deterministic ids; a merge keeps the user's choices. */
export async function writeHolidays(uid: string, holidays: Holiday[], database: Firestore = db): Promise<number> {
  for (const chunk of chunks(holidays, MAX_BATCH_WRITES)) {
    const batch = writeBatch(database);
    for (const holiday of chunk) batch.set(doc(database, `users/${uid}/holidays/${holiday.id}`), holidayImportFields(holiday), { merge: true });
    await batch.commit();
  }
  return holidays.length;
}

/** The user's own classification; `undefined` clears it back to Google's wording. */
export async function setHolidayKindOverride(uid: string, holidayId: string, kind: HolidayKind | undefined, database: Firestore = db) {
  if (kind !== undefined && !isHolidayKind(kind)) throw new Error("holiday kind is invalid");
  await updateDoc(doc(database, `users/${uid}/holidays/${holidayId}`), { kindOverride: kind === undefined ? deleteField() : kind });
}

/** Hides one holiday from the calendar; `false` shows it again. */
export async function setHolidayHidden(uid: string, holidayId: string, hidden: boolean, database: Firestore = db) {
  await updateDoc(doc(database, `users/${uid}/holidays/${holidayId}`), { hidden: hidden ? true : deleteField() });
}

/** Deletes the named holiday documents (the compensating action of an import's undo). */
export async function removeHolidays(uid: string, ids: string[], database: Firestore = db): Promise<number> {
  for (const chunk of chunks(ids, MAX_BATCH_WRITES)) {
    const batch = writeBatch(database);
    const paths = chunk.map(id => `users/${uid}/holidays/${id}`);
    for (const path of paths) batch.delete(doc(database, path));
    const commit = batch.commit();
    for (const path of paths) void trackRemoval(path, commit).catch(() => undefined);
    await commit;
  }
  return ids.length;
}
