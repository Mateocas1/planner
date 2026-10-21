import { useEffect, useState } from "react";
import { doc, getDoc, onSnapshot, setDoc, type Firestore } from "firebase/firestore";
import { db } from "./client.ts";
import { isDayKey } from "../planning/shutdown.ts";
import { defaultWorkWindow, minutesPerDay, parseWorkWindow, validateWorkWindow, type WorkWindow } from "../planning/window.ts";

/**
 * The profile layer: a single document per user holding the planner's
 * timezone (D3), the working window (W1) and the day settings that S1 edits:
 * when the day shuts down (F3), whether keyboard shortcuts are on (F6), and
 * the day the shutdown ritual was last closed (F3, `lastShutdown`).
 * Recurrence and the planner's calendar dates belong to this zone, not to the
 * ambient browser zone.
 *
 * `useProfileTimeZone` keeps its name for the surfaces that already read it
 * (the hook predates the day settings); it is the whole profile subscription.
 */

/** 18:00: the hour the day is meant to close (distinctive roadmap F3). */
export const defaultShutdownTime = 18 * 60;

/** Shortcuts start on; the Day settings toggle is the only thing that changes it. */
export const defaultShortcutsEnabled = true;

export type ProfileState = {
  loading: boolean;
  timeZone: string | null;
  workWindow: WorkWindow;
  /** Minutes after midnight in the profile zone; 1080 is 18:00. */
  shutdownTime: number;
  shortcutsEnabled: boolean;
  error: string | null;
};

/** A value the app stored as minutes, whether it is a number (a write from
 * this client) or a numeric string (the emulator harness, older clients). */
function storedMinutes(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Firestore paths need an even number of segments, so the feature contract's
 * `users/{uid}/profile` is realized as the `main` document of the `profile`
 * collection. It is the only profile document the app reads or writes.
 *
 * Exported because the shutdown batch (`data/tasks.ts`) stamps its
 * `lastShutdown` field in the same atomic write as the deadlines it rolls, so
 * the batch and the profile layer must agree on one document reference. The
 * database is a parameter for the emulator suite, which drives that batch
 * through its own authenticated client.
 */
export function profileDocument(uid: string, database: Firestore = db) {
  return doc(database, `users/${uid}/profile/main`);
}

/**
 * Reads the day the ritual was last closed (F3). Anything that is not a real
 * calendar day reads as absent, so a hand-edited document, or one written
 * before the ritual existed, simply reads as "not closed today" rather than
 * suppressing the banner forever.
 */
export function parseLastShutdown(data: Record<string, unknown> | undefined): string | undefined {
  const value = data?.lastShutdown;
  return isDayKey(value) ? value : undefined;
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
 *
 * It writes the zone and nothing else. An absent working window already reads
 * as 08:00-21:00 (`parseWorkWindow`), and writing that default here raced the
 * Day settings unit: a snapshot that was still the local echo of a merge write
 * carries only the fields that write touched, so this initialization read "no
 * timezone" and wrote 08:00-21:00 over a window the user had just set. A
 * default that is never written cannot lose that race.
 */
export async function ensureProfileTimeZone(uid: string): Promise<string> {
  const reference = profileDocument(uid);
  const snapshot = await getDoc(reference);
  const stored = snapshot.data()?.timeZone;
  if (isValidTimeZone(stored)) return stored;
  await setDoc(reference, { timeZone: browserTimeZone }, { merge: true });
  return browserTimeZone;
}

/** Sets the profile timezone explicitly after validating it. */
export async function setProfileTimeZone(uid: string, timeZone: string): Promise<void> {
  if (!isValidTimeZone(timeZone)) throw new Error(`not a valid IANA time zone: ${timeZone}`);
  await setDoc(profileDocument(uid), { timeZone }, { merge: true });
}

/**
 * Persists the working window to the profile document.  Validates
 * that the end is after the start before writing.  The pure validation and
 * parsing live in `../planning/window.ts` so they can be unit-tested
 * without loading the Firebase client (which depends on `window`).
 */
export async function setProfileWorkWindow(uid: string, window: WorkWindow): Promise<void> {
  validateWorkWindow(window);
  await setDoc(profileDocument(uid), { workStart: window.startMinutes, workEnd: window.endMinutes }, { merge: true });
}

/**
 * The shutdown time, read the same way as the working window: an absent,
 * non-integer or out-of-day value falls back to 18:00, so an older profile (or
 * none at all) still yields a usable hour. Readers never fail.
 */
export function parseShutdownTime(data: Record<string, unknown> | undefined): number {
  const minutes = storedMinutes(data?.shutdownTime);
  return minutes !== undefined && Number.isInteger(minutes) && minutes >= 0 && minutes <= minutesPerDay
    ? minutes
    : defaultShutdownTime;
}

/** The shortcuts toggle; absent means on (the product's default, F6). */
export function parseShortcutsEnabled(data: Record<string, unknown> | undefined): boolean {
  return typeof data?.shortcutsEnabled === "boolean" ? data.shortcutsEnabled : defaultShortcutsEnabled;
}

/**
 * Rejects one minute value the reader would not read back: whole minutes inside
 * the day. This is the guard W1's report asks for -- nothing is written that
 * `parseWorkWindow` or `parseShutdownTime` would silently replace.
 */
function assertMinutesInDay(name: string, minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > minutesPerDay) {
    throw new Error(`the ${name} is outside the day`);
  }
}

/** The day-settings fields a caller changes; absent fields are left alone. */
export type DaySettingsPatch = {
  workWindow?: WorkWindow;
  shutdownTime?: number;
  shortcutsEnabled?: boolean;
};

/**
 * Persists the changed day settings in one merged write, validating them first.
 * Only the fields in the patch are written, so two controls editing the same
 * document (a window and a toggle, or a second device) never write a stale copy
 * of each other's value. `shutdownTime` is stored as minutes after midnight
 * (1080 is 18:00) and the window as `workStart`/`workEnd`, the fields W1
 * already reads, so a profile written here is read back unchanged.
 */
export async function setProfileDaySettings(uid: string, patch: DaySettingsPatch): Promise<void> {
  const fields: Record<string, number | boolean> = {};
  if (patch.workWindow) {
    assertMinutesInDay("work start", patch.workWindow.startMinutes);
    assertMinutesInDay("work end", patch.workWindow.endMinutes);
    validateWorkWindow(patch.workWindow);
    fields.workStart = patch.workWindow.startMinutes;
    fields.workEnd = patch.workWindow.endMinutes;
  }
  if (patch.shutdownTime !== undefined) {
    assertMinutesInDay("shutdown time", patch.shutdownTime);
    fields.shutdownTime = patch.shutdownTime;
  }
  if (patch.shortcutsEnabled !== undefined) {
    fields.shortcutsEnabled = patch.shortcutsEnabled;
  }
  if (Object.keys(fields).length === 0) return;
  await setDoc(profileDocument(uid), fields, { merge: true });
}

/** Everything a snapshot can fill in; the day settings default until it does. */
const unloadedProfile: Omit<ProfileState, "loading"> = {
  timeZone: null,
  workWindow: defaultWorkWindow,
  shutdownTime: defaultShutdownTime,
  shortcutsEnabled: defaultShortcutsEnabled,
  error: null,
};

/**
 * Subscribes to the profile document and exposes its timezone, work window and
 * day settings, initializing the timezone and the window on first use when
 * absent. There is no permanent single-shot
 * guard: a later snapshot can retry a failed initialization (for example once
 * connectivity returns). Consecutive snapshots do not stack attempts — at
 * most one initialization is in flight, and a new one starts only when none
 * is running. The subscription picks up the initialization write and any
 * later change from another client.
 */
export function useProfileTimeZone(uid: string | null): ProfileState {
  const [state, setState] = useState<ProfileState>({ ...unloadedProfile, loading: true });
  useEffect(() => {
    if (!uid) {
      setState({ ...unloadedProfile, loading: false });
      return;
    }
    setState({ ...unloadedProfile, loading: true });
    let attempt: Promise<void> | null = null;
    /* `data` is the snapshot that asked for the initialization: it is what the
       state keeps while the write lands, so a profile that already holds a
       window never flashes the default one. */
    const initialize = (data: Record<string, unknown> | undefined) => {
      if (attempt) return;
      attempt = ensureProfileTimeZone(uid)
        .then((timeZone) =>
          setState({
            ...unloadedProfile,
            loading: false,
            timeZone,
            workWindow: parseWorkWindow(data),
            shutdownTime: parseShutdownTime(data),
            shortcutsEnabled: parseShortcutsEnabled(data),
          }),
        )
        .catch((error: unknown) => {
          console.error("profile initialization failed", error);
          setState({ ...unloadedProfile, loading: false, error: "Could not load your planner timezone." });
        })
        .finally(() => {
          attempt = null;
        });
    };
    const unsubscribe = onSnapshot(
      profileDocument(uid),
      (snapshot) => {
        const data = snapshot.data();
        const stored = data?.timeZone;
        if (isValidTimeZone(stored)) {
          setState({
            ...unloadedProfile,
            loading: false,
            timeZone: stored,
            workWindow: parseWorkWindow(data),
            shutdownTime: parseShutdownTime(data),
            shortcutsEnabled: parseShortcutsEnabled(data),
          });
        } else {
          initialize(data);
        }
      },
      (error) => {
        console.error("profile snapshot failed", error);
        setState({ ...unloadedProfile, loading: false, error: "Could not load your planner timezone." });
      },
    );
    return unsubscribe;
  }, [uid]);
  return state;
}
