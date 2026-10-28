import { settings } from "./settings.ts";
import { shell } from "./shell.ts";

/** Every English message, composed from one file per area. */
export const en = {
  ...settings,
  ...shell,
} as const;
