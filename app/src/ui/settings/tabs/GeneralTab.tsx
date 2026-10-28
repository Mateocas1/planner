import { useState } from "react";
import { setProfileDaySettings, type DaySettingsPatch } from "../../../data/profile.ts";
import { minutesPerDay, type WorkWindow } from "../../../planning/window.ts";
import { formatClock, parseClock, TimeField } from "../../Settings.tsx";
import { Section, SettingRow } from "../SettingRow.tsx";
import { SettingsSwitch } from "../SettingsSwitch.tsx";
import { LanguageSection } from "./LanguageSection.tsx";
import { settle } from "../../write.ts";

/**
 * General (design brief §4): the work day and the keyboard-switch master
 * toggle, moved from the old Day settings sheet with every id, label,
 * validation sentence and storage write intact (§7 "Must stay stable"). Each
 * control saves itself; a value the reader would refuse is never written and
 * says so in one calm line under its own row.
 */

/** The product's wording for input the fields refuse. One line each, no blame. */
const notATime = "Use a time like 09:00.";
const outsideDay = "Stay inside the day: 00:00 to 24:00.";
const inverted = "Work ends before it starts. Set an end later than the start.";

export function GeneralTab({
  uid,
  workWindow,
  shutdownTime,
  shortcutsEnabled,
}: {
  uid: string;
  workWindow: WorkWindow;
  shutdownTime: number;
  shortcutsEnabled: boolean;
}) {
  // The fields start at whatever the profile holds and follow it until edited:
  // a profile that arrives a beat after the view opened still fills them in.
  const [windowDraft, setWindowDraft] = useState<{ start: string; end: string } | null>(null);
  const [shutdownDraft, setShutdownDraft] = useState<string | null>(null);
  const [shortcutsDraft, setShortcutsDraft] = useState<boolean | null>(null);
  const [windowError, setWindowError] = useState<string | null>(null);
  const [shutdownError, setShutdownError] = useState<string | null>(null);

  const startText = windowDraft?.start ?? formatClock(workWindow.startMinutes);
  const endText = windowDraft?.end ?? formatClock(workWindow.endMinutes);
  const shutdownText = shutdownDraft ?? formatClock(shutdownTime);
  const enabled = shortcutsDraft ?? shortcutsEnabled;

  const editWindow = (field: "start" | "end", value: string) => {
    const next = { start: startText, end: endText };
    next[field] = value;
    setWindowDraft(next);
  };

  /** One write path: only the fields this control changed, so a stale copy of
   * another field can never travel with it. */
  const save = (patch: DaySettingsPatch) => {
    void settle(setProfileDaySettings(uid, patch)).catch(() => undefined);
  };

  const commitWindow = () => {
    const start = parseClock(startText);
    const end = parseClock(endText);
    if (start === null || end === null) return setWindowError(notATime);
    if (start > minutesPerDay || end > minutesPerDay) return setWindowError(outsideDay);
    if (end <= start) return setWindowError(inverted);
    setWindowError(null);
    if (start === workWindow.startMinutes && end === workWindow.endMinutes) return;
    save({ workWindow: { startMinutes: start, endMinutes: end } });
  };

  const commitShutdown = () => {
    const minutes = parseClock(shutdownText);
    if (minutes === null) return setShutdownError(notATime);
    if (minutes > minutesPerDay) return setShutdownError(outsideDay);
    setShutdownError(null);
    if (minutes === shutdownTime) return;
    save({ shutdownTime: minutes });
  };

  const toggleShortcuts = () => {
    const next = !enabled;
    setShortcutsDraft(next);
    save({ shortcutsEnabled: next });
  };

  return (
    <>
      <Section title="Work day" description="One working window for every day, in your planner's time zone.">
        <SettingRow label="Work starts" controlId="day-work-start">
          {() => (
            <TimeField
              id="day-work-start"
              value={startText}
              onChange={value => editWindow("start", value)}
              onCommit={commitWindow}
            />
          )}
        </SettingRow>
        <SettingRow label="Work ends" controlId="day-work-end" error={windowError}>
          {() => (
            <TimeField
              id="day-work-end"
              value={endText}
              onChange={value => editWindow("end", value)}
              onCommit={commitWindow}
            />
          )}
        </SettingRow>
        <SettingRow label="Shut down at" description="When the day is meant to close." controlId="day-shutdown" error={shutdownError}>
          {() => (
            <TimeField
              id="day-shutdown"
              value={shutdownText}
              onChange={setShutdownDraft}
              onCommit={commitShutdown}
            />
          )}
        </SettingRow>
      </Section>
      <Section title="Keyboard">
        <SettingRow label="Keyboard shortcuts">
          {labelId => <SettingsSwitch labelledBy={labelId} checked={enabled} onChange={toggleShortcuts} />}
        </SettingRow>
      </Section>
      <LanguageSection uid={uid} />
    </>
  );
}
