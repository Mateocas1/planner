import { useState } from "react";
import { setHolidayHidden, setHolidayKindOverride } from "../data/holidays.ts";
import { effectiveKind, HOLIDAY_KINDS, type Holiday, type HolidayKind } from "../domain/holidays.ts";
import { t } from "../i18n/index.ts";
import { formatDateKey } from "./format.ts";
import { CloseIcon } from "./icons.tsx";
import { Sheet } from "./Sheet.tsx";
import type { UndoableDelete } from "./UndoToast.tsx";
import "./Holidays.css";

/**
 * Holiday labels (S11). A holiday is information about a day, never work: the
 * calendar shows it on the Due row and nothing in planning reads it. Pressing a
 * label opens a small sheet where the user decides what the day is (Argentina
 * sometimes works a "día no laborable"), or hides it.
 */

/** How each kind reads on screen, in the current language. */
function kindLabel(kind: HolidayKind): string {
  return t(`holiday.kind.${kind}`);
}

/** The holidays of one day that the user has not hidden. */
export function visibleHolidays(holidays: Holiday[], date: string): Holiday[] {
  return holidays.filter(holiday => holiday.date === date && holiday.hidden !== true);
}

export function HolidayChips({ holidays, onOpen }: { holidays: Holiday[]; onOpen: (holiday: Holiday, origin: HTMLElement) => void }) {
  return (
    <>
      {holidays.map(holiday => {
        const kind = effectiveKind(holiday);
        return (
          <button
            key={holiday.id}
            type="button"
            className={`holiday-chip is-${kind}`}
            title={t("holiday.chip.title", { title: holiday.title, kind: kindLabel(kind) })}
            aria-label={t("holiday.chip.aria", { title: holiday.title, kind: kindLabel(kind) })}
            onClick={event => onOpen(holiday, event.currentTarget)}
          >
            <span>{holiday.title}</span>
          </button>
        );
      })}
    </>
  );
}

export function HolidaySheet({
  uid,
  holiday,
  todayKey,
  origin,
  onClose,
  onOfferUndo,
}: {
  uid: string;
  holiday: Holiday;
  todayKey: string;
  origin: HTMLElement | null;
  onClose: () => void;
  onOfferUndo: (item: UndoableDelete) => void;
}) {
  const [error, setError] = useState("");
  const current = effectiveKind(holiday);

  /** Choosing the kind Google's wording already gave clears the override. */
  async function choose(kind: HolidayKind) {
    setError("");
    try {
      await setHolidayKindOverride(uid, holiday.id, kind === holiday.kind ? undefined : kind);
    } catch {
      setError(t("holiday.error.save"));
    }
  }

  async function hide() {
    setError("");
    try {
      await setHolidayHidden(uid, holiday.id, true);
      onOfferUndo({
        message: t("holiday.hidden"),
        restore: () => setHolidayHidden(uid, holiday.id, false),
      });
      onClose();
    } catch {
      setError(t("holiday.error.hide"));
    }
  }

  return (
    <Sheet label={t("holiday.label")} className="holiday-sheet" origin={origin} onClose={onClose}>
      <div className="sheet-form">
        <header className="sheet-head">
          <span className="sheet-kind">{t("holiday.label")}</span>
          <button type="button" className="icon-button" aria-label={t("shortcuts.close")} onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <h3 className="sheet-title">{holiday.title}</h3>
        <p className="holiday-sheet-date">{formatDateKey(holiday.date, todayKey)}</p>
        <fieldset className="holiday-kinds">
          <legend className="sheet-section-title">{t("holiday.whatIsDay")}</legend>
          <div className="segmented" role="group" aria-label={t("holiday.kindGroup")}>
            {HOLIDAY_KINDS.map(kind => (
              <button key={kind} type="button" aria-pressed={current === kind} onClick={() => void choose(kind)}>
                {kindLabel(kind)}
              </button>
            ))}
          </div>
        </fieldset>
        <p className="gcal-note">{t("holiday.labelsOnly")}</p>
        {error !== "" && <p className="inline-error" role="alert">{error}</p>}
        <div className="holiday-actions">
          <button type="button" className="button" onClick={() => void hide()}>{t("holiday.hide")}</button>
        </div>
      </div>
    </Sheet>
  );
}
