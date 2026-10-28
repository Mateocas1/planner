import type { Dictionary } from "../types.ts";
import { settings } from "./settings.ts";
import { shell } from "./shell.ts";

/** A key missing here (or an extra one) is a type error: `Dictionary` mirrors `en`. */
export const es: Dictionary = {
  ...settings,
  ...shell,
};
