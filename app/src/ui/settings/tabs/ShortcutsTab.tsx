import { t, useLocale } from "../../../i18n/index.ts";
import { shortcutHelp } from "../../shortcuts.ts";
import { keycaps, rebindableShortcuts } from "../shortcutRegistry.ts";
import { Keycap } from "../Keycap.tsx";
import { quickAddDescription } from "../desktopCopy.ts";
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
  useLocale();
  return (
    <>
      <Section title={t("shortcuts.customize.title")} description={t("shortcuts.customize.description")}>
        {/* Desktop-only rows are not rendered on the web: no label without a control. */}
        {rebindableShortcuts.filter(shortcut => desktop || !shortcut.desktopOnly).map(shortcut => (
          <SettingRow
            key={shortcut.id}
            label={shortcut.label}
            description={
              shortcut.id === "palette"
                ? t("shortcuts.palette.description")
                : shortcut.id === "chat"
                  ? t("shortcuts.chat.description")
                  : quickAddDescription()
            }
          >
            {() => <ShortcutRecorder id={shortcut.id} desktop={desktop} />}
          </SettingRow>
        ))}
      </Section>
      <Section title={t("shortcuts.builtIn.title")} description={t("shortcuts.builtIn.description")}>
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
                  <Keycap key={key}>{key}</Keycap>
                ))}
              </div>
            </div>
          ))}
      </Section>
      {!shortcutsEnabled && (
        <p className="settings-coming-soon">
          {t("shortcuts.off")}{" "}
          <button type="button" className="link-button" onClick={onOpenGeneral}>
            {t("shortcuts.turnOn")}
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
  return label === t("shortcuts.palette") || label === t("shortcuts.chat");
}

/** The keycaps a recorder chip shows, re-exported for tests. */
export { keycaps };
