import { formatClock } from "../../Settings.tsx";
import { Section, SettingRow } from "../SettingRow.tsx";
import { SettingsSwitch } from "../SettingsSwitch.tsx";

/**
 * Rituals (design brief §4, S3 placeholder): the daily shutdown reads its
 * single source — the time General owns — and the weekly review's controls
 * are shown as disabled placeholders until task W2 fills the schedule in.
 * The rows are already laid out the way W2 will light them up, so the move is
 * a state change, not a redesign.
 */
export function RitualsTab({
  shutdownTime,
  onOpenGeneral,
}: {
  shutdownTime: number;
  onOpenGeneral: () => void;
}) {
  return (
    <>
      <Section title="Daily shutdown">
        <SettingRow label={`Shut down at ${formatClock(shutdownTime)}`} description="Lives in General — one time, one place to change it.">
          {() => (
            <button type="button" className="link-button" onClick={onOpenGeneral}>
              Edit in General
            </button>
          )}
        </SettingRow>
      </Section>
      <Section title="Weekly review" description="One review a week, in two moments: look back on Friday, plan on Sunday.">
        <SettingRow label="Enable nudges" description="A toast on the day, and a quiet banner on Home.">
          {labelId => <SettingsSwitch labelledBy={labelId} checked={false} disabled onChange={() => undefined} />}
        </SettingRow>
        <SettingRow label="Review moment" description="Look back at the week and clean it up.">
          {() => <span className="settings-placeholder-value">Friday 17:00</span>}
        </SettingRow>
        <SettingRow label="Plan moment" description="Priorities and blocks for the next week.">
          {() => <span className="settings-placeholder-value">Sunday 19:00</span>}
        </SettingRow>
      </Section>
      <p className="settings-coming-soon">Coming with the weekly review.</p>
    </>
  );
}
