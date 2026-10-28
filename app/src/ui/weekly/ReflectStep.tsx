import { t } from "../../i18n/index.ts";
import { MAX_NOTE_CHARS } from "../../planning/weekly.ts";

/**
 * The Reflect step (S3): a short note — what worked, what did not, one
 * intention — saved through the W2a API on the step's own save (the flow's
 * Next/Finish owns the write, so leaving the step never loses the text).
 *
 * The cap is the stored model's (`MAX_NOTE_CHARS`, 2000): the field counts
 * down, and an oversized note is refused by `saveWeeklyReviewNote` rather
 * than silently truncated, so the counter is the warning, not a guess.
 *
 * Hook for llm-chat S5: when the chat lands, the saved note becomes a chat
 * memory. The write goes through `data/weeklyReview.ts` `saveWeeklyReviewNote`
 * only — a future integration reads the same document (`readWeeklyReview`) and
 * feeds the note to the memory extractor, so no second write path is needed.
 */
export function ReflectStep({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const remaining = MAX_NOTE_CHARS - value.length;
  return (
    <div className="weekly-pane-body">
      <label htmlFor="weekly-reflect" className="weekly-lede">{t("weekly.reflect.prompt")}</label>
      <textarea
        id="weekly-reflect"
        className="weekly-reflect"
        value={value}
        onChange={event => onChange(event.target.value)}
        rows={7}
        placeholder={t("weekly.reflect.placeholder")}
      />
      <p className={`weekly-count${remaining < 0 ? " is-over" : ""}`} aria-live="polite">
        {remaining < 0 ? t("weekly.reflect.over", { count: -remaining }) : t("weekly.reflect.left", { count: remaining })}
      </p>
    </div>
  );
}
