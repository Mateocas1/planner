import type { ToolCallCard } from "../chat/conversation.ts";
import "./ChatActionCard.css";

/**
 * One proposed planner change (Ronda 3 R1, spec S1). While pending it shows
 * what will change, in plain words (computed once by the panel from the raw
 * arguments — never from unvalidated data), with Confirm and Discard. After
 * the user acts, the buttons give way to the outcome line; the state change
 * itself does not animate. Confirm/Discard disable while that card's write is
 * in flight and while a new reply streams.
 */
export function ChatActionCard({
  card,
  description,
  disabled,
  busy,
  onConfirm,
  onDiscard,
}: {
  card: ToolCallCard;
  /** Plain-words description of the change, e.g. `Create task "X" · today · 30 min`. */
  description: string;
  disabled: boolean;
  /** True while this card's confirm write is running. */
  busy: boolean;
  onConfirm: () => void;
  onDiscard: () => void;
}) {
  const resolved = card.status !== "pending";
  const outcome =
    card.outcome ??
    (card.status === "confirmed" ? "Done." : card.status === "discarded" ? "Discarded — nothing changed." : "Failed.");
  return (
    <div className="chat-card" data-status={card.status}>
      <p className="chat-card-action">{description}</p>
      {resolved ? (
        <p className="chat-card-outcome" role="status">
          {outcome}
        </p>
      ) : (
        <div className="chat-card-actions">
          <button type="button" className="chat-card-confirm" onClick={onConfirm} disabled={disabled || busy}>
            {busy ? "Working…" : "Confirm"}
          </button>
          <button type="button" className="chat-card-discard" onClick={onDiscard} disabled={disabled || busy}>
            Discard
          </button>
        </div>
      )}
    </div>
  );
}

/** The note under the cards when the answer proposed more than the cap. */
export function CallsDroppedNote({ dropped }: { dropped: number }) {
  return (
    <p className="chat-calls-note">
      Only the first 5 proposed actions in one answer can be confirmed; {dropped} {dropped === 1 ? "was" : "were"} dropped.
    </p>
  );
}
