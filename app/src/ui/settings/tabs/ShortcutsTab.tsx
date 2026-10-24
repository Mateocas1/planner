import { shortcutHelp } from "../../shortcuts.ts";
import { keycaps, rebindableShortcuts } from "../shortcutRegistry.ts";
import { ShortcutRecorder } from "../ShortcutRecorder.tsx";
import { Section, SettingRow } from "../SettingRow.tsx";

/**
 * Shortcuts (design brief §4–5, spec S2): the three rebindable chords as
 * recorder rows, the fixed shortcuts as a read-only list read straight from
 * `shortcutHelp` — the same table the help sheet renders, so the two cannot
 * disagree — and, when the master toggle is off, one note pointing at
 * General instead of duplicating the switch.
 */
export function ShortcutsTab({
  desktop,
  shortcutsEnabled,
  onOpenGeneral,
}: {
  desktop: boolean;
  shortcutsEnabled: boolean;
  onOpenGeneral: () => void;
}) {
  return (
    <>
      <Section title="Customize" description="Record a new combination; Escape cancels.">
        {rebindableShortcuts.map(shortcut => (
          <SettingRow
            key={shortcut.id}
            label={shortcut.label}
            description={
              shortcut.id === "palette"
                ? "The search-and-commands surface."
                : shortcut.id === "chat"
                  ? "The assistant's panel."
                  : "Opens the quick-add window from anywhere in Windows."
            }
          >
            {() => <ShortcutRecorder id={shortcut.id} desktop={desktop} />}
          </SettingRow>
        ))}
      </Section>
      <Section title="Built in" description="These are fixed; they stay out of the recorder's way.">
        {shortcutHelp
          .flatMap(group => group.entries)
          .filter(entry => !isRebindable(entry.label))
          .map(entry => (
            <div className="settings-row" key={entry.label}>
              <div className="settings-row-text">
                <span className="settings-row-label">{entry.label}</span>
              </div>
              <div className="settings-row-control shortcut-built-in">
                {entry.keys.map(key => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </div>
            </div>
          ))}
      </Section>
      {!shortcutsEnabled && (
        <p className="settings-coming-soon">
          Keyboard shortcuts are off.{" "}
          <button type="button" className="link-button" onClick={onOpenGeneral}>
            Turn them on in General
          </button>
          .
        </p>
      )}
    </>
  );
}

/** The palette and chat rows live in the recorder above; their default chords
 * must not appear twice in the read-only list. */
function isRebindable(label: string): boolean {
  return label === "Command palette" || label === "Chat panel";
}

/** The keycaps a recorder chip shows, re-exported for tests. */
export { keycaps };
