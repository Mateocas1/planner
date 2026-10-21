import { useEffect, useState } from "react";
import { doc, getDoc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "./client.ts";
import { defaultWorkWindow, parseWorkWindow, validateWorkWindow, type WorkWindow } from "../planning/window.ts";

/**
 * The profile layer: a single document per user holding the planner's
 * timezone (D3) and the working window (W1). Recurrence and the planner's
 * calendar dates belong to this zone, not to the ambient browser zone.
 */

export type ProfileState = { loading: boolean; timeZone: string | null; workWindow: WorkWindow; error: string | null };

/**
 * Firestore paths need an even number of segments, so the feature contract's
 * `users/{uid}/profile` is realized as the `main` document of the `profile`
 * collection. It is the only profile document the app reads or writes.
 */
function profileRef(uid: string) {
  return doc(db, `users/${uid}/profile/main`);
}

/** The browser's resolved IANA zone, used to initialize a missing profile. */
export const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * A candidate zone is accepted only if Intl can format with it, which is
 * exactly the property the rendering path depends on. This accepts real IANA
 * zones (and their recognized aliases) and rejects everything else.
 */
export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the stored profile timezone, initializing it from the browser zone
 * when absent. The write is a plain merged set, not a transaction:
 * transactions fail offline, so a first-ever load with no profile and no
 * connectivity would otherwise leave the surface stuck on an error. Two tabs
 * initializing concurrently may both write the browser zone, but with
 * `{ merge: true }` both outcomes are equivalent and no field is lost.
 */
export async function ensureProfileTimeZone(uid: string): Promise<string> {
  const reference = profileRef(uid);
  const snapshot = await getDoc(reference);
  const stored = snapshot.data()?.timeZone;
  if (isValidTimeZone(stored)) return stored;
  await setDoc(
    reference,
    {
      timeZone: browserTimeZone,
      // Strings keep the emulator REST harness (which only decodes string and
      // boolean fields) able to read this document; parseWorkWindow accepts
      // both encodings, so a later numeric write by setProfileWorkWindow is
      // read the same way.
      workStart: String(defaultWorkWindow.startMinutes),
      workEnd: String(defaultWorkWindow.endMinutes),
    },
    { merge: true },
  );
  return browserTimeZone;
}

/** Sets the profile timezone explicitly after validating it. */
export async function setProfileTimeZone(uid: string, timeZone: string): Promise<void> {
  if (!isValidTimeZone(timeZone)) throw new Error(`not a valid IANA time zone: ${timeZone}`);
  await setDoc(profileRef(uid), { timeZone }, { merge: true });
}

/**
 * Persists the working window to the profile document.  Validates
 * that the end is after the start before writing.  The pure validation and
 * parsing live in `../planning/window.ts` so they can be unit-tested
 * without loading the Firebase client (which depends on `window`).
 */
export async function setProfileWorkWindow(uid: string, window: WorkWindow): Promise<void> {
  validateWorkWindow(window);
  await setDoc(profileRef(uid), { workStart: window.startMinutes, workEnd: window.endMinutes }, { merge: true });
}

/**
 * Subscribes to the profile document and exposes its timezone and work window,
 * initializing both on first use when absent. There is no permanent single-shot
 * guard: a later snapshot can retry a failed initialization (for example once
 * connectivity returns). Consecutive snapshots do not stack attempts — at
 * most one initialization is in flight, and a new one starts only when none
 * is running. The subscription picks up the initialization write and any
 * later change from another client.
 */
export function useProfileTimeZone(uid: string | null): ProfileState {
  const [state, setState] = useState<ProfileState>({
    loading: true, timeZone: null, workWindow: defaultWorkWindow, error: null,
  });
  useEffect(() => {
    if (!uid) {
      setState({ loading: false, timeZone: null, workWindow: defaultWorkWindow, error: null });
      return;
    }
    setState({ loading: true, timeZone: null, workWindow: defaultWorkWindow, error: null });
    let attempt: Promise<void> | null = null;
    const initialize = () => {
      if (attempt) return;
      attempt = ensureProfileTimeZone(uid)
        .then((timeZone) =>
          setState({ loading: false, timeZone, workWindow: defaultWorkWindow, error: null }),
        )
        .catch((error: unknown) => {
          console.error("profile initialization failed", error);
          setState({ loading: false, timeZone: null, workWindow: defaultWorkWindow, error: "Could not load your planner timezone." });
        })
        .finally(() => {
          attempt = null;
        });
    };
    const unsubscribe = onSnapshot(
      profileRef(uid),
      (snapshot) => {
        const data = snapshot.data();
        const stored = data?.timeZone;
        if (isValidTimeZone(stored)) {
          setState({ loading: false, timeZone: stored, workWindow: parseWorkWindow(data), error: null });
        } else {
          initialize();
        }
      },
      (error) => {
        console.error("profile snapshot failed", error);
        setState({ loading: false, timeZone: null, workWindow: defaultWorkWindow, error: "Could not load your planner timezone." });
      },
    );
    return unsubscribe;
  }, [uid]);
  return state;
}