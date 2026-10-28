import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Popover } from "./Popover.tsx";
import { usePopover } from "./usePopover.ts";
import { isTypeaheadKey, moveActive, typeahead, type TypeaheadState } from "./typeahead.ts";
import "./Select.css";

export type SelectOption = { value: string; label: string };

const NAVIGATION_KEYS = ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"] as const;
type NavigationKey = (typeof NAVIGATION_KEYS)[number];
const isNavigationKey = (key: string): key is NavigationKey => (NAVIGATION_KEYS as readonly string[]).includes(key);

/**
 * A pop-up button (form-controls.md §6.1): the value, in the row's own
 * `.form-control` look, and a listbox in the shared Popover that grows from it.
 * Replaces the native `<select>`, whose menu is browser UI and cannot take the
 * app's entrance.
 *
 * ARIA APG "select-only combobox": the trigger keeps DOM focus the whole time
 * and points at the highlighted option with `aria-activedescendant`. The row's
 * `<label htmlFor={id}>` names the trigger; `label` names the listbox, and only
 * while it is open (see Popover.tsx). All strings come from the caller.
 */
export function Select({
  id,
  label,
  value,
  options,
  onChange,
  disabled = false,
  align = "end",
  className = "",
}: {
  id: string;
  /** Accessible name of the open listbox: the same text as the row's label. */
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  align?: "start" | "end";
  className?: string;
}) {
  const pop = usePopover({ align, initialFocus: "trigger" });
  const selected = options.findIndex(option => option.value === value);
  const [active, setActive] = useState(Math.max(selected, 0));
  const typed = useRef<TypeaheadState>({ buffer: "", at: 0 });

  const optionId = (index: number) => `${pop.id}-o${index}`;

  const openAt = (index: number) => {
    setActive(index);
    pop.show();
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    if (option.value !== value) onChange(option.value);
  };

  // The highlighted option stays in view when the keyboard moves it.
  useEffect(() => {
    if (!pop.open) return;
    pop.popoverRef.current?.querySelector('[role="option"][data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [pop.open, pop.popoverRef, active]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || event.nativeEvent.isComposing) return;
    const { key } = event;
    const liveBuffer = typed.current.buffer !== "" && event.timeStamp - typed.current.at <= 500;
    const typing = isTypeaheadKey(event) && (key !== " " || liveBuffer);
    if (typing) {
      event.preventDefault();
      const labels = options.map(option => option.label);
      const out = typeahead(labels, pop.open ? active : Math.max(selected, 0), key, typed.current, event.timeStamp);
      typed.current = out.state;
      if (pop.open) setActive(out.index);
      else openAt(out.index);
      return;
    }
    if (!pop.open) {
      if (key === "Enter" || key === " " || key === "ArrowDown" || key === "ArrowUp") {
        event.preventDefault();
        openAt(Math.max(selected, 0));
      }
      return;
    }
    if (isNavigationKey(key)) {
      event.preventDefault();
      setActive(moveActive(active, options.length, key));
      return;
    }
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      choose(active);
      pop.close();
      return;
    }
    if (key === "Tab") {
      // Choose and let focus continue where Tab takes it.
      choose(active);
      pop.close({ restoreFocus: false });
    }
  };

  return (
    <>
      <button
        ref={pop.triggerRef as RefObject<HTMLButtonElement>}
        id={id}
        type="button"
        role="combobox"
        className={`form-control select-trigger ${className}`}
        aria-haspopup="listbox"
        aria-expanded={pop.open}
        aria-controls={pop.id}
        aria-activedescendant={pop.open ? optionId(active) : undefined}
        data-value={value}
        disabled={disabled}
        onClick={() => {
          if (pop.open) pop.close();
          else openAt(Math.max(selected, 0));
        }}
        onKeyDown={onKeyDown}
        // Space activates on keyup; the keydown already handled it.
        onKeyUp={event => {
          if (event.key === " ") event.preventDefault();
        }}
      >
        <span className="select-value">{options[selected]?.label ?? ""}</span>
        <svg className="select-chevron" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3.5 4.75 6 2.25l2.5 2.5M3.5 7.25 6 9.75l2.5-2.5" />
        </svg>
      </button>
      <Popover pop={pop} label={label} role="listbox" className="select-pop">
        {options.map((option, index) => (
          <div
            key={option.value}
            id={optionId(index)}
            role="option"
            className="select-option"
            aria-selected={index === selected}
            data-active={index === active ? "true" : undefined}
            // DOM focus stays on the trigger.
            onMouseDown={event => event.preventDefault()}
            onPointerMove={() => {
              if (index !== active) setActive(index);
            }}
            onClick={() => {
              choose(index);
              pop.close();
            }}
          >
            <svg className="select-check" viewBox="0 0 14 14" aria-hidden="true">
              <path d="m2.75 7.25 2.75 2.75 5.75-6.25" />
            </svg>
            <span className="select-option-label">{option.label}</span>
          </div>
        ))}
      </Popover>
    </>
  );
}
