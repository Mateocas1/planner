import { formatEstimate } from "../domain/model.ts";
import { capitalize } from "../i18n/capitalize.ts";
import { t } from "../i18n/index.ts";
import type { CaptureImpact } from "../planning/captureImpact.ts";
import { DateField } from "../ui/DateField.tsx";
import { dateFieldLabels } from "../ui/DateField.labels.ts";
import { EstimateControl } from "../ui/EstimateControl.tsx";
import { estimateControlLabels } from "../ui/estimateLabels.ts";
import { formatDateKey } from "../ui/format.ts";
import { pad } from "../ui/time.ts";
import type { Card, Draft } from "./captureView.ts";
import type { CaptureProposal } from "./schema.ts";
import "./CaptureSheet.css";

const clock = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/**
 * One proposal, before anything is written (plan §2): title, due day, estimate,
 * the radar's before -> after for that day, the line of the text it came from,
 * and Discard / Edit / Add. Edit expands in place with the New task sheet's own
 * controls. The card never writes: Add calls back into the sheet.
 */
export function CaptureCard({
  index,
  card,
  proposal,
  impact,
  similar,
  todayKey,
  canAdd,
  onEdit,
  onToggleEdit,
  onAdd,
  onDiscard,
}: {
  index: number;
  card: Card;
  proposal: CaptureProposal;
  /** The radar for the draft as edited, or null (no due day). */
  impact: CaptureImpact | null;
  /** An open task already carries this title. */
  similar: boolean;
  todayKey: string;
  /** False when nobody is signed in. */
  canAdd: boolean;
  onEdit: (patch: Partial<Draft>) => void;
  onToggleEdit: () => void;
  onAdd: () => void;
  onDiscard: () => void;
}) {
  const { draft, status } = card;
  if (status === "discarded") return null;
  if (status === "added") {
    return (
      <li className="capture-card is-added">
        <p className="capture-added" role="status">
          <span className="capture-added-label">{t("capture.addedCard")}</span> {draft.title.trim()}
        </p>
      </li>
    );
  }

  const saving = status === "saving";
  const estimate = draft.estimate === "" ? null : Number(draft.estimate);
  const meta = [
    draft.dueDay === "" ? t("capture.noDue") : capitalize(formatDateKey(draft.dueDay, todayKey)),
    estimate === null ? t("capture.noEstimate") : formatEstimate(estimate),
  ].join(" · ");
  const slot = impact?.slot ?? null;
  const bias = impact?.bias ?? null;
  const id = `capture-card-${index}`;

  return (
    <li className="capture-card" aria-busy={saving || undefined}>
      <div className="capture-card-main">
        <p className="capture-card-title">{draft.title.trim() === "" ? t("capture.cardTitle") : draft.title}</p>
        <p className="capture-card-meta">{meta}</p>
        {impact !== null && (
          <p className="capture-card-impact">
            {t("capture.impact", {
              day: capitalize(formatDateKey(impact.dueDay, todayKey)),
              before: impact.before.percentBooked,
              after: impact.afterPercent,
            })}
            {impact.overbooked && <span className="capture-over"> · {t("capture.overbooked", { minutes: impact.overMinutes })}</span>}
          </p>
        )}
        {(bias !== null || slot !== null) && (
          <div className="capture-chips">
            {bias !== null && (
              <>
                <p className="capture-bias">
                  {bias.percent > 0
                    ? t("capture.bias.over", { percent: bias.percent, minutes: bias.minutes })
                    : t("capture.bias.under", { percent: Math.abs(bias.percent), minutes: bias.minutes })}
                </p>
                <button
                  type="button"
                  className="button small"
                  disabled={saving}
                  onClick={() => onEdit({ estimate: String(bias.minutes) })}
                >
                  {t("capture.bias.use", { minutes: bias.minutes })}
                </button>
              </>
            )}
            {slot !== null && (
              <button
                type="button"
                className="button small capture-block"
                aria-pressed={draft.block}
                disabled={saving}
                onClick={() => onEdit({ block: !draft.block })}
              >
                {t("capture.block", { time: clock(slot.startMinutes) })}
              </button>
            )}
          </div>
        )}
        {similar && <p className="capture-warn">{t("capture.similar")}</p>}
        {proposal.dateIgnored && <p className="capture-warn">{t("capture.dateIgnored")}</p>}
        {proposal.quote !== null && <p className="capture-quote">{t("capture.quote", { quote: proposal.quote })}</p>}
      </div>

      {card.editing && (
        <div className="form-group capture-edit">
          <div className="form-row stacked">
            <label htmlFor={`${id}-title`}>{t("capture.cardTitle")}</label>
            <input
              id={`${id}-title`}
              className="form-control"
              type="text"
              autoComplete="off"
              value={draft.title}
              disabled={saving}
              onChange={event => onEdit({ title: event.target.value })}
            />
          </div>
          <div className="form-row">
            <label htmlFor={`${id}-due`}>{t("capture.due")}</label>
            <DateField
              id={`${id}-due`}
              value={draft.dueDay}
              today={todayKey}
              labels={dateFieldLabels}
              disabled={saving}
              onChange={value => onEdit({ dueDay: value, ...(value === "" ? { block: false } : {}) })}
            />
          </div>
          <div className="form-row stacked">
            <label htmlFor={`${id}-estimate`}>{t("capture.estimate")}</label>
            <EstimateControl
              id={`${id}-estimate`}
              draft={draft.estimate}
              revertTo={draft.estimate}
              disabled={saving}
              onDraftChange={value => onEdit({ estimate: value })}
              onCommit={() => undefined}
              {...estimateControlLabels()}
            />
          </div>
        </div>
      )}

      {card.error !== null && <p className="inline-error" role="alert">{card.error}</p>}

      <div className="capture-card-actions">
        <button type="button" className="button small" disabled={saving} onClick={onDiscard}>{t("capture.discard")}</button>
        <button type="button" className="button small" disabled={saving} aria-expanded={card.editing} onClick={onToggleEdit}>
          {card.editing ? t("capture.editDone") : t("capture.edit")}
        </button>
        <button
          type="button"
          className="button small button-accent"
          disabled={saving || !canAdd || draft.title.trim() === ""}
          onClick={onAdd}
        >
          {saving ? t("capture.adding") : t("capture.add")}
        </button>
      </div>
    </li>
  );
}
