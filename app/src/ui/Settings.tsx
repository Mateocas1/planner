import { useState } from "react";
import { isTauri } from "../desktop.ts";
import { setProfileDaySettings, type DaySettingsPatch } from "../data/profile.ts";
import { readPillEnabled, writePillEnabled } from "./focusPillState.ts";
import { minutesPerDay, type WorkWindow } from "../planning/window.ts";
import { CloseIcon } from "./icons.tsx";
import { Sheet } from "./Sheet.tsx";
import { settle } from "./write.ts";
import "./Settings.css";

/**
 * S1 — Day settings (odd/research/distinctive-roadmap.md §3, F3/F6).
 *
 * One sheet, opened from the account entry (the desktop sidebar's account row
 * and the phone's account menu), holding the three values the planner reads
 * about a day: the working window, the hour the day shuts down, and whether
 * keyboard shortcuts are on. One window for all seven days (§5.4): a
 * per-weekday schedule waits for demand.
 *
 * Each control saves itself. Leaving a time field writes it; a value the reader
 * would refuse -- an end before its start, a time outside the day, or something
 * that is not a time at all -- is never written and says so in one calm line
 * that stays until the fields are valid. The fields keep what was typed, so a
 * rejected range is one correction away, not a reset. There is no Save button
 * and therefore no half-saved sheet to close by accident.
 *
 * Nothing here animates: the panel's entrance and exit belong to ui/Sheet.tsx,
 * and the switch's state is read at a glance (knob position and fill, never
 * colour alone) rather than performed. Reduced motion is moot for that reason.
 */

/** The product's wording for input the sheet refuses. One line each, no blame. */
const notATime = "Use a time like 09:00.";
const outsideDay = "Stay inside the day: 00:00 to 24:00.";
const inverted = "Work ends before it starts. Set an end later than the start.";

/** "HH:MM" for minutes after midnight. The end of the day reads as 24:00. */
export function formatClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/**
 * Minutes after midnight for a typed time, or null when the text is not a time.
 * The range is the caller's rule: 25:00 parses to 1500 so the sheet can reject
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

/** The gear that opens Day settings from the sidebar's account row. Drawn in
 * ui/icons.tsx's stroke family on the same 24 px grid; it lives here because
 * this sheet is its only surface, and the sidebar imports it from this module. */
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
 * The time field. A plain "HH:MM" box rather than a native time picker: the
 * rule this sheet enforces is "the whole day, and an end after the start", and
 * a text field lets the sheet say which of the two was broken instead of the
 * browser silently emptying a value it did not like. The numeric keypad on a
 * phone is what a time is typed with anyway.
 */
function TimeField({
  id,
  label,
  value,
  autoFocus = false,
  onChange,
  onCommit,
}: {
  id: string;
  label: string;
  value: string;
  /** The sheet's first field takes the caret, the way every other sheet's
   * primary control does: the keyboard reaches the panel, not the page behind. */
  autoFocus?: boolean;
  onChange: (value: string) => void;
  onCommit: () => void;
}) {
  return (
    <div className="form-row">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="form-control day-time"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        maxLength={5}
        autoFocus={autoFocus}
        value={value}
        onChange={event => onChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={event => {
          // Enter commits the field it is in, the same as leaving it; Escape is
          // the sheet's (ui/Sheet.tsx closes on it).
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

export function DaySettingsSheet({
  uid,
  workWindow,
  shutdownTime,
  shortcutsEnabled,
  origin,
  onClose,
}: {
  uid: string;
  workWindow: WorkWindow;
  shutdownTime: number;
  shortcutsEnabled: boolean;
  origin: HTMLElement | null;
  onClose: () => void;
}) {
  /* The fields start at whatever the profile holds and follow it until this
     sheet is edited: a profile that arrives a beat after the sheet opened still
     fills it in, and a value written from another device still lands here. */
  const [windowDraft, setWindowDraft] = useState<{ start: string; end: string } | null>(null);
  const [shutdownDraft, setShutdownDraft] = useState<string | null>(null);
  const [shortcutsDraft, setShortcutsDraft] = useState<boolean | null>(null);
  // The desktop pill's toggle is per device (the pill reads the same entry),
  // so it is a draft over localStorage, not the profile (S8.4, L15).
  const [pillDraft, setPillDraft] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startText = windowDraft?.start ?? formatClock(workWindow.startMinutes);
  const endText = windowDraft?.end ?? formatClock(workWindow.endMinutes);
  const shutdownText = shutdownDraft ?? formatClock(shutdownTime);
  const enabled = shortcutsDraft ?? shortcutsEnabled;
  const pillEnabled = pillDraft ?? readPillEnabled();

  const editWindow = (field: "start" | "end", value: string) => {
    const next = { start: startText, end: endText };
    next[field] = value;
    setWindowDraft(next);
  };

  /** One write path: only the fields this control changed, so a stale copy of
   * another field can never travel with it. A rejected write is the sheet's
   * own sentence; the fields keep what the user typed. */
  const save = (patch: DaySettingsPatch) => {
    void settle(setProfileDaySettings(uid, patch)).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "That could not be saved. Try again.");
    });
  };

  const commitWindow = () => {
    const start = parseClock(startText);
    const end = parseClock(endText);
    if (start === null || end === null) return setError(notATime);
    if (start > minutesPerDay || end > minutesPerDay) return setError(outsideDay);
    if (end <= start) return setError(inverted);
    setError(null);
    if (start === workWindow.startMinutes && end === workWindow.endMinutes) return;
    save({ workWindow: { startMinutes: start, endMinutes: end } });
  };

  const commitShutdown = () => {
    const minutes = parseClock(shutdownText);
    if (minutes === null) return setError(notATime);
    if (minutes > minutesPerDay) return setError(outsideDay);
    setError(null);
    if (minutes === shutdownTime) return;
    save({ shutdownTime: minutes });
  };

  const toggleShortcuts = () => {
    const next = !enabled;
    setShortcutsDraft(next);
    setError(null);
    save({ shortcutsEnabled: next });
  };

  const togglePill = () => {
    const next = !pillEnabled;
    setPillDraft(next);
    writePillEnabled(next);
  };

  return (
    <Sheet label="Day settings" className="day-settings-sheet" origin={origin} onClose={onClose}>
      <header className="sheet-head">
        <span className="sheet-kind">Day settings</span>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="sheet-form">
        <p className="day-settings-lead">One working window for every day, in your planner's time zone.</p>
        <div className="form-group">
          <TimeField
            id="day-work-start"
            label="Work starts"
            value={startText}
            autoFocus
            onChange={value => editWindow("start", value)}
            onCommit={commitWindow}
          />
          <TimeField
            id="day-work-end"
            label="Work ends"
            value={endText}
            onChange={value => editWindow("end", value)}
            onCommit={commitWindow}
          />
        </div>
        <div className="form-group">
          <TimeField
            id="day-shutdown"
            label="Shut down at"
            value={shutdownText}
            onChange={setShutdownDraft}
            onCommit={commitShutdown}
          />
          <p className="day-settings-note">When the day is meant to close.</p>
        </div>
        <div className="form-group">
          <div className="form-row">
            <span id="day-shortcuts-label">Keyboard shortcuts</span>
            <button
              type="button"
              role="switch"
              className="day-switch"
              aria-checked={enabled}
              aria-labelledby="day-shortcuts-label"
              onClick={toggleShortcuts}
            >
              <span className="day-switch-track" aria-hidden="true">
                <span className="day-switch-knob" />
              </span>
            </button>
          </div>
        </div>
        {isTauri() && (
          <div className="form-group">
            <div className="form-row">
              <span id="desktop-pill-label">Show floating timer</span>
              <button
                type="button"
                role="switch"
                className="day-switch"
                aria-checked={pillEnabled}
                aria-labelledby="desktop-pill-label"
                onClick={togglePill}
              >
                <span className="day-switch-track" aria-hidden="true">
                  <span className="day-switch-knob" />
                </span>
              </button>
            </div>
            <p className="day-settings-note">
              A mini timer above other windows while a focus session runs.
            </p>
          </div>
        )}
        {error && <p className="inline-error" role="alert">{error}</p>}
      </div>
    </Sheet>
  );
}
