import type { Dictionary } from "../types.ts";
import { calendar } from "./calendar.ts";
import { settings } from "./settings.ts";

/** A key missing here (or an extra one) is a type error: `Dictionary` mirrors `en`. */
export const es: Dictionary = {
  ...calendar,
  ...settings,
};
