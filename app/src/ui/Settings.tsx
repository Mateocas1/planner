/**
 * Shared pieces of the settings surface (Ronda 2, S1).
 *
 * The Day settings sheet became the Settings view (ui/settings/); what lives
 * here now is what several modules share: the clock parsers the General tab
 * validates with, the gear icon the sidebar mounts, and the time field the
 * work-day rows render. The switch and the row primitives live in
 * ui/settings/.
 */

export { formatClock, parseClock } from "./clock.ts";

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
      strokeWidth={1.7}
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
  className = "form-control day-time",
  label,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  /** Replaces the settings-row look, for a field that sits beside another control. */
  className?: string;
  /** The accessible name when no `<label htmlFor>` names the field. */
  label?: string;
}) {
  return (
    <input
      id={id}
      className={className}
      aria-label={label}
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
