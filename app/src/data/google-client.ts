import { t } from "../i18n/index.ts";
import { toZonedInstant } from "../domain/instant.ts";
import type { GcalEvent } from "../domain/gcalImport.ts";
import { isTauri } from "../desktop.ts";
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
 * The GIS script is never in the app bundle: it is loaded lazily from Google,
 * warmed when the import sheet opens and awaited again by the first click, so a
 * cold cache does not eat the user gesture the consent popup needs. The only
 * trace of it in the build is the URL string below.
 *
 * Inside the Tauri desktop shell the GIS popup cannot work (WebView2), so
 * `requestToken` asks the Rust side for the same kind of token: Google's own
 * sign-in in the system browser (loopback redirect, PKCE; see
 * `src-tauri/src/google_oauth.rs`). Everything downstream is identical.
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
export const MAX_PAGES = 40;

/** How long a hung `gsi/client` load is given before the sheet stops waiting. */
export const GIS_LOAD_TIMEOUT_MS = 10_000;

/**
 * What the user is told when a step of the import fails. Every sentence names
 * what happened and what to do next; none of them is a status code, and none
 * of them claims the import half-worked -- the flow only writes after a plan is
 * complete, and an undone import is the compensating action.
 */
export const googleMessages = {
  get closed() {
    return t("google.closed");
  },
  get blocked() {
    return t("google.blocked");
  },
  get denied() {
    return t("google.denied");
  },
  get unavailable() {
    return t("google.unavailable");
  },
  get expired() {
    return t("google.expired");
  },
  get failed() {
    return t("google.failed");
  },
  get notConfigured() {
    return t("google.notConfigured");
  },
  get timedOut() {
    return t("google.timedOut");
  },
  get signInFailed() {
    return t("google.signInFailed");
  },
};

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

/**
 * The sentence for a desktop sign-in failure. The Rust command rejects with a
 * short code (`src-tauri/core/src/oauth.rs`); any other value, including a
 * transport error from `invoke`, is the generic failure.
 */
export function desktopAuthMessage(code: unknown): string {
  switch (code) {
    case "not_configured":
      return googleMessages.notConfigured;
    case "cancelled":
      return googleMessages.closed;
    case "timeout":
      return googleMessages.timedOut;
    case "denied":
      return googleMessages.denied;
    default:
      return googleMessages.signInFailed;
  }
}

/** The access token in a desktop command result, or null for any other shape. */
export function desktopTokenFrom(result: unknown): string | null {
  const token = (result as { accessToken?: unknown } | null)?.accessToken;
  return typeof token === "string" && token !== "" ? token : null;
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

/** What `listEvents` read: the events, and whether the page cap cut the read short. */
export type EventList = { events: GcalEvent[]; truncated: boolean };

/**
 * The note under a truncated preview. A capped read still imports what it read;
 * the note says how much arrived and what narrows it, instead of letting the
 * count look complete.
 */
export function truncatedNote(count: number): string {
  return t("gcal.truncated", { count });
}

/**
 * Resolves with `promise`, or rejects with `message` if it has not settled
 * within `ms`. Exported so the loader's bound is testable without a DOM: the
 * sheet must never sit on "connecting" because a script never answered.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      cause => {
        clearTimeout(timer);
        reject(cause);
      },
    );
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

/**
 * The `items` array of one page, or null when the body is not a list page.
 * A body without `items` is an empty page: the Calendar API omits the field
 * when the window holds no events, so treating it as malformed would turn
 * "nothing in this range" into "Google could not be read".
 */
function pageItems(body: unknown): unknown[] | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const items = (body as { items?: unknown }).items;
  if (items === undefined) return [];
  return Array.isArray(items) ? items : null;
}

/**
 * The next page token of one page. Only a non-empty string is a page: anything
 * else ends the loop instead of fetching a page Google did not ask for.
 */
function nextPageToken(body: unknown): string {
  const next = (body as { nextPageToken?: unknown } | null)?.nextPageToken;
  return typeof next === "string" ? next : "";
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
    // A shape the Calendar API never sends is not an empty calendar list: say
    // so, rather than showing the user a picker with no calendars in it.
    const items = pageItems(body);
    if (items === null) throw new Error(googleMessages.failed);
    calendars.push(...calendarsFrom({ items }));
    pageToken = nextPageToken(body);
    if (pageToken === "") break;
  }
  return calendars;
}

/**
 * Every event in the window for one calendar, following `nextPageToken` to the
 * last page. The items are returned as Google sent them: the mapper, not this
 * function, decides what an item means, and an item it cannot use is counted
 * as unusable there instead of disappearing here. A read that stops at the page
 * cap returns `truncated`, so the preview can say the count is not the whole
 * window.
 */
export async function listEvents(
  token: string,
  calendarId: string,
  window: EventWindow,
  options: RequestOptions = {},
): Promise<EventList> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const events: GcalEvent[] = [];
  let pageToken = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await getJson(eventsUrl(calendarId, { ...window, pageToken }), token, fetchImpl);
    // A body whose `items` is not a list holds no readable events. It is not a
    // silent empty page: the sheet says the read failed, and nothing is imported
    // from a shape the mapper was never designed to read.
    const items = pageItems(body);
    if (items === null) throw new Error(googleMessages.failed);
    events.push(...(items as GcalEvent[]));
    pageToken = nextPageToken(body);
    if (pageToken === "") return { events, truncated: false };
  }
  // The loop ran out of pages, not the token: there may be more events than we
  // read, so the caller can say what the count above does not include.
  return { events, truncated: true };
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
  /** Hands one access token back before its hour is up. */
  revoke?: (token: string, done?: () => void) => void;
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
 * next click retries instead of remembering a transient network failure, and a
 * load that never answers is abandoned after `GIS_LOAD_TIMEOUT_MS` so the sheet
 * never sits on "connecting" forever.
 */
export function loadGis(): Promise<OAuth2> {
  const ready = gisApi();
  if (ready !== null) return Promise.resolve(ready);
  if (loading !== null) return loading;
  loading = withTimeout(new Promise<OAuth2>((resolve, reject) => {
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
  }), GIS_LOAD_TIMEOUT_MS, googleMessages.unavailable).catch(cause => {
    loading = null;
    throw cause;
  });
  return loading;
}

/**
 * Hands an access token back to Google when the sheet closes after using it, so
 * the roughly one hour of residual validity is cut short. The token is already
 * memory-only; this narrows the window rather than changing the model. A
 * browser that never loaded GIS has nothing to revoke, which is not a failure.
 */
export function revokeToken(token: string): void {
  if (isTauri()) {
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("google_oauth_revoke", { token }))
      .catch(() => undefined);
    return;
  }
  try {
    gisApi()?.revoke?.(token);
  } catch {
    // Revocation is best effort: the token has already been dropped from memory.
  }
}

/**
 * Abandons a sign-in in progress when the sheet closes: the desktop shell stops
 * listening on its loopback port at once. A no-op in a browser.
 */
export function cancelSignIn(): void {
  if (!isTauri()) return;
  void import("@tauri-apps/api/core").then(({ invoke }) => invoke("google_oauth_cancel")).catch(() => undefined);
}

/**
 * What to do with a token that arrived: keep it while the sheet is still open,
 * otherwise hand it back to Google and drop it, so a sheet closed mid-sign-in
 * leaves no live token behind. Returns whether the token was kept.
 */
export function keepTokenIfLive(token: string, live: boolean, revoke: (token: string) => void = revokeToken): boolean {
  if (live) return true;
  revoke(token);
  return false;
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
  if (isTauri()) return requestDesktopToken();
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

/**
 * The desktop shell's token: Rust opens the system browser, runs the PKCE flow
 * and returns only the access token and its lifetime. The token stays in the
 * caller's memory, like the GIS one; Rust never stores it.
 */
async function requestDesktopToken(): Promise<string> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const token = desktopTokenFrom(await invoke("google_oauth_start"));
    if (token === null) throw "failed";
    return token;
  } catch (cause) {
    throw new Error(desktopAuthMessage(cause));
  }
}
