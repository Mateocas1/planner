import type { Dictionary } from "../types.ts";

/** Neutral Spanish: infinitives and impersonal phrasing, no voseo. */
export const forms = {
  "forms.estimate.label": "Estimación",
  "forms.estimate.placeholder": "Minutos",
  "forms.estimate.unit": "min",
  "forms.estimate.presets": "Duraciones comunes",
  "forms.estimate.presetMinutes": "{minutes} minutos",
  "forms.estimate.presetHours": { one: "{count} hora", other: "{count} horas" },
  "forms.estimate.decrease": "Restar 5 minutos",
  "forms.estimate.increase": "Sumar 5 minutos",
  "forms.title.required": "Añade un título para crear la tarea.",
} satisfies Partial<Dictionary>;
