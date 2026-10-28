import { t } from "../i18n/index.ts";
import type { DateFieldLabels } from "./DateField.tsx";

/** Copy for every DateField call site; getters, so a language switch reaches the next render. */
export const dateFieldLabels: DateFieldLabels = {
  get today() { return t("forms.date.today"); },
  get tomorrow() { return t("forms.date.tomorrow"); },
  get thisWeekend() { return t("forms.date.thisWeekend"); },
  get nextWeek() { return t("forms.date.nextWeek"); },
  get noDate() { return t("forms.date.noDate"); },
  get choose() { return t("forms.date.choose"); },
  get prevMonth() { return t("forms.date.prevMonth"); },
  get nextMonth() { return t("forms.date.nextMonth"); },
};
