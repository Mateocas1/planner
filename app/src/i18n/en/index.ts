import { auth } from "./auth.ts";
import { calendar } from "./calendar.ts";
import { chat } from "./chat.ts";
import { controls } from "./controls.ts";
import { forms } from "./forms.ts";
import { settings } from "./settings.ts";

/** Every English message, composed from one file per area. */
export const en = {
  ...auth,
  ...calendar,
  ...chat,
  ...controls,
  ...forms,
  ...settings,
} as const;
