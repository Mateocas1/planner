import { Section } from "../SettingRow.tsx";

/**
 * AI (design brief §4): a placeholder until the chat's setup task (C3) fills
 * it — API key, model and memories will live here. An honest empty state, not
 * disabled controls pretending to work.
 */
export function AiTab() {
  return (
    <Section title="Assistant">
      <div className="settings-empty">
        <p>Chat setup arrives with the assistant.</p>
        <p className="settings-row-desc">The API key, the model and the memories will live here.</p>
      </div>
    </Section>
  );
}
