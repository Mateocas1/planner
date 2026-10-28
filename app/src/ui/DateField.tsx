import { useMemo, useState, type KeyboardEvent, type RefObject } from "react";
import { formatDateKey } from "./format.ts";
import { CalendarIcon } from "./icons.tsx";
import { MonthGrid } from "./MonthGrid.tsx";
import { quickDates } from "./monthGrid.ts";
import { Popover } from "./Popover.tsx";
import { keyToWallUtc } from "./time.ts";
import { usePopover } from "./usePopover.ts";
import "./DateField.css";

export interface DateFieldLabels {
  today: string;
  tomorrow: string;
  thisWeekend: string;
  nextWeek: string;
  /** The empty trigger text and the row that clears the value. */
  noDate: string;
  /** The accessible name of the open popover. */
  choose: string;
  prevMonth: string;
  nextMonth: string;
}

export interface DateFieldProps {
  /** Id of the trigger, so the row's `<label htmlFor>` names it. */
  id: string;
  /** `YYYY-MM-DD` or "" for none, exactly what a `type="date"` input held. */
  value: string;
  onChange: (value: string) => void;
  /** Today's key in the profile zone (`dateKey(new Date(), timeZone)`), never the browser's midnight. */
  today: string;
  labels: DateFieldLabels;
  /** BCP 47 tag for the grid and the weekday hints. */
  locale?: string;
  /** First day of the week, 0 = Sunday. The app default is Monday. */
  weekStart?: number;
  disabled?: boolean;
}

const utc = { timeZone: "UTC" } as const;

/** "tomorrow" reads as a sentence start inside a control. */
function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

/**
 * A date as a button that shows it in words ("Tomorrow", "Fri, Oct 30") and
 * opens a popover with the quick choices and a month grid (form-controls.md
 * §6.2). It replaces `<input type="date">`, whose popup is browser UI that
 * cannot be styled or animated; the stored value is unchanged.
 *
 * The popover is the shared `Popover` primitive (top layer, Materialize
 * entrance, Escape and outside-click owned by usePopover). Choosing a day, a
 * quick row or "No date" calls `onChange`, closes it and returns focus to the
 * trigger.
 */
export function DateField({ id, value, onChange, today, labels, locale = "en-US", weekStart = 1, disabled = false }: DateFieldProps) {
  const [month, setMonth] = useState((value || today).slice(0, 7));
  // Remounts the grid on every open, so it takes focus again after a reopen.
  const [opened, setOpened] = useState(0);
  const pop = usePopover({
    initialFocus: "popover",
    onOpenChange: open => {
      if (!open) return;
      setMonth((value || today).slice(0, 7));
      setOpened(count => count + 1);
    },
  });

  const weekday = useMemo(() => new Intl.DateTimeFormat(locale, { ...utc, weekday: "short" }), [locale]);
  const rows = useMemo(() => {
    const quick = quickDates(today, weekStart);
    return [
      { key: quick.today, label: labels.today },
      { key: quick.tomorrow, label: labels.tomorrow },
      ...(quick.weekend ? [{ key: quick.weekend, label: labels.thisWeekend }] : []),
      { key: quick.nextWeek, label: labels.nextWeek },
    ];
  }, [today, weekStart, labels]);

  const choose = (next: string) => {
    onChange(next);
    pop.close();
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" || pop.open) return;
    event.preventDefault();
    pop.show();
  };

  return (
    <>
      <button
        ref={pop.triggerRef as RefObject<HTMLButtonElement | null>}
        type="button"
        id={id}
        className="form-control date-trigger"
        role="combobox"
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-controls={pop.id}
        data-value={value}
        data-empty={value === "" ? "" : undefined}
        disabled={disabled}
        onClick={pop.toggle}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="date-trigger-text">{value ? capitalize(formatDateKey(value, today)) : labels.noDate}</span>
        <CalendarIcon className="date-trigger-icon" />
      </button>
      <Popover pop={pop} label={labels.choose} className="date-pop">
        <div className="date-panel">
          <div className="date-quick">
            {rows.map(row => (
              <button
                key={row.label}
                type="button"
                className="date-row"
                aria-pressed={row.key === value}
                onClick={() => choose(row.key)}
              >
                <span>{row.label}</span>
                <span className="date-row-hint">{weekday.format(keyToWallUtc(row.key))}</span>
              </button>
            ))}
            {value !== "" && (
              <button type="button" className="date-row" onClick={() => choose("")}>
                <span>{labels.noDate}</span>
              </button>
            )}
          </div>
          <hr className="date-sep" />
          <MonthGrid
            key={opened}
            autoFocus
            locale={locale}
            weekStart={weekStart}
            value={value}
            today={today}
            month={month}
            onMonthChange={setMonth}
            onSelect={choose}
            prevLabel={labels.prevMonth}
            nextLabel={labels.nextMonth}
          />
        </div>
      </Popover>
    </>
  );
}
