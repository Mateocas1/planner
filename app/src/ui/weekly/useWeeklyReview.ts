import { useEffect, useState } from "react";
import { onSnapshot } from "firebase/firestore";
import { weeklyReviewDocument, type StoredWeeklyReview } from "../../data/weeklyReview.ts";
import {
  parseWeeklyReviewNote,
  parseWeeklyReviewState,
  weekOfInstant,
  type WeekIdentity,
  type WeeklyReviewNote,
  type WeeklyReviewState,
} from "../../planning/weekly.ts";

/**
 * The one subscription the weekly review's surfaces share: the current
 * ISO week's document — its step marks, skip flag, snooze and reflection note
 * — read through the same tolerant parsers every reader uses.
 *
 * The hook is mounted once in the shell; the banner, the nudge pump and the
 * flow all read from it, so "what is due" is one answer everywhere. The week
 * identity comes from the profile zone's wall clock (`weekOfInstant`), never
 * the browser's.
 */
export function useWeeklyReview(
  uid: string,
  timeZone: string,
  now: Date,
): { week: WeekIdentity; state: WeeklyReviewState; note?: WeeklyReviewNote; loading: boolean } {
  const [read, setRead] = useState<StoredWeeklyReview | undefined>(undefined);
  // Loading is "no snapshot yet", not "no document": an absent week document
  // is a week that has not started, and its empty snapshot must end the wait.
  const [ready, setReady] = useState(false);
  const week = weekOfInstant(now, timeZone);

  useEffect(() => {
    setRead(undefined);
    setReady(false);
    return onSnapshot(
      weeklyReviewDocument(uid, week.week),
      snapshot => {
        setRead(snapshot.data() as StoredWeeklyReview | undefined);
        setReady(true);
      },
      () => setReady(true),
    );
    // The week key only changes at a week boundary; `now` re-renders every
    // 30 s, and re-subscribing each tick would tear the listener down for
    // nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, week.week]);

  return {
    week,
    state: parseWeeklyReviewState(read, week.week),
    note: parseWeeklyReviewNote(read, week.week),
    loading: !ready,
  };
}
