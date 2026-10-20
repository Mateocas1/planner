import assert from "node:assert/strict";
import test from "node:test";
import {
  GOOGLE_SCOPES,
  authMessage,
  calendarsFrom,
  eventWindow,
  eventsUrl,
  listCalendars,
  listEvents,
  statusMessage,
} from "./google-client.ts";

/** A fetch stand-in: each call pops the next canned response. */
function fakeFetch(bodies: Array<{ status?: number; body: unknown }>) {
  const calls: string[] = [];
  const impl = (input: RequestInfo | URL) => {
    calls.push(String(input));
    const next = bodies.shift();
    if (!next) throw new Error("unexpected request");
    return Promise.resolve(
      new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

test("the scopes are the two read-only calendar ones and nothing else", () => {
  assert.deepEqual(GOOGLE_SCOPES.split(" "), [
    "https://www.googleapis.com/auth/calendar.events.readonly",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  ]);
});

test("the import window starts at midnight today and spans the chosen days", () => {
  assert.deepEqual(eventWindow("2026-10-20", 90, "America/Argentina/Buenos_Aires"), {
    timeMin: "2026-10-20T00:00:00-03:00",
    timeMax: "2027-01-18T00:00:00-03:00",
  });
  /* The short window ends before the long one, and both cross a month end. */
  assert.equal(eventWindow("2026-10-20", 30, "UTC").timeMax, "2026-11-19T00:00:00+00:00");
  assert.equal(eventWindow("2026-12-20", 30, "UTC").timeMax, "2027-01-19T00:00:00+00:00");
});

test("the events URL asks Google for an expanded, ordered, capped list", () => {
  const url = new URL(eventsUrl("team@group.calendar.google.com", { timeMin: "a", timeMax: "b" }));
  assert.equal(url.origin + url.pathname, "https://www.googleapis.com/calendar/v3/calendars/team%40group.calendar.google.com/events");
  assert.equal(url.searchParams.get("singleEvents"), "true");
  assert.equal(url.searchParams.get("orderBy"), "startTime");
  assert.equal(url.searchParams.get("maxResults"), "250");
  assert.equal(url.searchParams.get("timeMin"), "a");
  assert.equal(url.searchParams.get("timeMax"), "b");
  assert.equal(url.searchParams.has("pageToken"), false);
  assert.equal(new URL(eventsUrl("primary", { timeMin: "a", timeMax: "b", pageToken: "p2" })).searchParams.get("pageToken"), "p2");
});

test("a calendar list puts the primary calendar first and drops deleted ones", () => {
  const calendars = calendarsFrom({
    items: [
      { id: "team", summary: "  Team  " },
      { id: "old", summary: "Old", deleted: true },
      { id: "primary", summary: "Mateo", primary: true },
      { id: "holidays" },
    ],
  });
  /* Primary first; the rest by name, and a calendar with no summary reads as
     its id instead of an empty row. */
  assert.deepEqual(calendars, [
    { id: "primary", summary: "Mateo", primary: true },
    { id: "holidays", summary: "holidays" },
    { id: "team", summary: "Team" },
  ]);
  assert.deepEqual(calendarsFrom(null), []);
});

test("listing events follows nextPageToken to the last page", async () => {
  const { impl, calls } = fakeFetch([
    { body: { items: [{ id: "a" }, { id: "b" }], nextPageToken: "page2" } },
    { body: { items: [{ id: "c" }] } },
  ]);
  const events = await listEvents("token", "primary", { timeMin: "t1", timeMax: "t2" }, { fetchImpl: impl });
  assert.deepEqual(events.map(event => event.id), ["a", "b", "c"]);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1]).searchParams.get("pageToken"), "page2");
  assert.equal(new URL(calls[0]).searchParams.has("pageToken"), false);
});

test("listing calendars sends the bearer token and reads one page", async () => {
  const seen: Array<Record<string, string>> = [];
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), ...(init?.headers as Record<string, string>) });
    return Promise.resolve(new Response(JSON.stringify({ items: [{ id: "primary", summary: "Me", primary: true }] }), { status: 200 }));
  }) as unknown as typeof fetch;
  const calendars = await listCalendars("secret", { fetchImpl: impl });
  assert.deepEqual(calendars, [{ id: "primary", summary: "Me", primary: true }]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].Authorization, "Bearer secret");
  assert.match(seen[0].url, /\/users\/me\/calendarList/);
});

test("a failed request is reported as a calm sentence, never a status code", async () => {
  const expired = fakeFetch([{ status: 401, body: { error: { message: "Invalid Credentials" } } }]);
  await assert.rejects(
    listEvents("token", "primary", { timeMin: "t1", timeMax: "t2" }, { fetchImpl: expired.impl }),
    { message: statusMessage(401) },
  );
  assert.match(statusMessage(401), /Connect again/);
  assert.doesNotMatch(statusMessage(500), /^\d/);
  const offline = (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
  await assert.rejects(listEvents("token", "primary", { timeMin: "t1", timeMax: "t2" }, { fetchImpl: offline }), {
    message: statusMessage(0),
  });
});

test("sign-in failures name what the user can do about them", () => {
  assert.match(authMessage("popup_closed"), /closed/);
  assert.match(authMessage("popup_failed_to_open"), /pop-ups/);
  assert.match(authMessage("access_denied"), /did not authorize/);
  assert.match(authMessage(undefined), /did not authorize/);
  assert.match(authMessage("something_new"), /did not authorize/);
});
