import type { Dictionary } from "../types.ts";
import { auth } from "./auth.ts";
import { calendar } from "./calendar.ts";
import { settings } from "./settings.ts";
import { today } from "./today.ts";

/** A key missing here (or an extra one) is a type error: `Dictionary` mirrors `en`. */
export const es: Dictionary = {
  ...auth,
  ...calendar,
  ...settings,
  ...today,
};
