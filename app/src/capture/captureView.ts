/**
 * The capture sheet's pure side (Ronda 8, S3, plan §2 and §5): what each
 * proposal card holds while the user edits it, the card list's state machine,
 * the note that explains a fallback, and the translation of a confirmed card
 * into the `ChatCreate` the existing write path takes. No DOM, no React, no
 * Firebase: the sheet (`CaptureSheet.tsx`) only renders what this decides.
 *
 * Nothing here writes. A card becomes a task only when the user presses Add (or
 * Add all), and then through `createChatTask`, the same atomic path the chat's
 * Confirm uses.
 */

import type { ChatCreate } from "../data/chatMove.ts";
import type { CaptureCandidate, CaptureSlot } from "../planning/captureImpact.ts";
import { dayMs, keyToWallUtc, localValue, toZonedInstant, wallDayKey } from "../ui/time.ts";
import type { CaptureFallbackReason } from "./captureMachine.ts";
import type { CaptureProposal } from "./schema.ts";

/* ---------- provenance ---------- */

/** The host the key is bound to, for "Sent to {host}"; null when unknown. */
export function assistantHost(baseUrl: string | null): string | null {
  if (baseUrl === null) return null;
  try {
    return new URL(baseUrl).host || null;
  } catch {
    return null;
  }
}

export type CaptureNote = {
  key:
    | "capture.note.web"
    | "capture.note.noKey"
    | "capture.note.unauthorized"
    | "capture.note.rateLimited"
    | "capture.note.offline"
    | "capture.note.provider"
    | "chat.error.credentialStoreUnavailable";
  /** The way forward the note offers beside the cards. */
  action: "settings" | "retry" | null;
};

/** Why the device answered, in words, and what the user can do about it. The
 * assistant's own answer needs no note. */
export function noteFor(source: "assistant" | "device", reason: CaptureFallbackReason | null): CaptureNote | null {
  if (source === "assistant" || reason === null) return null;
  switch (reason) {
    case "web":
      return { key: "capture.note.web", action: null };
    case "no_key":
      return { key: "capture.note.noKey", action: "settings" };
    case "unauthorized":
      return { key: "capture.note.unauthorized", action: "settings" };
    case "rate_limited":
      return { key: "capture.note.rateLimited", action: "retry" };
    case "credential_store_unavailable":
      return { key: "chat.error.credentialStoreUnavailable", action: "retry" };
    case "offline":
      return { key: "capture.note.offline", action: "retry" };
    case "network":
    case "provider":
    case "timeout":
    case "unparseable":
      return { key: "capture.note.provider", action: "retry" };
  }
}

/* ---------- drafts ---------- */

/** One card's editable fields. The estimate is bare digits (or "" for "no
 * estimate", which planning reads as the 60-minute assumption) so it feeds
 * `EstimateControl` as it is; the due day is a date key or "". */
export type Draft = {
  title: string;
  dueDay: string;
  estimate: string;
  /** Minutes after midnight the text named, if any. */
  startMinutes: number | null;
  /** Place the task on the due day's schedule at the radar's free slot. */
  block: boolean;
};

/** The draft a proposal opens as: a block only when the text named a time. */
export function draftOf(proposal: CaptureProposal): Draft {
  return {
    title: proposal.title,
    dueDay: proposal.dueDay ?? "",
    estimate: proposal.estimateMinutes === null ? "" : String(proposal.estimateMinutes),
    startMinutes: proposal.startMinutes,
    block: proposal.startMinutes !== null && proposal.dueDay !== null,
  };
}

function estimateOf(draft: Draft): number | null {
  if (draft.estimate === "") return null;
  const minutes = Number(draft.estimate);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

/** The radar's view of a draft. */
export function draftToCandidate(draft: Draft): CaptureCandidate {
  return {
    title: draft.title.trim(),
    dueDay: draft.dueDay === "" ? null : draft.dueDay,
    estimateMinutes: estimateOf(draft),
    startMinutes: draft.startMinutes,
  };
}

/** The wall clock `minutes` after midnight of `day`, rolling past 24:00 onto
 * the next day (a block may end exactly at midnight). */
function wallInstant(day: string, minutes: number, timeZone: string): string {
  const rolled = minutes >= 1440;
  const key = rolled ? wallDayKey(keyToWallUtc(day) + dayMs) : day;
  return toZonedInstant(localValue(key, rolled ? minutes - 1440 : minutes), timeZone);
}

/**
 * The write a confirmed card makes: title, deadline and estimate always; a
 * work block only when the user chose one and the radar found a slot for it.
 * The domain builder validates the rest, so a bad draft throws before any
 * write exists and the card shows the message.
 */
export function draftToCreate(draft: Draft, slot: CaptureSlot | null, timeZone: string): ChatCreate {
  const estimate = estimateOf(draft);
  const block =
    draft.block && draft.dueDay !== "" && slot !== null
      ? {
          start: wallInstant(draft.dueDay, slot.startMinutes, timeZone),
          end: wallInstant(draft.dueDay, slot.endMinutes, timeZone),
        }
      : undefined;
  return {
    title: draft.title.trim(),
    ...(draft.dueDay === "" ? {} : { deadline: draft.dueDay }),
    ...(estimate === null ? {} : { estimateMinutes: estimate }),
    ...(block === undefined ? {} : { block }),
  };
}

/* ---------- similar ---------- */

function normalizeTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** True when an open task already carries this title (case, accents and
 * punctuation aside), so the card can say so before a duplicate is made. */
export function isSimilarTitle(title: string, tasks: ReadonlyArray<{ title: string; completed?: boolean }>): boolean {
  const wanted = normalizeTitle(title);
  if (wanted === "") return false;
  return tasks.some(task => task.completed !== true && normalizeTitle(task.title) === wanted);
}

/* ---------- cards ---------- */

export type CardStatus = "open" | "saving" | "added" | "discarded";

export type Card = {
  status: CardStatus;
  /** The edit form is expanded in place. */
  editing: boolean;
  /** The last write's failure, shown on the card; the card stays open. */
  error: string | null;
  draft: Draft;
};

export type Cards = {
  /** The run these cards came from; a new run replaces them. */
  requestId: string | null;
  cards: Card[];
};

export const emptyCards: Cards = { requestId: null, cards: [] };

export type CardsAction =
  | { type: "clear" }
  | { type: "load"; requestId: string; proposals: readonly CaptureProposal[] }
  | { type: "edit"; index: number; patch: Partial<Draft> }
  | { type: "toggleEdit"; index: number }
  | { type: "saving"; index: number }
  | { type: "added"; index: number }
  | { type: "failed"; index: number; message: string }
  | { type: "discard"; index: number };

function withCard(state: Cards, index: number, change: (card: Card) => Card | null): Cards {
  const card = state.cards[index];
  if (card === undefined) return state;
  const next = change(card);
  if (next === null) return state;
  return { ...state, cards: state.cards.map((entry, at) => (at === index ? next : entry)) };
}

export function cardsReducer(state: Cards, action: CardsAction): Cards {
  switch (action.type) {
    case "clear":
      return state.cards.length === 0 && state.requestId === null ? state : emptyCards;
    case "load":
      if (state.requestId === action.requestId) return state;
      return {
        requestId: action.requestId,
        cards: action.proposals.map(proposal => ({ status: "open", editing: false, error: null, draft: draftOf(proposal) })),
      };
    case "edit":
      return withCard(state, action.index, card =>
        card.status === "open" ? { ...card, draft: { ...card.draft, ...action.patch } } : null,
      );
    case "toggleEdit":
      return withCard(state, action.index, card => (card.status === "open" ? { ...card, editing: !card.editing } : null));
    case "saving":
      return withCard(state, action.index, card => (card.status === "open" ? { ...card, status: "saving", error: null } : null));
    case "added":
      return withCard(state, action.index, card =>
        card.status === "open" || card.status === "saving" ? { ...card, status: "added", editing: false, error: null } : null,
      );
    case "failed":
      return withCard(state, action.index, card => (card.status === "saving" ? { ...card, status: "open", error: action.message } : null));
    case "discard":
      return withCard(state, action.index, card => (card.status === "open" ? { ...card, status: "discarded", editing: false } : null));
  }
}

/** The cards Add all would write: open, and not already being saved. */
export function openIndexes(state: Cards): number[] {
  return state.cards.flatMap((card, index) => (card.status === "open" ? [index] : []));
}

export function tally(state: Cards): { open: number; added: number; discarded: number } {
  let open = 0;
  let added = 0;
  let discarded = 0;
  for (const card of state.cards) {
    if (card.status === "added") added += 1;
    else if (card.status === "discarded") discarded += 1;
    else open += 1;
  }
  return { open, added, discarded };
}
