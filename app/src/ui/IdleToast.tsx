import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n/index.ts";
import { CloseIcon } from "./icons.tsx";
import type { IdlePrompt } from "./useIdleAway.ts";
import "./IdleToast.css";

/**
 * The idle-away prompt: one non-blocking offer pinned to
 * the bottom of the shell after the user comes back from an away span during
 * a focus session. It reuses the undo toast's shape and material — one
 * sentence, actions inside a dark glass pill — with two differences that the
 * decision's weight justifies:
 *
 * - It does not dismiss itself. An away decision rushed off screen by a
 *   timeout would either write minutes nobody confirmed or silently discard a
 *   correction the user wanted; it stays until Subtract, Keep or its close
 *   control answers it. Escape counts as Keep (no write), like every
 *   non-modal surface here.
 * - The primary action is the quiet one. Subtract writes `actualMinutes`, so
 *   it is styled as the destructive-adjacent choice it is: visible, but not
 *   the accent button.
 *
 * Motion is the undo toast's transition on opacity and a short rise, opacity
 * only under reduced motion. The node never animates layout.
 */
export function IdleToast({
  prompt,
  onSubtract,
  onKeep,
}: {
  prompt: IdlePrompt;
  onSubtract: () => void;
  onKeep: () => void;
}) {
  const [answering, setAnswering] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onKeep();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onKeep]);

  // The first press spends the offer immediately, so a double click cannot
  // reach the write path twice; the applied ledger in domain/idle.ts is the
  // durable guarantee behind it.
  const subtract = useCallback(() => {
    if (answering) return;
    setAnswering(true);
    onSubtract();
  }, [answering, onSubtract]);

  return (
    <div className="undo-toast idle-toast" role="status" data-state="open">
      <span className="undo-toast-label">{t("idle.away", { minutes: prompt.minutes })}</span>
      <button type="button" className="undo-toast-action idle-toast-subtract" onClick={subtract} disabled={answering}>
        {t("idle.subtract")}
      </button>
      <button type="button" className="undo-toast-action idle-toast-keep" onClick={onKeep} disabled={answering}>
        {t("idle.keep")}
      </button>
      <button type="button" className="undo-toast-close" aria-label={t("idle.dismiss")} onClick={onKeep}>
        <CloseIcon />
      </button>
    </div>
  );
}
