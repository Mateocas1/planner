import { addDoc, collection, doc, setDoc } from "firebase/firestore";
import { createOccurrenceCompletion, createTask, expandOccurrences, occurrenceId, type Recurrence } from "../domain/model.ts";
import { db } from "./client.ts";

/** Frequency of a recurring series, exactly as the domain defines it. */
export type Frequency = Recurrence["frequency"];

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
  const recurrence: Recurrence = { seriesId: "pending-mint", frequency, anchorDate };
  // Validating the anchor by expanding its own single day: the domain rejects
  // an invalid date-only value or an unknown frequency before any write.
  const anchorOccurrences = expandOccurrences(recurrence, anchorDate, anchorDate);
  if (anchorOccurrences.length !== 1 || anchorOccurrences[0]!.date !== anchorDate) {
    throw new Error("series anchor date must be a valid occurrence date");
  }
  await addDoc(collection(db, `users/${uid}/series`), {
    title: validated.title,
    frequency: recurrence.frequency,
    anchorDate: recurrence.anchorDate,
    ...(validated.deadline === undefined ? {} : { deadline: validated.deadline }),
  });
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
