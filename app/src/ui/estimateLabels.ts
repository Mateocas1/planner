import { formatEstimate } from "../domain/model.ts";
import { t } from "../i18n/index.ts";
import type { EstimatePreset } from "./EstimateControl.tsx";

/** The one-tap durations (form-controls §3.3): where estimates cluster. */
const PRESET_MINUTES = [15, 30, 45, 60, 120] as const;

/** The accessible name of a chip: "45 minutes", "1 hour". It never says "estimate". */
function presetName(minutes: number): string {
  return minutes % 60 === 0
    ? t("forms.estimate.presetHours", { count: minutes / 60 })
    : t("forms.estimate.presetMinutes", { minutes });
}

/** Everything EstimateControl needs besides the draft; read at render so a language switch applies. */
export function estimateControlLabels() {
  const presets: EstimatePreset[] = PRESET_MINUTES.map(minutes => ({
    minutes,
    text: formatEstimate(minutes),
    name: presetName(minutes),
  }));
  return {
    presets,
    presetsLabel: t("forms.estimate.presets"),
    placeholder: t("forms.estimate.placeholder"),
    unit: t("forms.estimate.unit"),
    decreaseLabel: t("forms.estimate.decrease"),
    increaseLabel: t("forms.estimate.increase"),
  };
}
