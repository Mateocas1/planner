import type { QuickAddFrequency, QuickAddPart } from "../domain/quickAdd.ts";
import { formatDateKey } from "./format.ts";
import "./QuickAddChips.css";

const frequencyLabels: Record<QuickAddFrequency, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

/**
 * How one recognized part reads: the deadline in the planner's own words
 * ("today", "tomorrow", "Fri, Oct 23") or the repeat in the model's. Both the
 * sheet's chips and the palette's create row print this, so the two surfaces can
 * never disagree about the same parse.
 */
export function quickAddPartLabel(part: QuickAddPart, today: string): string {
  return part.kind === "date" ? formatDateKey(part.date, today) : frequencyLabels[part.frequency];
}

/**
 * The chips under the New task title field: one per part the quick-add parser
 * recognized, in the order it appears in the text.
 *
 * A chip is a forecast, not decoration. It names exactly what will be stored --
 * the deadline day in the planner's own words, the repeat in the model's -- and
 * pressing it puts that part's text back in the title, where it stops being
 * structured and becomes ordinary words. Nothing is rewritten in the field
 * itself: the user's line stays as typed, and the chips say what the sheet made
 * of it.
 *
 * No motion: the row changes on a keystroke, and a keyboard surface gets no
 * entrance (DESIGN.md §4).
 */
export function QuickAddChips({
  parts,
  today,
  onUndo,
}: {
  parts: QuickAddPart[];
  /** The planner's day, so "today" and "tomorrow" follow the profile zone. */
  today: string;
  onUndo: (part: QuickAddPart) => void;
}) {
  if (parts.length === 0) return null;
  return (
    <ul className="quick-add-chips" aria-label="Recognized from the text" aria-live="polite">
      {parts.map(part => {
        const label = quickAddPartLabel(part, today);
        return (
          <li key={part.kind}>
            <button
              type="button"
              className="quick-add-chip"
              aria-label={`${label} — undo, keeps “${part.text}” in the title`}
              onClick={() => onUndo(part)}
            >
              <span className="quick-add-chip-label">{label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
