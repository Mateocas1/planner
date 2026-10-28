import type { DateFieldLabels } from "./DateField.tsx";

/** English copy for every DateField call site; the i18n `t()` replaces it when the surfaces are wired to it. */
export const dateFieldLabels: DateFieldLabels = {
  today: "Today",
  tomorrow: "Tomorrow",
  thisWeekend: "This weekend",
  nextWeek: "Next week",
  noDate: "No date",
  choose: "Choose date",
  prevMonth: "Previous month",
  nextMonth: "Next month",
};
