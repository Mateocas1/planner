import { useEffect, useRef } from "react";
import { t, useLocale } from "../i18n/index.ts";
import { CloseIcon } from "./icons.tsx";
import { shortcutHelp } from "./shortcuts.ts";
import "./ShortcutHelp.css";

/**
 * The keyboard's own reference (distinctive roadmap F6, criterion 4): every
 * shortcut, grouped by what it is for, opened with `?` and closed with Escape.
 * The content is `shortcutHelp` in ui/shortcuts.ts, so the sheet and the router
 * cannot disagree about which keys exist.
 *
 * It is a native modal `<dialog>`: the browser traps focus inside it, answers
 * Escape through `cancel`, and paints it in the top layer over every sheet --
 * the same mechanism the command palette uses. The shell's key listener asks
 * `dialogOpen()` before routing, so nothing behind the sheet reacts to a key
 * while it is up.
 *
 * Nothing animates. DESIGN.md is explicit that a keyboard shortcut animates
 * nothing, and the panel a shortcut opens is part of that: it is simply there on
 * the next frame, fully legible, ready for the next key.
 */
export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  useLocale();
  const dialogRef = useRef<HTMLDialogElement>(null);

  // showModal, not the `open` attribute: only the modal form gives the sheet the
  // top layer and the focus trap. It mounts closed for one microtask, so the
  // browser never paints a non-modal dialog first.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="shortcut-help glass glass-thick"
      aria-labelledby="shortcut-help-heading"
      data-dialog="shortcuts"
      onCancel={event => {
        // React owns the open state, so the native close is intercepted and the
        // shell unmounts the sheet.
        event.preventDefault();
        onClose();
      }}
      onClick={event => {
        // A click on the backdrop is a dismissal; one inside the card is not.
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <header className="shortcut-help-head">
        <h2 id="shortcut-help-heading">{t("shortcuts.title")}</h2>
        <button type="button" className="icon-button" aria-label={t("shortcuts.close")} onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="shortcut-help-groups">
        {shortcutHelp.map(group => (
          <section className="shortcut-help-group" key={group.id} aria-labelledby={`shortcut-help-${group.id}`}>
            <h3 id={`shortcut-help-${group.id}`}>{group.title}</h3>
            <ul className="shortcut-help-list">
              {group.entries.map(entry => (
                <li className="shortcut-help-row" key={entry.label}>
                  <span className="shortcut-help-keys">
                    {entry.keys.map(key => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </span>
                  <span className="shortcut-help-label">{entry.label}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </dialog>
  );
}
