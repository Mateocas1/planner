import { useState } from "react";
import { setProfileWeeklyReview } from "../../../data/profile.ts";
import {
  weeklyReviewSteps,
  type WeeklyMoment,
  type WeeklyReviewSettings,
  type WeeklyReviewStep,
} from "../../../planning/weekly.ts";
import { t, useLocale, type MessageKey } from "../../../i18n/index.ts";
import { Select } from "../../Select.tsx";
import { formatClock, parseClock, TimeField } from "../../Settings.tsx";
import { settle } from "../../write.ts";
import { Section, SettingRow } from "../SettingRow.tsx";
import { SettingsSwitch } from "../SettingsSwitch.tsx";
import "./RitualsTab.css";

/**
 * Rituals (S3, ronda 2 W2b): the daily shutdown reads its single source — the
 * time General owns — and the weekly review's schedule is real: whether it
 * proposes itself, and when. Each moment owns a day, a time and the steps it
 * runs; every control writes its whole (validated) schedule through the W2a
 * settings API, so a half-edited schedule never reaches the profile.
 *
 * The steps are the four the flow walks (`weeklyReviewSteps`' closed set, in
 * flow order); a moment must keep at least one step, which is also what the
 * reader would enforce on the way back. Moments can be added (up to four — a
 * schedule the week cannot hold is not a schedule) and removed while one
 * remains.
 */

/** How many moments one week's schedule may hold. */
const maxMoments = 4;

export function RitualsTab({
  uid,
  settings,
  shutdownTime,
  onOpenGeneral,
}: {
  uid: string;
  /** The profile's weekly review schedule, already parsed and defaulted. */
  settings: WeeklyReviewSettings;
  shutdownTime: number;
  onOpenGeneral: () => void;
}) {
  useLocale();
  const [error, setError] = useState<string | null>(null);
  // The time field keeps its text while it is being typed; everything else
  // writes straight through (the day select and the step chips commit one
  // whole schedule each press, and the profile snapshot fills them back in).
  const [timeDrafts, setTimeDrafts] = useState<Record<number, string>>({});

  /** One write path: the whole schedule, validated by the profile write
   *  before anything is sent (the API refuses what its reader would drop). */
  const save = (next: WeeklyReviewSettings) => {
    try {
      void settle(setProfileWeeklyReview(uid, next)).catch(() => setError(t("rituals.error.saveFailed")));
    } catch {
      setError(t("rituals.error.needStep"));
    }
  };

  const editMoment = (index: number, patch: Partial<WeeklyMoment>) => {
    const moments = settings.moments.map((moment, entry) => (entry === index ? { ...moment, ...patch } : moment));
    save({ ...settings, moments });
  };

  const toggleStep = (index: number, step: WeeklyReviewStep) => {
    const moment = settings.moments[index];
    if (moment === undefined) return;
    const steps = moment.steps.includes(step)
      ? moment.steps.filter(entry => entry !== step)
      : [...moment.steps, step];
    if (steps.length === 0) {
      setError(t("rituals.error.needStep"));
      return;
    }
    setError(null);
    editMoment(index, { steps });
  };

  const commitTime = (index: number, text: string) => {
    const minutes = parseClock(text);
    if (minutes === null) {
      setError(t("settings.error.notATime"));
      return;
    }
    if (minutes >= 1440) {
      setError(t("rituals.error.beforeMidnight"));
      return;
    }
    setError(null);
    setTimeDrafts(current => {
      const next = { ...current };
      delete next[index];
      return next;
    });
    editMoment(index, { time: minutes });
  };

  const addMoment = () => {
    if (settings.moments.length >= maxMoments) return;
    // A new moment starts as another Sunday evening plan; the controls are
    // right there to move it.
    save({ ...settings, moments: [...settings.moments, { day: 0, time: 19 * 60, steps: ["plan"] }] });
  };

  const removeMoment = (index: number) => {
    if (settings.moments.length <= 1) return;
    setError(null);
    save({ ...settings, moments: settings.moments.filter((_, entry) => entry !== index) });
  };

  return (
    <>
      <Section title={t("rituals.daily.title")}>
        <SettingRow label={t("rituals.daily.label", { time: formatClock(shutdownTime) })} description={t("rituals.daily.description")}>
          {() => (
            <button type="button" className="link-button" onClick={onOpenGeneral}>
              {t("rituals.daily.edit")}
            </button>
          )}
        </SettingRow>
      </Section>

      <Section
        title={t("rituals.weekly.title")}
        description={t("rituals.weekly.description")}
      >
        <SettingRow
          label={t("rituals.propose.label")}
          description={t("rituals.propose.description")}
        >
          {labelId => (
            <SettingsSwitch
              labelledBy={labelId}
              checked={settings.nudges}
              onChange={() => save({ ...settings, nudges: !settings.nudges })}
            />
          )}
        </SettingRow>
      </Section>

      <section className="settings-section" aria-label={t("rituals.moments.label")}>
        <h3 className="settings-section-title">{t("rituals.moments.title")}</h3>
        <p className="settings-section-desc">{t("rituals.moments.description")}</p>
        <div className="settings-card rituals-moments">
          {settings.moments.map((moment, index) => (
            <div key={index} className="rituals-moment">
              <div className="rituals-moment-row">
                <label className="rituals-moment-label" htmlFor={`rituals-day-${index}`}>{t("rituals.moment", { n: index + 1 })}</label>
                <div className="rituals-moment-controls">
                  <Select
                    id={`rituals-day-${index}`}
                    label={t("rituals.moment", { n: index + 1 })}
                    className="rituals-day"
                    value={String(moment.day)}
                    options={dayOptions()}
                    onChange={value => editMoment(index, { day: Number(value) })}
                  />
                  <TimeField
                    id={`rituals-time-${index}`}
                    value={timeDrafts[index] ?? formatClock(moment.time)}
                    onChange={value => setTimeDrafts(current => ({ ...current, [index]: value }))}
                    onCommit={() => commitTime(index, timeDrafts[index] ?? formatClock(moment.time))}
                  />
                  {settings.moments.length > 1 && (
                    <button type="button" className="link-button" aria-label={t("rituals.removeMoment", { n: index + 1 })} onClick={() => removeMoment(index)}>
                      {t("rituals.remove")}
                    </button>
                  )}
                </div>
              </div>
              <div className="rituals-moment-row">
                <span className="rituals-moment-label" id={`rituals-steps-${index}`}>{t("rituals.steps")}</span>
                <div className="rituals-steps" role="group" aria-labelledby={`rituals-steps-${index}`}>
                  {stepNames().map(([step, label]) => (
                    <button
                      key={step}
                      type="button"
                      className="rituals-step-chip"
                      aria-pressed={moment.steps.includes(step)}
                      onClick={() => toggleStep(index, step)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="rituals-foot">
          {settings.moments.length < maxMoments && (
            <button type="button" className="link-button" onClick={addMoment}>
              {t("rituals.addMoment")}
            </button>
          )}
          {error && <p className="inline-error" role="alert">{error}</p>}
        </div>
      </section>
    </>
  );
}

/** The weekday select's options, in stored order (0 = Sunday, as weekly.ts documents). */
const weekdayKeys = [
  "rituals.day.0",
  "rituals.day.1",
  "rituals.day.2",
  "rituals.day.3",
  "rituals.day.4",
  "rituals.day.5",
  "rituals.day.6",
] as const;
const dayOptions = () => weekdayKeys.map((key, day) => ({ value: String(day), label: t(key) }));

/** The four steps, in flow order, as the chips' labels. */
const stepKeys = {
  review: "rituals.step.review",
  cleanup: "rituals.step.cleanup",
  plan: "rituals.step.plan",
  reflect: "rituals.step.reflect",
} as const satisfies Record<WeeklyReviewStep, MessageKey>;
const stepNames = (): ReadonlyArray<[WeeklyReviewStep, string]> => weeklyReviewSteps.map(step => [step, t(stepKeys[step])]);
