import { useState } from "react";
import { DateField, type DateFieldLabels } from "./DateField.tsx";
import { setLocalDate, setLocalTime, splitLocal } from "./dateTime.ts";
import { TimeField } from "./Settings.tsx";
import "./DateTimeField.css";

export interface DateTimeFieldProps {
  /** Id of the date trigger, so the row's `<label htmlFor>` names the pair. */
  id: string;
  /** Id of the time input. */
  timeId: string;
  /** `YYYY-MM-DDTHH:mm` wall clock, or "" while nothing is chosen. */
  value: string;
  onChange: (value: string) => void;
  /** Today's key in the profile zone. */
  today: string;
  dateLabels: DateFieldLabels;
  /** The time input's accessible name, e.g. "Start time". */
  timeLabel: string;
}

/**
 * A date and a 24-hour time of day that together hold what a `datetime-local`
 * input held (form-controls.md §3.4): the `DateField` popover for the day and
 * the text `TimeField` for the clock. The time is a draft until it is
 * committed (blur or Enter); text that is not a time reverts to the last good
 * clock rather than emptying the value.
 */
export function DateTimeField({ id, timeId, value, onChange, today, dateLabels, timeLabel }: DateTimeFieldProps) {
  const { time } = splitLocal(value);
  const [draft, setDraft] = useState<string | null>(null);

  const commitTime = () => {
    if (draft === null) return;
    const next = setLocalTime(value, draft, today);
    if (next !== null) onChange(next);
    setDraft(null);
  };

  return (
    <div className="datetime-pair">
      <DateField
        id={id}
        value={splitLocal(value).date}
        onChange={date => onChange(setLocalDate(value, date))}
        today={today}
        labels={dateLabels}
        clearable={false}
      />
      <TimeField
        id={timeId}
        className="form-control block-time"
        label={timeLabel}
        value={draft ?? time}
        onChange={setDraft}
        onCommit={commitTime}
      />
    </div>
  );
}
