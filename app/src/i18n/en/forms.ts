/** Form copy: the Estimate control and the New task title. English is the source of truth: `es/forms.ts` must carry the same keys and placeholders. */
export const forms = {
  "forms.estimate.label": "Estimate",
  "forms.estimate.placeholder": "Minutes",
  "forms.estimate.unit": "min",
  "forms.estimate.presets": "Common durations",
  "forms.estimate.presetMinutes": "{minutes} minutes",
  "forms.estimate.presetHours": { one: "{count} hour", other: "{count} hours" },
  "forms.estimate.decrease": "Decrease by 5 minutes",
  "forms.estimate.increase": "Increase by 5 minutes",
  "forms.title.required": "Add a title to create the task.",
} as const;
