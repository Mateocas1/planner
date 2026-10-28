import type { ReactNode } from "react";
import type { PopoverHandle } from "./usePopover.ts";
import "./Popover.css";

/**
 * The shared floating surface for the form controls (a Select's list, the date
 * field's calendar). It is a native `popover="manual"` element: the top layer
 * is what lets it escape the sheet's `overflow`, `backdrop-filter` and animated
 * transform, and `manual` because light dismiss is ours (usePopover owns Escape,
 * outside click and focus so a sheet behind it is never dismissed by the same
 * press). Material, motion and placement: Popover.css, placePopover.ts.
 *
 * The element is always rendered, but empty and unnamed while closed: its
 * accessible name exists only while it is open. A permanently named listbox or
 * dialog would join every `getByLabel("Repeat")` / `getByLabel("Deadline")`
 * match and make each existing Playwright locator a strict-mode violation.
 * Content is mounted while open and while the exit runs, so the next press
 * always finds the same controls in the same place.
 *
 * `data-swipe-dismiss="off"` keeps a drag inside it from reaching the sheet's
 * swipe-to-dismiss (useSwipeDismiss.ts).
 */
export function Popover({
  pop,
  label,
  role = "dialog",
  className = "",
  children,
}: {
  pop: PopoverHandle;
  /** Accessible name, applied only while the popover is open. */
  label: string;
  role?: "dialog" | "listbox" | "menu";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      ref={pop.popoverRef}
      id={pop.id}
      popover="manual"
      role={role}
      tabIndex={-1}
      aria-label={pop.open ? label : undefined}
      aria-hidden={pop.open ? undefined : true}
      data-state={pop.open ? "open" : "closed"}
      data-swipe-dismiss="off"
      className={`pop ${className}`}
    >
      <div className="pop-body">{pop.mounted ? children : null}</div>
    </div>
  );
}
