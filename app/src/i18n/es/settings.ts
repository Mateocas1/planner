import type { Dictionary } from "../types.ts";

/** Neutral Spanish: infinitives and impersonal phrasing, no voseo. */
export const settings = {
  "settings.language.title": "Idioma",
  "settings.language.label": "Idioma de la app",
  "settings.language.description": "Las fechas y los textos siguen esta elección.",
  "settings.language.deviceOnly": "Solo en este dispositivo",
  "settings.language.deviceOnlyHelp": "Los demás dispositivos conservan el idioma guardado en la cuenta.",
} satisfies Partial<Dictionary>;
