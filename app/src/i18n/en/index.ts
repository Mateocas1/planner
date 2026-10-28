import { auth } from "./auth.ts";
import { calendar } from "./calendar.ts";
import { settings } from "./settings.ts";
import { today } from "./today.ts";

/** Every English message, composed from one file per area. */
export const en = {
  ...auth,
  ...calendar,
  ...settings,
  ...today,
} as const;
