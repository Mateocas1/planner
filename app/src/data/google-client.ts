import { toZonedInstant } from "../domain/instant.ts";
import type { GcalEvent } from "../domain/gcalImport.ts";
import { googleClientId } from "./firebase-config.ts";

/**
 * The browser half of "Import from Google Calendar" (value roadmap §1): the
 * Google Identity Services token client and the two Calendar REST reads.
 *
 * Nothing here decides what an event becomes (that is `domain/gcalImport.ts`)
 * and nothing here writes to Firestore (that is `data/gcal.ts`). This module
 * only turns a button press into an access token and a window of events.
 *
 * The token model is deliberate: `initTokenClient` + `requestAccessToken` is
 * the browser-only implicit grant. There is no server, so there is no refresh
 * token to leak, and the access token lives in the caller's memory for the
 * length of one import -- it is never written to storage or to Firestore. When
 * it expires the user connects again, which is one click.
 *
 * The GIS script is loaded lazily, on the first click that needs it, so the
 * ~40 KB of `accounts.google.com/gsi/client` never enters the app bundle.
 */

/** The two read-only scopes: events to import, and the list of calendars. */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
].join(" ");

const GIS_SRC = "https://accounts.google.com/gsi/client";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** Google's maximum page size for `events.list`; the mapper takes any count. */
export const MAX_EVENTS_PER_PAGE = 250;

/** A page loop that stops: ten thousand events is more than a planner imports. */
const MAX_PAGES = 40;

/**
 * What the user is told when a step of the import fails. Every sentence names
 * what happened and what to do next; none of them is a status code, and none
 * of them claims the import half-worked -- the flow only writes after a plan is
 * complete, and an undone import is the compensating action.
 */
export const googleMessages = {
  closed: "Google sign-in was closed before it finished. Nothing was changed.",
  blocked: "Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.",
  denied: "Google did not authorize the import. Nothing was changed.",
  unavailable: "Google sign-in could not load. Check your connection and try again.",
  expired: "The Google session expired. Connect again.",
  failed: "Google Calendar could not be read. Try again.",
} as const;

/**
 * The sentence for a sign-in failure. GIS reports a closed popup and a blocked
 * popup through `error_callback` types, and a refused consent as
 * `access_denied` on the token response; everything else is the generic refusal,
 * which is true of all of them: nothing was imported.
 */
export function authMessage(code: string | undefined): string {
  if (code === "popup_closed" || code === "popup_closed_by_user") return googleMessages.closed;
  if (code === "popup_failed_to_open") return googleMessages.blocked;
  return googleMessages.denied;
}

/** The sentence for a failed REST read. A 401/403 means the token is gone. */
export function statusMessage(status: number): string {
  if (status === 401 || status === 403) return googleMessages.expired;
  return googleMessages.failed;
}

/* ---------- the window ---------- */

/** A UTC day key moved by `days`, read as a plain calendar day. */
function addDays(date: string, days: number): string {
  const stamp = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(stamp)) throw new Error("expected a valid date-only value");
  return new Date(stamp + days * 86_400_000).toISOString().slice(0, 10);
}

export type EventWindow = { timeMin: string; timeMax: string };

/**
 * Today 00:00 to `days` days later, in the profile zone: the import starts with
 * the day the user is living in (an event earlier today is still part of it)
 * and ends at a midnight, so re-running an import extends the window rather
 * than shifting it by the time of day.
 */
export function eventWindow(today: string, days: number, timeZone: string): EventWindow {
  return {
    timeMin: toZonedInstant(`${today}T00:00`, timeZone),
    timeMax: toZonedInstant(`${addDays(today, days)}T00:00`, timeZone),
  };
}

/* ---------- the REST reads ---------- */

/** One calendar the account can read. `primary` is the user's main calendar. */
export type GcalCalendar = { id: string; summary: string; primary?: boolean };

/**
 * Reads `calendarList.items` into the calendars the picker offers: the primary
 * calendar first, then by name, without the ones Google marks deleted. A
 * calendar without a summary falls back to its id, so a row is never blank.
 */
export function calendarsFrom(body: unknown): GcalCalendar[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const calendars: GcalCalendar[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const data = item as Record<string, unknown>;
    if (typeof data.id !== "string" || data.id === "" || data.deleted === true) continue;
    const summary = typeof data.summary === "string" && data.summary.trim() !== "" ? data.summary.trim() : data.id;
    calendars.push({ id: data.id, summary, ...(data.primary === true ? { primary: true } : {}) });
  }
  return calendars.sort((left, right) => {
    if (left.primary !== right.primary) return left.primary ? -1 : 1;
    return left.summary.localeCompare(right.summary);
  });
}

/** The `events.list` URL for one calendar and one window (single page). */
export function eventsUrl(calendarId: string, query: EventWindow & { pageToken?: string }): string {
  const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`);
  // singleEvents expands a recurring series into the instances inside the
  // window, and orderBy=startTime then needs it: each instance is its own block.
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", String(MAX_EVENTS_PER_PAGE));
  url.searchParams.set("timeMin", query.timeMin);
  url.searchParams.set("timeMax", query.timeMax);
  if (query.pageToken !== undefined && query.pageToken !== "") url.searchParams.set("pageToken", query.pageToken);
  return url.toString();
}

export type RequestOptions = { fetchImpl?: typeof fetch };

/** One authorized JSON GET. A transport failure and a bad status both end as a
 * sentence, because that is what the sheet shows. */
async function getJson(url: string, token: string, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new Error(statusMessage(0));
  }
  if (!response.ok) throw new Error(statusMessage(response.status));
  try {
    return await response.json();
  } catch {
    throw new Error(statusMessage(0));
  }
}

/**
 * The calendars the account can read, paged. The Calendar API pages this list
 * too, and an account with many shared calendars is a normal account.
 */
export async function listCalendars(token: string, options: RequestOptions = {}): Promise<GcalCalendar[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const calendars: GcalCalendar[] = [];
  let pageToken = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`${CALENDAR_API}/users/me/calendarList`);
    url.searchParams.set("maxResults", "250");
    if (pageToken !== "") url.searchParams.set("pageToken", pageToken);
    const body = await getJson(url.toString(), token, fetchImpl);
    calendars.push(...calendarsFrom(body));
    const next = (body as { nextPageToken?: unknown } | null)?.nextPageToken;
    pageToken = typeof next === "string" ? next : "";
    if (pageToken === "") break;
  }
  return calendars;
}

/**
 * Every event in the window for one calendar, following `nextPageToken` to the
 * last page. The items are returned as Google sent them: the mapper, not this
 * function, decides what an item means, and an item it cannot use is counted
 * as unusable there instead of disappearing here.
 */
export async function listEvents(
  token: string,
  calendarId: string,
  window: EventWindow,
  options: RequestOptions = {},
): Promise<GcalEvent[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const events: GcalEvent[] = [];
  let pageToken = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await getJson(eventsUrl(calendarId, { ...window, pageToken }), token, fetchImpl);
    const items = (body as { items?: unknown } | null)?.items;
    if (Array.isArray(items)) events.push(...(items as GcalEvent[]));
    const next = (body as { nextPageToken?: unknown } | null)?.nextPageToken;
    pageToken = typeof next === "string" ? next : "";
    if (pageToken === "") break;
  }
  return events;
}

/* ---------- the token client ---------- */

type TokenResponse = { access_token?: string; expires_in?: string | number; error?: string };
type TokenClient = { requestAccessToken: () => void };
type OAuth2 = {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    callback: (response: TokenResponse) => void;
    error_callback: (error: { type?: string }) => void;
  }) => TokenClient;
};

/** The shape GIS installs on the page. It is absent until the script runs. */
type GisWindow = { google?: { accounts?: { oauth2?: OAuth2 } } };

function gisApi(): OAuth2 | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as GisWindow).google?.accounts?.oauth2 ?? null;
}

let loading: Promise<OAuth2> | null = null;

/**
 * Loads `gsi/client` once, on demand, and hands back the token client factory.
 * Concurrent callers share one script tag. A failed load clears the memo so the
 * next click retries instead of remembering a transient network failure.
 */
export function loadGis(): Promise<OAuth2> {
  const ready = gisApi();
  if (ready !== null) return Promise.resolve(ready);
  if (loading !== null) return loading;
  loading = new Promise<OAuth2>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const api = gisApi();
      if (api !== null) resolve(api);
      else reject(new Error(googleMessages.unavailable));
    };
    script.onerror = () => reject(new Error(googleMessages.unavailable));
    document.head.appendChild(script);
  }).catch(cause => {
    loading = null;
    throw cause;
  });
  return loading;
}

/**
 * Asks Google for an access token. Call this from a click handler: the consent
 * popup has to be opened by a user gesture, and a blocked popup is reported
 * through `error_callback` as `popup_failed_to_open`.
 *
 * The Promise rejects with a sentence from `googleMessages`, so the sheet can
 * show what happened without knowing anything about GIS error codes.
 */
export async function requestToken(clientId: string = googleClientId): Promise<string> {
  const oauth2 = await loadGis();
  return new Promise<string>((resolve, reject) => {
    // GIS may call the callback and the error callback; only the first answer
    // may settle the promise, or a late duplicate would throw an unhandled
    // rejection after the sheet already moved on.
    let settled = false;
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_SCOPES,
      callback: response => {
        if (settled) return;
        settled = true;
        const token = response.access_token;
        if (typeof token === "string" && token !== "" && response.error === undefined) resolve(token);
        else reject(new Error(authMessage(response.error)));
      },
      error_callback: error => {
        if (settled) return;
        settled = true;
        reject(new Error(authMessage(error.type)));
      },
    });
    client.requestAccessToken();
  });
}
