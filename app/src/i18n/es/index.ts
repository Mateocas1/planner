import type { Dictionary } from "../types.ts";
import { forms } from "./forms.ts";
import { settings } from "./settings.ts";

/** A key missing here (or an extra one) is a type error: `Dictionary` mirrors `en`. */
export const es: Dictionary = {
  ...forms,
  ...settings,
};
