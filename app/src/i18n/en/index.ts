import { calendar } from "./calendar.ts";
import { settings } from "./settings.ts";

/** Every English message, composed from one file per area. */
export const en = {
  ...calendar,
  ...settings,
} as const;
