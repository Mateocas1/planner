import assert from "node:assert/strict";
import test from "node:test";
import type { CaptureProposal } from "./schema.ts";
import {
  assistantHost,
  cardsReducer,
  draftOf,
  draftToCandidate,
  draftToCreate,
  emptyCards,
  isSimilarTitle,
  noteFor,
  openIndexes,
  tally,
} from "./captureView.ts";

const zone = "America/Argentina/Buenos_Aires";

const proposal = (over: Partial<CaptureProposal> = {}): CaptureProposal => ({
  title: "Send the Q3 budget to Lucía",
  dueDay: "2026-11-14",
  startMinutes: null,
  estimateMinutes: 45,
  quote: "send the Q3 budget",
  dateIgnored: false,
  ...over,
});

/* ---------- host ---------- */

test("assistantHost names the host of the key's base URL, and nothing else", () => {
  assert.equal(assistantHost("https://api.nan.builders/v1"), "api.nan.builders");
  assert.equal(assistantHost("http://localhost:8080/v1"), "localhost:8080");
  assert.equal(assistantHost(null), null);
  assert.equal(assistantHost("not a url"), null);
});

/* ---------- notes ---------- */

test("the assistant's answer carries no note", () => {
  assert.equal(noteFor("assistant", null), null);
});

test("every fallback reason has its own copy and a way forward", () => {
  assert.deepEqual(noteFor("device", "web"), { key: "capture.note.web", action: null });
  assert.deepEqual(noteFor("device", "no_key"), { key: "capture.note.noKey", action: "settings" });
  assert.deepEqual(noteFor("device", "unauthorized"), { key: "capture.note.unauthorized", action: "settings" });
  assert.deepEqual(noteFor("device", "rate_limited"), { key: "capture.note.rateLimited", action: "retry" });
  assert.deepEqual(noteFor("device", "credential_store_unavailable"), { key: "chat.error.credentialStoreUnavailable", action: "retry" });
  assert.deepEqual(noteFor("device", "offline"), { key: "capture.note.offline", action: "retry" });
  for (const reason of ["network", "provider", "timeout", "unparseable"] as const) {
    assert.deepEqual(noteFor("device", reason), { key: "capture.note.provider", action: "retry" }, reason);
  }
  assert.deepEqual(noteFor("device", null), null);
});

/* ---------- drafts ---------- */

test("a draft starts from the proposal; a block starts only when the text named a time", () => {
  assert.deepEqual(draftOf(proposal()), {
    title: "Send the Q3 budget to Lucía",
    dueDay: "2026-11-14",
    estimate: "45",
    startMinutes: null,
    block: false,
  });
  const timed = draftOf(proposal({ startMinutes: 600 }));
  assert.equal(timed.block, true);
  assert.equal(timed.startMinutes, 600);
  const bare = draftOf(proposal({ dueDay: null, estimateMinutes: null }));
  assert.equal(bare.dueDay, "");
  assert.equal(bare.estimate, "");
  assert.equal(bare.block, false);
});

test("the radar candidate reads the draft's edited fields", () => {
  const draft = { ...draftOf(proposal({ startMinutes: 600 })), dueDay: "2026-11-15", estimate: "90" };
  assert.deepEqual(draftToCandidate(draft), {
    title: "Send the Q3 budget to Lucía",
    dueDay: "2026-11-15",
    estimateMinutes: 90,
    startMinutes: 600,
  });
  assert.deepEqual(draftToCandidate({ ...draft, dueDay: "", estimate: "" }), {
    title: "Send the Q3 budget to Lucía",
    dueDay: null,
    estimateMinutes: null,
    startMinutes: 600,
  });
});

test("a create carries title, deadline and estimate, and no block by default", () => {
  assert.deepEqual(draftToCreate(draftOf(proposal()), null, zone), {
    title: "Send the Q3 budget to Lucía",
    deadline: "2026-11-14",
    estimateMinutes: 45,
  });
  assert.deepEqual(draftToCreate(draftOf(proposal({ dueDay: null, estimateMinutes: null })), null, zone), {
    title: "Send the Q3 budget to Lucía",
  });
});

test("the title is trimmed and kept as the user left it otherwise", () => {
  const draft = { ...draftOf(proposal()), title: "  Budget for Lucía  " };
  assert.equal(draftToCreate(draft, null, zone).title, "Budget for Lucía");
});

test("a chosen block becomes the slot's zoned instants on the due day", () => {
  const draft = { ...draftOf(proposal()), block: true };
  const create = draftToCreate(draft, { startMinutes: 600, endMinutes: 645 }, zone);
  assert.deepEqual(create.block, { start: "2026-11-14T10:00:00-03:00", end: "2026-11-14T10:45:00-03:00" });
});

test("a block that ends at midnight ends on the next day's 00:00", () => {
  const draft = { ...draftOf(proposal({ estimateMinutes: 60 })), block: true };
  const create = draftToCreate(draft, { startMinutes: 1380, endMinutes: 1440 }, zone);
  assert.deepEqual(create.block, { start: "2026-11-14T23:00:00-03:00", end: "2026-11-15T00:00:00-03:00" });
});

test("no block without a slot, a due day or the user's choice", () => {
  const blocked = { ...draftOf(proposal()), block: true };
  assert.equal(draftToCreate(blocked, null, zone).block, undefined);
  assert.equal(draftToCreate({ ...blocked, dueDay: "" }, { startMinutes: 600, endMinutes: 645 }, zone).block, undefined);
  assert.equal(draftToCreate(draftOf(proposal()), { startMinutes: 600, endMinutes: 645 }, zone).block, undefined);
});

/* ---------- similar ---------- */

test("an open task with the same title, ignoring case, accents and punctuation, is similar", () => {
  const open = [
    { title: "Send the Q3 budget to Lucia!", completed: false },
    { title: "Water the plants", completed: true },
  ];
  assert.equal(isSimilarTitle("send the q3 budget to Lucía", open), true);
  assert.equal(isSimilarTitle("Water the plants", open), false, "completed tasks do not count");
  assert.equal(isSimilarTitle("Book the dentist", open), false);
  assert.equal(isSimilarTitle("   ", open), false);
});

/* ---------- cards ---------- */

const batch = () => cardsReducer(emptyCards, { type: "load", requestId: "r1", proposals: [proposal(), proposal({ title: "Book the dentist", dueDay: null })] });

test("loading a result creates one open card per proposal, once per request", () => {
  const state = batch();
  assert.equal(state.requestId, "r1");
  assert.deepEqual(state.cards.map(card => [card.status, card.editing, card.error]), [
    ["open", false, null],
    ["open", false, null],
  ]);
  assert.deepEqual(openIndexes(state), [0, 1]);
  assert.equal(cardsReducer(state, { type: "load", requestId: "r1", proposals: [] }), state, "the same request keeps its cards");
  assert.equal(cardsReducer(state, { type: "load", requestId: "r2", proposals: [] }).cards.length, 0, "a new request replaces them");
});

test("editing a card changes its draft and nothing else's", () => {
  let state = cardsReducer(batch(), { type: "edit", index: 0, patch: { title: "Budget", estimate: "30" } });
  assert.equal(state.cards[0]?.draft.title, "Budget");
  assert.equal(state.cards[0]?.draft.estimate, "30");
  assert.equal(state.cards[1]?.draft.title, "Book the dentist");
  state = cardsReducer(state, { type: "toggleEdit", index: 0 });
  assert.equal(state.cards[0]?.editing, true);
  state = cardsReducer(state, { type: "toggleEdit", index: 0 });
  assert.equal(state.cards[0]?.editing, false);
});

test("saving, added, failed and discard move one card; a failure keeps it open with its message", () => {
  let state = cardsReducer(batch(), { type: "saving", index: 0 });
  assert.equal(state.cards[0]?.status, "saving");
  assert.deepEqual(openIndexes(state), [1], "a card being saved is not offered to Add all again");
  state = cardsReducer(state, { type: "failed", index: 0, message: "network down" });
  assert.equal(state.cards[0]?.status, "open");
  assert.equal(state.cards[0]?.error, "network down");
  state = cardsReducer(state, { type: "saving", index: 0 });
  assert.equal(state.cards[0]?.error, null, "a new attempt clears the old error");
  state = cardsReducer(state, { type: "added", index: 0 });
  state = cardsReducer(state, { type: "discard", index: 1 });
  assert.deepEqual(state.cards.map(card => card.status), ["added", "discarded"]);
  assert.deepEqual(openIndexes(state), []);
  assert.deepEqual(tally(state), { open: 0, added: 1, discarded: 1 });
});

test("a saved or discarded card ignores later edits and saves", () => {
  let state = cardsReducer(batch(), { type: "added", index: 0 });
  const before = state;
  state = cardsReducer(state, { type: "edit", index: 0, patch: { title: "Changed" } });
  state = cardsReducer(state, { type: "saving", index: 0 });
  state = cardsReducer(state, { type: "discard", index: 0 });
  assert.equal(state, before);
  assert.equal(cardsReducer(state, { type: "discard", index: 9 }), state, "an unknown index is inert");
});

test("clear drops the cards of a finished run, and is inert when there are none", () => {
  assert.equal(cardsReducer(emptyCards, { type: "clear" }), emptyCards);
  assert.equal(cardsReducer(batch(), { type: "clear" }), emptyCards);
});
