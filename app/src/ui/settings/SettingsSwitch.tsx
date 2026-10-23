import type { ReactNode } from "react";

/**
 * The settings switch, moved from the old Day settings sheet unchanged in
 * behaviour and paint (ui/Settings.css carried it before): the state is told
 * three ways — the knob's end, the track's fill and `aria-checked` — and the
 * knob never animates, so reduced motion has nothing to undo. The button
 * borrows the row's height so a thumb has a 44 px target.
 */
export function SettingsSwitch({
  labelledBy,
  checked,
  disabled = false,
  onChange,
}: {
  labelledBy: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="day-switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={onChange}
    >
      <span className="day-switch-track" aria-hidden="true">
        <span className="day-switch-knob" />
      </span>
    </button>
  );
}

/** The general-purpose switch row body, for switches that announce themselves
 * with their own visible text instead of a SettingRow label. */
export function SwitchRow({ label, checked, onChange, children }: {
  label: string;
  checked: boolean;
  onChange: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="form-row">
      <span id={`sw-${cssId(label)}`}>{label}</span>
      <button
        type="button"
        role="switch"
        className="day-switch"
        aria-checked={checked}
        aria-labelledby={`sw-${cssId(label)}`}
        onClick={onChange}
      >
        <span className="day-switch-track" aria-hidden="true">
          <span className="day-switch-knob" />
        </span>
      </button>
      {children}
    </div>
  );
}

function cssId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
