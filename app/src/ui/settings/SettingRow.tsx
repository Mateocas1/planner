import { useId, type ReactNode } from "react";

/**
 * The two primitives every settings tab is built from (design brief §3):
 *
 * - `Section` — a small label above one card of rows, at most three per tab.
 * - `SettingRow` — the only row pattern: label and description on the left
 *   (the description lives inside the row, never floating under a group),
 *   the control on the right, a hairline between rows, and the row's error
 *   line directly under the description.
 *
 * The label is the control's accessible name. A row whose control is a field
 * takes `controlId` and renders a real `<label htmlFor>`; the render prop
 * hands every row its label's id, so a switch can point at it with
 * `aria-labelledby` without callers threading ids by hand.
 */

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-section" aria-labelledby={`settings-section-${slug(title)}`}>
      <h3 id={`settings-section-${slug(title)}`} className="settings-section-title">{title}</h3>
      {description && <p className="settings-section-desc">{description}</p>}
      <div className="settings-card">{children}</div>
    </section>
  );
}

export function SettingRow({
  label,
  controlId,
  description,
  error,
  children,
}: {
  label: string;
  /** Set when the control is a field the label must name: the row then
   * renders a `<label htmlFor>`. Omitted for switches and buttons, which take
   * the id through the render prop instead. */
  controlId?: string;
  /** A calm note inside the row, two lines at most. */
  description?: string;
  /** This row's own refusal, under the description, announced. */
  error?: string | null;
  children: (labelId: string) => ReactNode;
}) {
  const labelId = useId();
  const labelNode =
    controlId !== undefined ? (
      <label id={labelId} htmlFor={controlId} className="settings-row-label">{label}</label>
    ) : (
      <span id={labelId} className="settings-row-label">{label}</span>
    );
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        {labelNode}
        {description && <span className="settings-row-desc">{description}</span>}
        {error && <span className="inline-error" role="alert">{error}</span>}
      </div>
      <div className="settings-row-control">{children(labelId)}</div>
    </div>
  );
}

/** A stable id fragment for a section title. */
function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
