import { forms } from "./forms.ts";
import { settings } from "./settings.ts";

/** Every English message, composed from one file per area. */
export const en = {
  ...forms,
  ...settings,
} as const;
