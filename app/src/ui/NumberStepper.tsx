import type { KeyboardEvent, MouseEvent } from "react";
import { digitsOnly } from "./estimateStep.ts";
import { stepWithin } from "./numberStep.ts";
import "./EstimateControl.css";
import "./NumberStepper.css";

export interface NumberStepperProps {
  id: string;
  /** The draft as bare digits. */
  draft: string;
  /** The stored value; an empty or unreadable draft steps from it. */
  stored: number;
  min: number;
  max: number;
  onDraftChange: (draft: string) => void;
  /** Commit the given draft (always passed explicitly, never read from stale state). */
  onCommit: (draft: string) => void;
  /** Unit adornment after the digits, e.g. "min". */
  unit: string;
  decreaseLabel: string;
  increaseLabel: string;
  describedBy?: string;
  invalid?: boolean;
}

/**
 * A digits-only field with a unit and a ghost -/+ stepper: the look of the
 * estimate field (EstimateControl.css) without its preset chips, for a number
 * with a small range (the away threshold). It replaces `type="number"`, whose
 * spinner is browser UI. Arrow keys and the buttons step by one (Shift or
 * Page keys by ten) and commit at once; typing commits on blur or Enter.
 */
export function NumberStepper(props: NumberStepperProps) {
  const { id, draft, stored, min, max, onDraftChange, onCommit } = props;
  const current = draft === "" ? undefined : Number(draft);

  const step = (delta: number) => {
    const next = String(stepWithin(draft, delta, min, max, stored));
    onDraftChange(next);
    onCommit(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const big = event.shiftKey ? 10 : 1;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      step(event.key === "ArrowUp" ? big : -big);
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      step(event.key === "PageUp" ? 10 : -10);
    } else if (event.key === "Enter") {
      event.preventDefault();
      onCommit(draft);
    }
  };

  // Keep focus in the field when a stepper button is pressed with the pointer.
  const keepFocus = (event: MouseEvent) => event.preventDefault();

  return (
    <div className="est-field num-stepper">
      <input
        id={id}
        className="est-input"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        role="spinbutton"
        autoComplete="off"
        value={draft}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={current}
        aria-valuetext={current === undefined ? undefined : `${current} ${props.unit}`}
        aria-describedby={props.describedBy}
        aria-invalid={props.invalid || undefined}
        onChange={event => onDraftChange(digitsOnly(event.target.value))}
        onBlur={() => onCommit(draft)}
        onKeyDown={onKeyDown}
      />
      <span className="est-unit" aria-hidden="true">{props.unit}</span>
      <button
        type="button"
        className="est-step"
        tabIndex={-1}
        aria-label={props.decreaseLabel}
        disabled={current !== undefined && current <= min}
        onMouseDown={keepFocus}
        onClick={() => step(-1)}
      >
        <StepGlyph plus={false} />
      </button>
      <button
        type="button"
        className="est-step"
        tabIndex={-1}
        aria-label={props.increaseLabel}
        disabled={current !== undefined && current >= max}
        onMouseDown={keepFocus}
        onClick={() => step(1)}
      >
        <StepGlyph plus />
      </button>
    </div>
  );
}

function StepGlyph({ plus }: { plus: boolean }) {
  return (
    <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false">
      <path d={plus ? "M7 2.5v9M2.5 7h9" : "M2.5 7h9"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
