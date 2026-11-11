import { setProfileLanguage } from "../../../data/profile.ts";
import {
  languageNames,
  locales,
  setDeviceLanguage,
  setSyncedLanguage,
  t,
  useLanguage,
  type Locale,
} from "../../../i18n/index.ts";
import { settle } from "../../write.ts";
import { Section, SettingRow } from "../SettingRow.tsx";
import { SettingsSwitch } from "../SettingsSwitch.tsx";

/**
 * Settings > General > Language. Two rows, both ordinary Settings
 * idioms: the language is a two-option segmented choice (the same control as the
 * Range and theme switches, option names in their own language and never
 * translated), and the scope is a switch, because on/off in Settings is always a
 * switch (the round check is the completion mark, not a setting).
 *
 * Scope off (the default): a choice is saved to the account, so every device
 * follows it, and this device's own override is cleared. Scope on: the choice is
 * kept in this browser only and the account's value is left alone.
 */
export function LanguageSection({ uid }: { uid: string }) {
  const { locale, override } = useLanguage();
  const deviceOnly = override !== null;

  /** Saves a choice for every device. The shell's profile feed is updated at
   * once so the switch does not wait for the write to round-trip. */
  const saveToAccount = (next: Locale) => {
    setSyncedLanguage(next);
    setDeviceLanguage(null);
    void settle(setProfileLanguage(uid, next)).catch(() => undefined);
  };

  const choose = (next: Locale) => {
    if (next === locale) return;
    if (deviceOnly) setDeviceLanguage(next);
    else saveToAccount(next);
  };

  const toggleDeviceOnly = () => {
    if (deviceOnly) saveToAccount(locale);
    else setDeviceLanguage(locale);
  };

  return (
    <Section title={t("settings.language.title")}>
      <SettingRow label={t("settings.language.label")} description={t("settings.language.description")}>
        {labelId => (
          <div className="segmented" role="group" aria-labelledby={labelId}>
            {locales.map(option => (
              <button
                key={option}
                type="button"
                lang={option}
                aria-pressed={locale === option}
                onClick={() => choose(option)}
              >
                {languageNames[option]}
              </button>
            ))}
          </div>
        )}
      </SettingRow>
      <SettingRow label={t("settings.language.deviceOnly")} description={t("settings.language.deviceOnlyHelp")}>
        {labelId => <SettingsSwitch labelledBy={labelId} checked={deviceOnly} onChange={toggleDeviceOnly} />}
      </SettingRow>
    </Section>
  );
}
