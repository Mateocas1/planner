import { en } from "./en/index.ts";
import { es } from "./es/index.ts";

/** Both dictionaries, side by side. English is the source of truth for keys. */
export const dictionaries = { en, es } as const;
