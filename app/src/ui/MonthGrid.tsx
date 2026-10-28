import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "./icons.tsx";
import { monthCells, shiftDay, shiftMonth, shiftYear, weekEdges } from "./monthGrid.ts";
import { keyToWallUtc } from "./time.ts";
import "./MonthGrid.css";

export interface MonthGridProps {
  /** BCP 47 tag for month, weekday and date names. */
  locale?: string;
  /** First day of the week, 0 = Sunday. The app default is Monday. */
  weekStart?: number;
  /** The chosen day key, or "" for none. */
  value: string;
  /** Today's key in the profile zone. */
  today: string;
  /** The month on show, `YYYY-MM` (controlled). */
  month: string;
  onMonthChange: (month: string) => void;
  /** Called with the day key a press, Enter or Space chose. */
  onSelect: (key: string) => void;
  prevLabel: string;
  nextLabel: string;
  /** Move focus to the active day on mount (the popover does this on open). */
  autoFocus?: boolean;
}

const utc = { timeZone: "UTC" } as const;
// A known Sunday: weekday names are read off it, never off the browser's today.
const sundayRef = keyToWallUtc("2023-01-01");

function useFormatters(locale: string) {
  return useMemo(
    () => ({
      month: new Intl.DateTimeFormat(locale, { ...utc, month: "long" }),
      year: new Intl.DateTimeFormat(locale, { ...utc, year: "numeric" }),
      short: new Intl.DateTimeFormat(locale, { ...utc, weekday: "short" }),
      long: new Intl.DateTimeFormat(locale, { ...utc, weekday: "long" }),
      full: new Intl.DateTimeFormat(locale, { ...utc, weekday: "long", year: "numeric", month: "long", day: "numeric" }),
    }),
    [locale],
  );
}

export function MonthGrid({
  locale = "en-US",
  weekStart = 1,
  value,
  today,
  month,
  onMonthChange,
  onSelect,
  prevLabel,
  nextLabel,
  autoFocus = false,
}: MonthGridProps) {
  const titleId = useId();
  const gridRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef(autoFocus);
  const format = useFormatters(locale);
  const [focusKey, setFocusKey] = useState(value || today);
  // Set by the prev/next buttons only; keyboard paging never animates.
  const [pageId, setPageId] = useState(0);
  const [pageDir, setPageDir] = useState<"next" | "prev">();

  const cells = useMemo(() => monthCells(month, weekStart), [month, weekStart]);
  const first = keyToWallUtc(`${month}-01`);
  const weekdays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, index) => {
        const at = sundayRef + ((weekStart + index) % 7) * 86_400_000;
        return { short: format.short.format(at), long: format.long.format(at) };
      }),
    [format, weekStart],
  );

  // Roving tabindex target: the focused day while it is on show, else the
  // chosen day, else today, else the 1st.
  const inMonth = (key: string) => key.slice(0, 7) === month;
  const activeKey = inMonth(focusKey) ? focusKey : inMonth(value) ? value : inMonth(today) ? today : `${month}-01`;

  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    gridRef.current?.querySelector<HTMLElement>(`[data-date="${activeKey}"]`)?.focus();
  });

  const page = (delta: 1 | -1) => {
    setPageId(id => id + 1); // a new key remounts the body, which replays the entrance
    setPageDir(delta === 1 ? "next" : "prev");
    onMonthChange(shiftMonth(`${month}-01`, delta).slice(0, 7));
  };

  const moveTo = (key: string) => {
    pendingFocus.current = true;
    setPageDir(undefined);
    setFocusKey(key);
    if (!inMonth(key)) onMonthChange(key.slice(0, 7));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, key: string) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const step = rtl ? -1 : 1;
    let next: string | null = null;
    switch (event.key) {
      case "ArrowLeft": next = shiftDay(key, -step); break;
      case "ArrowRight": next = shiftDay(key, step); break;
      case "ArrowUp": next = shiftDay(key, -7); break;
      case "ArrowDown": next = shiftDay(key, 7); break;
      case "Home": next = weekEdges(key, weekStart).first; break;
      case "End": next = weekEdges(key, weekStart).last; break;
      case "PageUp": next = event.shiftKey ? shiftYear(key, -1) : shiftMonth(key, -1); break;
      case "PageDown": next = event.shiftKey ? shiftYear(key, 1) : shiftMonth(key, 1); break;
      default: return; // Enter and Space are the button's own click
    }
    event.preventDefault();
    moveTo(next);
  };

  return (
    <div className="month-grid" data-month={month}>
      <div className="month-head">
        <h3 id={titleId} className="month-title" aria-live="polite">
          {format.month.format(first)} <span>{format.year.format(first)}</span>
        </h3>
        <div className="month-nav">
          <button type="button" className="month-nav-button" aria-label={prevLabel} onClick={() => page(-1)}>
            <ChevronLeft />
          </button>
          <button type="button" className="month-nav-button" aria-label={nextLabel} onClick={() => page(1)}>
            <ChevronRight />
          </button>
        </div>
      </div>
      <div ref={gridRef} role="grid" aria-labelledby={titleId} className="month-table">
        <div role="rowgroup">
          <div role="row" className="month-row">
            {weekdays.map(({ short, long }) => (
              <div key={long} role="columnheader" className="month-dow" aria-label={long}>
                {short}
              </div>
            ))}
          </div>
        </div>
        <div role="rowgroup" key={pageId} className="month-body" data-page={pageDir}>
          {Array.from({ length: 6 }, (_, row) => (
            <div key={row} role="row" className="month-row">
              {cells.slice(row * 7, row * 7 + 7).map(key => {
                const selected = key === value;
                const classes = [
                  "month-day",
                  !inMonth(key) && "is-out",
                  key === today && "is-today",
                  selected && "is-selected",
                ];
                return (
                  <div key={key} role="gridcell" className="month-cell" aria-selected={selected}>
                    <button
                      type="button"
                      className={classes.filter(Boolean).join(" ")}
                      data-date={key}
                      tabIndex={key === activeKey ? 0 : -1}
                      aria-label={format.full.format(keyToWallUtc(key))}
                      aria-current={key === today ? "date" : undefined}
                      onFocus={() => setFocusKey(key)}
                      onKeyDown={event => onKeyDown(event, key)}
                      onClick={() => onSelect(key)}
                    >
                      {Number(key.slice(8))}
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
