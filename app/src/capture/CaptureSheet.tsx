import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useState } from "react";
import { AnimatePresence } from "motion/react";
import { getKeyStatus } from "../chat/keyStore.ts";
import { createChatTask } from "../data/chatMove.ts";
import { db } from "../data/client.ts";
import { isTauri } from "../desktop.ts";
import { t } from "../i18n/index.ts";
import { captureImpact, type CaptureImpact } from "../planning/captureImpact.ts";
import type { PlanningBlock, PlanningSeries, PlanningTask } from "../planning/capacity.ts";
import type { WorkWindow } from "../planning/window.ts";
import { completedSamples, type TrackedTask } from "../ui/BiasHint.tsx";
import { CloseIcon } from "../ui/icons.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { dateKey } from "../ui/time.ts";
import { CaptureCard } from "./CaptureCard.tsx";
import { captureMockScenario, createCaptureMock } from "./captureMock.ts";
import {
  assistantHost,
  cardsReducer,
  draftToCandidate,
  draftToCreate,
  emptyCards,
  isSimilarTitle,
  noteFor,
  openIndexes,
  tally,
  type Draft,
} from "./captureView.ts";
import { MAX_CAPTURE_TITLE_CHARS, type CaptureProposal } from "./schema.ts";
import { MAX_CAPTURE_CHARS } from "./prompt.ts";
import { useCapture } from "./useCapture.ts";
import "./CaptureSheet.css";

export type CaptureSheetProps = {
  open: boolean;
  onClose: () => void;
  /** Pre-fills the paste area (paste-anywhere); nothing is sent until Find tasks. */
  initialText?: string;
  /** The control the sheet grows from; the page when absent. */
  origin?: HTMLElement | null;
  /** The signed-in user; without one, cards can be read but not added. */
  uid: string | null;
  timeZone: string;
  /** The stored tasks: the radar reads their deadlines, the bias lesson the finished ones. */
  tasks: ReadonlyArray<PlanningTask & TrackedTask>;
  blocks: readonly PlanningBlock[];
  series: readonly PlanningSeries[];
  completions: Record<string, string>;
  workWindow: WorkWindow;
  /** Opens Settings on the assistant's key; the no-key invite shows it. */
  onSetupKey?: () => void;
};

/**
 * The capture sheet (Ronda 8, S3, plan §2/§5): paste anything, read it, review
 * what was found, and add what you want. It is the shared glass `Sheet`; the
 * owner mounts it with `open` and the sheet animates itself in and out.
 */
export function CaptureSheet({ open, ...rest }: CaptureSheetProps) {
  return <AnimatePresence>{open && <CaptureBody key="capture" {...rest} />}</AnimatePresence>;
}

type Availability = { kind: "unknown" } | { kind: "web" } | { kind: "nokey" } | { kind: "key"; host: string | null };

/** Whether the assistant could read a paste here: desktop with a key, desktop
 * without one, or the web build. Shown before the first read, so the consent
 * line and the invite are honest about who reads the text. */
function useAvailability(): Availability {
  const [availability, setAvailability] = useState<Availability>({ kind: "unknown" });
  useEffect(() => {
    let live = true;
    const set = (next: Availability) => {
      if (live) setAvailability(next);
    };
    const dev = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;
    const scenario = dev ? captureMockScenario(new URLSearchParams(window.location.search).get("captureMock")) : null;
    if (scenario !== null) {
      void createCaptureMock(scenario)
        .hasKey()
        .then(has => set(has ? { kind: "key", host: null } : { kind: "nokey" }), () => undefined);
    } else if (isTauri()) {
      void getKeyStatus().then(
        status => set(status.hasKey ? { kind: "key", host: assistantHost(status.baseUrl) } : { kind: "nokey" }),
        () => undefined,
      );
    } else {
      set({ kind: "web" });
    }
    return () => {
      live = false;
    };
  }, []);
  return availability;
}

/** The first non-empty line of a paste, as a one-task fallback title. */
function firstLineTitle(text: string): string {
  const line = text.split(/\r?\n/).find(entry => entry.trim() !== "") ?? "";
  return line.replace(/\s+/g, " ").trim().slice(0, MAX_CAPTURE_TITLE_CHARS);
}

function CaptureBody({
  onClose,
  initialText = "",
  origin = null,
  uid,
  timeZone,
  tasks,
  blocks,
  series,
  completions,
  workWindow,
  onSetupKey,
}: Omit<CaptureSheetProps, "open">) {
  const capture = useCapture({ timeZone });
  const availability = useAvailability();
  const [text, setText] = useState(initialText);
  const [cards, dispatch] = useReducer(cardsReducer, emptyCards);
  const run = capture.state;
  const reading = run.phase === "reading";
  const result = run.phase === "proposals" ? run : null;

  // The cards follow the run: cleared while a read is in flight, loaded when
  // the answer lands. A layout effect, so no frame paints the old list.
  useLayoutEffect(() => {
    if (run.phase === "proposals") dispatch({ type: "load", requestId: run.requestId, proposals: run.tasks });
    else dispatch({ type: "clear" });
  }, [run]);

  const now = useMemo(() => new Date(), [run]);
  const todayKey = dateKey(now, timeZone);
  const samples = useMemo(() => completedSamples(tasks), [tasks]);

  /** The radar for a draft; `extra` are blocks an Add all has just placed. */
  const impactFor = useCallback(
    (draft: Draft, extra: readonly PlanningBlock[] = []): CaptureImpact | null =>
      captureImpact(
        { now, timeZone, workWindow, tasks, blocks: extra.length > 0 ? [...blocks, ...extra] : blocks, series, completions, samples },
        draftToCandidate(draft),
      ),
    [now, timeZone, workWindow, tasks, blocks, series, completions, samples],
  );

  const write = async (index: number, extra: readonly PlanningBlock[]): Promise<PlanningBlock | null> => {
    const card = cards.cards[index];
    if (uid === null || card === undefined || card.status !== "open") return null;
    dispatch({ type: "saving", index });
    try {
      const create = draftToCreate(card.draft, impactFor(card.draft, extra)?.slot ?? null, timeZone);
      await createChatTask(uid, create, db);
      dispatch({ type: "added", index });
      return create.block ?? null;
    } catch (cause) {
      dispatch({ type: "failed", index, message: cause instanceof Error ? cause.message : t("app.sheet.error") });
      return null;
    }
  };

  const addAll = async () => {
    // Each write sees the blocks the batch has already placed, so two cards
    // never claim the same free slot.
    const placed: PlanningBlock[] = [];
    for (const index of openIndexes(cards)) {
      const block = await write(index, placed);
      if (block !== null) placed.push(block);
    }
  };

  const read = () => {
    if (text.trim() !== "" && !reading) capture.read(text);
  };

  const addAsOne = () => {
    if (result === null) return;
    const proposal: CaptureProposal = {
      title: firstLineTitle(text),
      dueDay: null,
      startMinutes: null,
      estimateMinutes: null,
      quote: null,
      dateIgnored: false,
    };
    dispatch({ type: "load", requestId: `${result.requestId}:one`, proposals: [proposal] });
    dispatch({ type: "toggleEdit", index: 0 });
  };

  const note = result ? noteFor(result.source, result.reason) : null;
  const counts = tally(cards);
  const open = openIndexes(cards).length;
  const visible = result !== null && cards.requestId?.startsWith(result.requestId) === true;
  const empty = visible && cards.cards.length === 0 && result?.tasks.length === 0;
  const consent =
    availability.kind === "key"
      ? availability.host === null
        ? t("capture.consentGeneric")
        : t("capture.consent", { host: availability.host })
      : null;
  const invite =
    availability.kind === "web"
      ? t("capture.web")
      : availability.kind === "nokey"
        ? t("capture.note.noKey")
        : null;
  // A device result already says why; the same sentence is not printed twice.
  const lead = invite !== null && note !== null ? null : invite;

  return (
    <Sheet label={t("capture.title")} className="capture-sheet" origin={origin} onClose={onClose}>
      <div className="sheet-form">
        <header className="sheet-head">
          <span className="sheet-kind">{t("capture.title")}</span>
          <button type="button" className="icon-button" aria-label={t("capture.close")} onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <label className="sr-only" htmlFor="capture-text">{t("capture.textLabel")}</label>
        <textarea
          id="capture-text"
          className="capture-text"
          rows={5}
          autoFocus
          spellCheck={false}
          placeholder={t("capture.placeholder")}
          value={text}
          readOnly={reading}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              read();
            }
          }}
        />

        <div className="capture-bar">
          <p className="capture-meta">
            {consent !== null && <span>{consent} </span>}
            <span className="capture-count">{t("capture.chars", { count: text.length })}</span>
          </p>
          {reading ? (
            <button type="button" className="button" onClick={capture.cancel}>{t("capture.stop")}</button>
          ) : (
            <button type="button" className="button button-accent" disabled={text.trim() === ""} onClick={read}>
              {t("capture.read")}
            </button>
          )}
        </div>

        {lead !== null && !reading && (
          <p className="sheet-note capture-invite">
            {lead}{" "}
            {availability.kind === "nokey" && onSetupKey !== undefined && (
              <button type="button" className="link-button" onClick={onSetupKey}>{t("capture.setup")}</button>
            )}
          </p>
        )}

        <p className="capture-status" role="status" aria-live="polite">{reading ? t("capture.reading") : ""}</p>

        {visible && result !== null && (
          <section className="capture-results" aria-label={t("capture.found", { count: result.tasks.length })}>
            {note !== null && (
              <p className="capture-note">
                {t(note.key)}{" "}
                {note.action === "settings" && onSetupKey !== undefined && (
                  <button type="button" className="link-button" onClick={onSetupKey}>{t("capture.settings")}</button>
                )}
                {note.action === "retry" && (
                  <button type="button" className="link-button" onClick={read}>{t("capture.retry")}</button>
                )}
              </p>
            )}
            {result.truncated && <p className="sheet-note">{t("capture.truncated", { count: MAX_CAPTURE_CHARS })}</p>}

            {empty ? (
              <div className="capture-empty">
                <p>{t("capture.empty")}</p>
                <button type="button" className="button small" onClick={addAsOne}>{t("capture.emptyAdd")}</button>
              </div>
            ) : (
              <>
                <div className="capture-results-head">
                  <p className="capture-found">
                    {counts.open === 0 && counts.added > 0 ? t("capture.added", { count: counts.added }) : t("capture.found", { count: cards.cards.length })}
                    <span className="capture-provenance">
                      {" · "}
                      {result.source === "assistant" ? t("capture.provenance.assistant") : t("capture.provenance.device")}
                    </span>
                  </p>
                  {open > 1 && (
                    <button type="button" className="button small button-accent" disabled={uid === null} onClick={() => void addAll()}>
                      {t("capture.addAll", { count: open })}
                    </button>
                  )}
                  {counts.open === 0 && counts.added > 0 && (
                    <button type="button" className="button small button-accent" onClick={onClose}>{t("capture.done")}</button>
                  )}
                </div>
                {uid === null && <p className="sheet-note">{t("capture.needsSession")}</p>}
                {result.capped && <p className="sheet-note">{t("capture.capped", { count: cards.cards.length })}</p>}
                <ul className="capture-list">
                  {cards.cards.map((card, index) => {
                    const proposal = result.tasks[index] ?? {
                      title: card.draft.title,
                      dueDay: null,
                      startMinutes: null,
                      estimateMinutes: null,
                      quote: null,
                      dateIgnored: false,
                    };
                    return (
                      <CaptureCard
                        key={index}
                        index={index}
                        card={card}
                        proposal={proposal}
                        impact={impactFor(card.draft)}
                        similar={isSimilarTitle(card.draft.title, tasks)}
                        todayKey={todayKey}
                        canAdd={uid !== null}
                        onEdit={patch => dispatch({ type: "edit", index, patch })}
                        onToggleEdit={() => dispatch({ type: "toggleEdit", index })}
                        onAdd={() => void write(index, [])}
                        onDiscard={() => dispatch({ type: "discard", index })}
                      />
                    );
                  })}
                </ul>
              </>
            )}
          </section>
        )}
      </div>
    </Sheet>
  );
}
