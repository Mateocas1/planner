/**
 * Shared pieces of the settings surface (Ronda 2, S1).
 *
 * The Day settings sheet became the Settings view (ui/settings/); what lives
 * here now is what several modules share: the clock parsers the General tab
 * validates with, the gear icon the sidebar mounts, and the time field the
 * work-day rows render. The switch and the row primitives live in
 * ui/settings/.
 */

import { ICON_STROKE } from "./icons.tsx";

/**
 * "HH:MM" for minutes after midnight. The end of the day reads as 24:00.
 */
export function formatClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/**
 * Minutes after midnight for a typed time, or null when the text is not a time.
 * The range is the caller's rule: 25:00 parses to 1500 so the caller can reject
 * it as outside the day, which is a different sentence from "not a time".
 * `9`, `09`, `9:30`, `09:30` and `0930` all read; `9:5` does not.
 */
export function parseClock(text: string): number | null {
  const match = /^(\d{1,2})(?::?(\d{2}))?$/.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const rest = match[2] === undefined ? 0 : Number(match[2]);
  if (rest > 59) return null;
  return hours * 60 + rest;
}

/** The gear that opens Settings from the sidebar's account row. Drawn in
 * ui/icons.tsx's stroke family on the same 24 px grid; it lives here because
 * the sidebar is its only surface, and the sidebar imports it from this module. */
export function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={ICON_STROKE}
      aria-hidden="true"
      className={className}
    >
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 14.4a1.6 1.6 0 0 0 .3 1.8l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a1.9 1.9 0 1 1-3.8 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1h-.2a1.9 1.9 0 1 1 0-3.8h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5v-.2a1.9 1.9 0 1 1 3.8 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1h.2a1.9 1.9 0 1 1 0 3.8h-.1a1.6 1.6 0 0 0-1.5 1Z" />
    </svg>
  );
}

/**
 * The time field: a plain "HH:MM" box rather than a native time picker, the
 * rule the work-day rows enforce being "the whole day, and an end after the
 * start", and a text field lets the row say which of the two was broken
 * instead of the browser silently emptying a value it did not like. The
 * numeric keypad on a phone is what a time is typed with anyway. The row's
 * label (a real `<label htmlFor>` in ui/settings/SettingRow.tsx) names it.
 */
export function TimeField({
  id,
  value,
  onChange,
  onCommit,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
}) {
  return (
    <input
      id={id}
      className="form-control day-time"
      type="text"
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      maxLength={5}
      value={value}
      onChange={event => onChange(event.target.value)}
      onBlur={onCommit}
      onKeyDown={event => {
        // Enter commits the field it is in, the same as leaving it.
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  );
}
