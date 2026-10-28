import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { MAX_ESTIMATE_MINUTES, MIN_ESTIMATE_MINUTES } from "../domain/model.ts";
import { ESTIMATE_COARSE_STEP, ESTIMATE_GRID_MINUTES, digitsOnly, parseDraft, stepEstimate } from "./estimateStep.ts";
import "./EstimateControl.css";

/** Quiet time after the last stepper click or arrow key before the draft is committed. */
export const ESTIMATE_COMMIT_DELAY_MS = 400;

export interface EstimatePreset {
  minutes: number;
  /** Visible chip text, e.g. "15m". */
  text: string;
  /** Accessible name, e.g. "15 minutes". Must not contain the word "estimate". */
  name: string;
}

export interface EstimateControlProps {
  /** Id of the text input; the caller's <label htmlFor> points here. */
  id: string;
  /** The draft as bare digits, or "" for the 60-minute assumption. */
  draft: string;
  /** The stored value as digits; Escape reverts the draft to it. */
  revertTo: string;
  onDraftChange: (draft: string) => void;
  /** Commit the given draft (always passed explicitly, never read from stale state). */
  onCommit: (draft: string) => void;
  disabled?: boolean;
  describedBy?: string;
  presets: readonly EstimatePreset[];
  presetsLabel: string;
  placeholder: string;
  /** Unit adornment after the digits, e.g. "min". */
  unit: string;
  decreaseLabel: string;
  increaseLabel: string;
}

/**
 * Debounced commit for keyboard- and stepper-driven edits: `schedule` restarts
 * the quiet timer, `flush` commits at once if one is pending, `cancel` drops
 * it. The pending commit is flushed on unmount so a value typed just before the
 * sheet closes is never lost.
 */
function useDebouncedCommit(commit: () => void, delayMs: number) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(commit);
  latest.current = commit;

  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const flush = () => {
    if (timer.current === null) return;
    cancel();
    latest.current();
  };
  const schedule = () => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      latest.current();
    }, delayMs);
  };
  useEffect(() => flush, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { schedule, flush, cancel };
}

function Glyph({ plus }: { plus: boolean }) {
  return (
    <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false">
      <path d={plus ? "M7 2.5v9M2.5 7h9" : "M2.5 7h9"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function EstimateControl(props: EstimateControlProps) {
  const { id, draft, revertTo, onDraftChange, onCommit, disabled, describedBy, presets } = props;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const debounced = useDebouncedCommit(() => onCommit(draftRef.current), ESTIMATE_COMMIT_DELAY_MS);

  const current = parseDraft(draft);
  const setDraft = (next: string) => {
    draftRef.current = next;
    onDraftChange(next);
  };
  const step = (delta: number) => {
    setDraft(String(stepEstimate(parseDraft(draftRef.current), delta)));
    debounced.schedule();
  };
  const commitNow = () => {
    debounced.cancel();
    onCommit(draftRef.current);
  };
  const pressPreset = (minutes: number) => {
    debounced.cancel();
    const next = current === minutes ? "" : String(minutes);
    setDraft(next);
    onCommit(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const size = event.shiftKey ? ESTIMATE_COARSE_STEP : ESTIMATE_GRID_MINUTES;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      step(event.key === "ArrowUp" ? size : -size);
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      step(event.key === "PageUp" ? ESTIMATE_COARSE_STEP : -ESTIMATE_COARSE_STEP);
    } else if (event.key === "Enter") {
      event.preventDefault();
      commitNow();
    } else if (event.key === "Escape" && draftRef.current !== revertTo) {
      event.stopPropagation();
      debounced.cancel();
      setDraft(revertTo);
    }
  };

  const atMin = current !== undefined && current <= MIN_ESTIMATE_MINUTES;
  const atMax = current !== undefined && current >= MAX_ESTIMATE_MINUTES;
  // Keep focus in the field when a stepper button is pressed with the pointer.
  const keepFocus = (event: React.MouseEvent) => event.preventDefault();

  return (
    <div className="est-control">
      <div className="est-chips" role="group" aria-label={props.presetsLabel}>
        {presets.map(preset => (
          <button
            key={preset.minutes}
            type="button"
            className="est-chip"
            aria-label={preset.name}
            aria-pressed={current === preset.minutes}
            disabled={disabled}
            onClick={() => pressPreset(preset.minutes)}
          >
            {preset.text}
          </button>
        ))}
      </div>
      <div className="est-field">
        <input
          id={id}
          className="est-input"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          role="spinbutton"
          autoComplete="off"
          placeholder={props.placeholder}
          value={draft}
          disabled={disabled}
          aria-valuemin={MIN_ESTIMATE_MINUTES}
          aria-valuemax={MAX_ESTIMATE_MINUTES}
          aria-valuenow={current}
          aria-valuetext={current === undefined ? undefined : `${current} ${props.unit}`}
          aria-describedby={describedBy}
          onChange={event => setDraft(digitsOnly(event.target.value))}
          onBlur={() => {
            debounced.cancel();
            onCommit(draftRef.current);
          }}
          onKeyDown={onKeyDown}
        />
        <span className="est-unit" aria-hidden="true">{props.unit}</span>
        <button
          type="button"
          className="est-step"
          tabIndex={-1}
          aria-label={props.decreaseLabel}
          disabled={disabled || atMin}
          onMouseDown={keepFocus}
          onClick={() => step(-ESTIMATE_GRID_MINUTES)}
        >
          <Glyph plus={false} />
        </button>
        <button
          type="button"
          className="est-step"
          tabIndex={-1}
          aria-label={props.increaseLabel}
          disabled={disabled || atMax}
          onMouseDown={keepFocus}
          onClick={() => step(ESTIMATE_GRID_MINUTES)}
        >
          <Glyph plus />
        </button>
      </div>
    </div>
  );
}
