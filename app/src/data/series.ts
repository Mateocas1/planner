import { addDoc, collection, deleteDoc, doc, setDoc, updateDoc } from "firebase/firestore";
import { createOccurrenceCompletion, createTask, expandOccurrences, occurrenceId, type Recurrence } from "../domain/model.ts";
import { db } from "./client.ts";

/** Frequency of a recurring series, exactly as the domain defines it. */
export type Frequency = Recurrence["frequency"];

/**
 * Validates a frequency + anchor pair through the domain's recurrence rules.
 * Expanding the anchor's own single day makes the domain reject an invalid
 * date-only value or an unknown frequency before any write.
 */
function requireValidRecurrence(seriesId: string, frequency: Frequency, anchorDate: string): Recurrence {
  const recurrence: Recurrence = { seriesId, frequency, anchorDate };
  const anchorOccurrences = expandOccurrences(recurrence, anchorDate, anchorDate);
  if (anchorOccurrences.length !== 1 || anchorOccurrences[0]!.date !== anchorDate) {
    throw new Error("series anchor date must be a valid occurrence date");
  }
  return recurrence;
}

/**
 * Series write helpers against `users/{uid}/series` and immutable completion
 * records against `users/{uid}/completions`. Each helper validates through the
 * domain module first and throws before any write on invalid input, so errors
 * propagate to the caller (the surface displays them; nothing is swallowed
 * here). Per D1, occurrences are never persisted: only the series definition
 * and one completion record per occurrence, keyed by occurrenceId.
 */
export async function addSeries(uid: string, title: string, frequency: Frequency, anchorDate: string, deadline?: string) {
  const validated = createTask("pending-mint", title, deadline);
  const recurrence = requireValidRecurrence("pending-mint", frequency, anchorDate);
  await addDoc(collection(db, `users/${uid}/series`), {
    title: validated.title,
    frequency: recurrence.frequency,
    anchorDate: recurrence.anchorDate,
    ...(validated.deadline === undefined ? {} : { deadline: validated.deadline }),
  });
}

/**
 * Renames a series. The title is validated through the domain module
 * (createTask) before any write; only the title field is written, so the
 * schedule and every completion record are left untouched.
 */
export async function renameSeries(uid: string, seriesId: string, title: string) {
  const validated = createTask(seriesId, title);
  await updateDoc(doc(db, `users/${uid}/series/${seriesId}`), { title: validated.title });
}

/**
 * Changes a series' frequency. The frequency and the (unchanged) anchor are
 * validated together through the domain's recurrence rules; only the frequency
 * field is written. Existing completion records are immutable and untouched.
 */
export async function setSeriesFrequency(uid: string, seriesId: string, frequency: Frequency, anchorDate: string) {
  requireValidRecurrence(seriesId, frequency, anchorDate);
  await updateDoc(doc(db, `users/${uid}/series/${seriesId}`), { frequency });
}

/**
 * Changes a series' anchor date. The anchor and the (unchanged) frequency are
 * validated together through the domain's recurrence rules; only the anchorDate
 * field is written. Existing completion records are immutable and untouched.
 */
export async function setSeriesAnchor(uid: string, seriesId: string, frequency: Frequency, anchorDate: string) {
  requireValidRecurrence(seriesId, frequency, anchorDate);
  await updateDoc(doc(db, `users/${uid}/series/${seriesId}`), { anchorDate });
}

/**
 * Deletes the series definition. Occurrences are derived, so removing the
 * definition removes every future occurrence from the UI. Per-occurrence
 * completion records are immutable history and are intentionally left in
 * place: nothing renders without the definition.
 */
export async function deleteSeries(uid: string, seriesId: string) {
  if (!seriesId || seriesId.includes("/")) throw new Error("series ID is invalid");
  await deleteDoc(doc(db, `users/${uid}/series/${seriesId}`));
}

/**
 * Completes exactly one occurrence by writing its immutable completion record.
 * Other occurrences are untouched: each has its own occurrenceId.
 */
export async function completeOccurrence(uid: string, seriesId: string, date: string) {
  const id = occurrenceId(seriesId, date);
  const completion = createOccurrenceCompletion(id, new Date().toISOString());
  await setDoc(doc(db, `users/${uid}/completions/${id}`), completion);
}
