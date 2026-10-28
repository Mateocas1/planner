import { useEffect, useState } from "react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import {
  notifySettingsStorageKey,
  parseNotifySettings,
  type NotifySettings,
} from "../../../desktop-notify.ts";
import {
  MAX_IDLE_THRESHOLD_MINUTES,
  MIN_IDLE_THRESHOLD_MINUTES,
  readIdleThreshold,
  writeIdleThreshold,
} from "../../../domain/idle.ts";
import { readPillEnabled, writePillEnabled } from "../../focusPillState.ts";
import { t, useLocale } from "../../../i18n/index.ts";
import { NumberStepper } from "../../NumberStepper.tsx";
import { Section, SettingRow } from "../SettingRow.tsx";
import { SettingsSwitch } from "../SettingsSwitch.tsx";

/**
 * Desktop (design brief §4): everything that belongs to this computer rather
 * than to the plan — sign-in startup, the floating timer, the away threshold
 * and the Windows notification toggles — moved from the old sheet with their
 * storage untouched. Rendered only inside the desktop shell; the web build
 * never mounts this tab (§3, no disabled teaser).
 */

/** The idle setting's own sentence, for a value outside the 5–60 range. */
const outsideThreshold = () =>
  t("desktop.error.threshold", { min: MIN_IDLE_THRESHOLD_MINUTES, max: MAX_IDLE_THRESHOLD_MINUTES });

/** This device's notification toggles (T7, S8.3): desktop only, never synced. */
function readNotifySettings(): NotifySettings {
  try {
    return parseNotifySettings(window.localStorage.getItem(notifySettingsStorageKey));
  } catch {
    return parseNotifySettings(null);
  }
}

function writeNotifySettings(next: NotifySettings): void {
  try {
    window.localStorage.setItem(notifySettingsStorageKey, JSON.stringify(next));
  } catch {
    /* storage denied: the toggles then live only until the page closes */
  }
}

/**
 * Desktop only (T10, spec S8.6): "Open Planner when I sign in to Windows". The
 * switch shows the operating system's own state (the HKCU Run entry), read when
 * the tab opens and again after every change, never a cached flag.
 */
function SignInStartupRow() {
  useLocale();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    isEnabled()
      .then(value => {
        if (live) setEnabled(value);
      })
      .catch(() => {
        if (live) setError(t("desktop.error.startupRead"));
      });
    return () => {
      live = false;
    };
  }, []);

  const toggle = () => {
    if (enabled === null || busy) return;
    setBusy(true);
    setError(null);
    void (enabled ? disable() : enable())
      .catch(() => setError(t("desktop.error.startupChange")))
      .then(() => isEnabled())
      .then(value => setEnabled(value))
      .catch(() => setError(t("desktop.error.startupRead")))
      .finally(() => setBusy(false));
  };

  return (
    <SettingRow
      label={t("desktop.startup.label")}
      description={t("desktop.startup.description")}
      error={error}
    >
      {labelId => <SettingsSwitch labelledBy={labelId} checked={enabled === true} disabled={enabled === null || busy} onChange={toggle} />}
    </SettingRow>
  );
}

export function DesktopTab() {
  useLocale();
  // The away threshold lives in localStorage, not the profile (S8.5): it is a
  // preference of this machine's input habits, not a fact about the plan.
  const [idleDraft, setIdleDraft] = useState<string | null>(null);
  const [idleError, setIdleError] = useState<string | null>(null);
  const [notify, setNotify] = useState<NotifySettings>(() => readNotifySettings());
  // The desktop pill's toggle is per device (the pill reads the same entry),
  // so it is a draft over localStorage, not the profile (S8.4, L15).
  const [pillEnabled, setPillEnabled] = useState<boolean>(() => readPillEnabled());
  const idleText = idleDraft ?? String(readIdleThreshold(window.localStorage));

  /** Persists the away threshold locally. Out-of-range values say so and keep
   * what was typed, like every other field in this view. */
  const commitIdle = (text: string) => {
    const minutes = Number(text);
    if (text === "" || !Number.isInteger(minutes) || minutes < MIN_IDLE_THRESHOLD_MINUTES || minutes > MAX_IDLE_THRESHOLD_MINUTES) {
      return setIdleError(outsideThreshold());
    }
    setIdleError(null);
    setIdleDraft(null);
    writeIdleThreshold(minutes, window.localStorage);
  };

  const toggleNotify = (field: keyof NotifySettings) => {
    const next = { ...notify, [field]: !notify[field] };
    setNotify(next);
    writeNotifySettings(next);
  };

  const togglePill = () => {
    const next = !pillEnabled;
    setPillEnabled(next);
    writePillEnabled(next);
  };

  return (
    <>
      <Section title={t("desktop.windows.title")} description={t("desktop.windows.description")}>
        <SignInStartupRow />
        <SettingRow label={t("desktop.pill.label")} description={t("desktop.pill.description")}>
          {labelId => <SettingsSwitch labelledBy={labelId} checked={pillEnabled} onChange={togglePill} />}
        </SettingRow>
        <SettingRow
          label={t("desktop.away.label")}
          description={t("desktop.away.description")}
          controlId="day-idle-threshold"
          error={idleError}
        >
          {() => (
            <NumberStepper
              id="day-idle-threshold"
              draft={idleText}
              stored={readIdleThreshold(window.localStorage)}
              min={MIN_IDLE_THRESHOLD_MINUTES}
              max={MAX_IDLE_THRESHOLD_MINUTES}
              invalid={idleError !== null}
              unit={t("stepper.minutesUnit")}
              decreaseLabel={t("stepper.decreaseAway")}
              increaseLabel={t("stepper.increaseAway")}
              onDraftChange={setIdleDraft}
              onCommit={commitIdle}
            />
          )}
        </SettingRow>
      </Section>
      <Section title={t("desktop.notifications.title")} description={t("desktop.notifications.description")}>
        <SettingRow label={t("desktop.blockReminders")}>
          {labelId => <SettingsSwitch labelledBy={labelId} checked={notify.blockReminders} onChange={() => toggleNotify("blockReminders")} />}
        </SettingRow>
        <SettingRow label={t("desktop.shutdownNudge")}>
          {labelId => <SettingsSwitch labelledBy={labelId} checked={notify.shutdownNudge} onChange={() => toggleNotify("shutdownNudge")} />}
        </SettingRow>
      </Section>
    </>
  );
}
