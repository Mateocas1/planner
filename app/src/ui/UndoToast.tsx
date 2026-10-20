import { useCallback, useEffect, useState } from "react";
import { CloseIcon } from "./icons.tsx";
import "./UndoToast.css";

/** How long the undo offer stays up before it dismisses itself. */
export const undoToastMs = 5000;

/** The exit transition in UndoToast.css; the node leaves the DOM after it. */
export const undoToastExitMs = 160;

/** A delete the user can still take back: the sentence to show, and the write
 * that puts the item back exactly as it was. */
export type UndoableDelete = {
  message: string;
  restore: () => Promise<void>;
};

/** The one offer the shell is currently showing, keyed so a new delete
 * replaces the previous toast instead of stacking a second one. */
export type PendingUndo = UndoableDelete & { id: number };

/**
 * The undo toast (DESIGN.md §3, chrome): one sentence and one action pinned
 * above the content after a delete. It never takes focus, it is announced
 * through a polite status region, and Escape or its close control dismisses it
 * early. Motion is a CSS transition — 200 ms in, 160 ms out — on opacity and a
 * short rise; with reduced motion only the opacity fades.
 *
 * Undo restores the item through the data layer (see restoreTask,
 * restoreBlock, restoreSeries). The delete itself is already applied when the
 * toast appears, so the offer is a compensating write under the original id,
 * not a deferred one.
 */
export function UndoToast({
  item,
  onDismiss,
  onError,
}: {
  item: PendingUndo;
  onDismiss: () => void;
  onError: (message: string) => void;
}) {
  // Closing keeps the node mounted for the exit transition, so the toast fades
  // out instead of vanishing; the owner unmounts it when the beat has passed.
  const [closing, setClosing] = useState(false);
  const dismiss = useCallback(() => setClosing(true), []);

  useEffect(() => {
    if (!closing) return;
    const id = window.setTimeout(onDismiss, undoToastExitMs);
    return () => window.clearTimeout(id);
  }, [closing, onDismiss]);

  // One offer, one deadline. The countdown stops as soon as it starts to go.
  useEffect(() => {
    if (closing) return;
    const id = window.setTimeout(dismiss, undoToastMs);
    return () => window.clearTimeout(id);
  }, [closing, dismiss]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dismiss]);

  // Undo dismisses first: the offer is spent whether or not the write lands,
  // and a failure is reported through the shell's error line, not by leaving a
  // button that promises something it could not do.
  const undo = () => {
    dismiss();
    void item.restore().catch(cause => {
      onError(cause instanceof Error ? cause.message : "The item could not be restored.");
    });
  };

  return (
    <div className="undo-toast" role="status" data-state={closing ? "closing" : "open"}>
      <span className="undo-toast-label">
        {item.message}
        <span className="undo-toast-separator" aria-hidden="true"> · </span>
      </span>
      <button type="button" className="undo-toast-action" onClick={undo}>Undo</button>
      <button type="button" className="undo-toast-close" aria-label="Dismiss" onClick={dismiss}>
        <CloseIcon />
      </button>
    </div>
  );
}
