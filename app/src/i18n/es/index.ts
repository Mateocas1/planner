import type { Dictionary } from "../types.ts";
import { auth } from "./auth.ts";
import { calendar } from "./calendar.ts";
import { chat } from "./chat.ts";
import { controls } from "./controls.ts";
import { forms } from "./forms.ts";
import { settings } from "./settings.ts";

/** A key missing here (or an extra one) is a type error: `Dictionary` mirrors `en`. */
export const es: Dictionary = {
  ...auth,
  ...calendar,
  ...chat,
  ...controls,
  ...forms,
  ...settings,
};
