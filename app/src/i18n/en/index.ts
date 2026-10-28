import { auth } from "./auth.ts";
import { controls } from "./controls.ts";
import { settings } from "./settings.ts";

/** Every English message, composed from one file per area. */
export const en = {
  ...auth,
  ...controls,
  ...settings,
} as const;
