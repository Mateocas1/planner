import { auth } from "./auth.ts";
import { settings } from "./settings.ts";

/** Every English message, composed from one file per area. */
export const en = {
  ...auth,
  ...settings,
} as const;
