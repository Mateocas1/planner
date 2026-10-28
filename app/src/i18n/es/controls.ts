import type { Dictionary } from "../types.ts";

/** Neutral Spanish: infinitives and impersonal phrasing, no voseo. */
export const controls = {
  "block.startTime": "Hora de inicio",
  "block.endTime": "Hora de fin",
  "stepper.minutesUnit": "min",
  "stepper.decreaseAway": "Reducir el tiempo de ausencia",
  "stepper.increaseAway": "Aumentar el tiempo de ausencia",
} satisfies Partial<Dictionary>;
