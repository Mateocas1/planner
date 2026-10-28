import { useState } from "react";
import { setProfileWeeklyReview } from "../../../data/profile.ts";
import {
  weeklyReviewSteps,
  type WeeklyMoment,
  type WeeklyReviewSettings,
  type WeeklyReviewStep,
} from "../../../planning/weekly.ts";
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

const notATime = "Use a time like 09:00.";
const beforeMidnight = "Pick a time before midnight.";
const needStep = "A moment must run at least one step.";

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
  const [error, setError] = useState<string | null>(null);
  // The time field keeps its text while it is being typed; everything else
  // writes straight through (the day select and the step chips commit one
  // whole schedule each press, and the profile snapshot fills them back in).
  const [timeDrafts, setTimeDrafts] = useState<Record<number, string>>({});

  /** One write path: the whole schedule, validated by the profile write
   *  before anything is sent (the API refuses what its reader would drop). */
  const save = (next: WeeklyReviewSettings) => {
    try {
      void settle(setProfileWeeklyReview(uid, next)).catch(() => setError("The schedule could not be saved."));
    } catch {
      setError(needStep);
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
      setError(needStep);
      return;
    }
    setError(null);
    editMoment(index, { steps });
  };

  const commitTime = (index: number, text: string) => {
    const minutes = parseClock(text);
    if (minutes === null) {
      setError(notATime);
      return;
    }
    if (minutes >= 1440) {
      setError(beforeMidnight);
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
      <Section title="Daily shutdown">
        <SettingRow label={`Shut down at ${formatClock(shutdownTime)}`} description="Lives in General — one time, one place to change it.">
          {() => (
            <button type="button" className="link-button" onClick={onOpenGeneral}>
              Edit in General
            </button>
          )}
        </SettingRow>
      </Section>

      <Section
        title="Weekly review"
        description="One review a week, in the moments you set: each runs its own steps on its own day and time."
      >
        <SettingRow
          label="Propose the review"
          description="A toast on the day, and a quiet banner on Home. The review stays open by hand either way."
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

      <section className="settings-section" aria-label="Weekly review moments">
        <h3 className="settings-section-title">Moments</h3>
        <p className="settings-section-desc">When each moment opens, and the steps it runs.</p>
        <div className="settings-card rituals-moments">
          {settings.moments.map((moment, index) => (
            <div key={index} className="rituals-moment">
              <div className="rituals-moment-row">
                <label className="rituals-moment-label" htmlFor={`rituals-day-${index}`}>Moment {index + 1}</label>
                <div className="rituals-moment-controls">
                  <Select
                    id={`rituals-day-${index}`}
                    label={`Moment ${index + 1}`}
                    className="rituals-day"
                    value={String(moment.day)}
                    options={dayOptions}
                    onChange={value => editMoment(index, { day: Number(value) })}
                  />
                  <TimeField
                    id={`rituals-time-${index}`}
                    value={timeDrafts[index] ?? formatClock(moment.time)}
                    onChange={value => setTimeDrafts(current => ({ ...current, [index]: value }))}
                    onCommit={() => commitTime(index, timeDrafts[index] ?? formatClock(moment.time))}
                  />
                  {settings.moments.length > 1 && (
                    <button type="button" className="link-button" aria-label={`Remove moment ${index + 1}`} onClick={() => removeMoment(index)}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
              <div className="rituals-moment-row">
                <span className="rituals-moment-label" id={`rituals-steps-${index}`}>Steps</span>
                <div className="rituals-steps" role="group" aria-labelledby={`rituals-steps-${index}`}>
                  {stepNames.map(([step, label]) => (
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
              Add a moment
            </button>
          )}
          {error && <p className="inline-error" role="alert">{error}</p>}
        </div>
      </section>
    </>
  );
}

/** The weekday select's options, in stored order (0 = Sunday, as weekly.ts documents). */
const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayOptions = weekdayNames.map((label, day) => ({ value: String(day), label }));

/** The four steps, in flow order, as the chips' labels. */
const stepNames: ReadonlyArray<[WeeklyReviewStep, string]> = weeklyReviewSteps.map(step => [
  step,
  { review: "Review", cleanup: "Clean up", plan: "Plan", reflect: "Reflect" }[step],
]);
