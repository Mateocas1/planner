import { useCallback, useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { DEFAULT_CHAT_MODEL, getChatModel, normalizeChatModel, setChatModel } from "../../../chat/config.ts";
import { DEFAULT_CHAT_BASE_URL, clearKey, getKeyStatus, setKey, type ChatKeyStatus } from "../../../chat/keyStore.ts";
import {
  engramSettingsGet,
  engramSettingsSet,
  engramStatus,
  engramSyncNow,
  type EngramMirrorStatus,
  type EngramSettings,
} from "../../../chat/engramSettings.ts";
import { chatMemoriesClear, chatMemoriesDelete, chatMemoriesList, MEMORIES_CHANGED_EVENT, type Memory } from "../../../chat/memoryStore.ts";
import {
  apiKeyDescription,
  engramStatusText,
  keyStatusText,
  memoryDate,
  memoryPreview,
  providerDescription,
  validateEngramAddressClient,
  validateEngramProjectClient,
  validateBaseUrlClient,
  validateKeyClient,
} from "../aiSettings.ts";
import { t, useLocale } from "../../../i18n/index.ts";
import { Section, SettingRow } from "../SettingRow.tsx";
import { SettingsSwitch } from "../SettingsSwitch.tsx";
import "./AiTab.css";

/**
 * AI (design brief §4): the assistant's setup. The API key is
 * typed once, stored in the OS credential store by Rust, and never
 * returned to this page — the field is a password input that starts empty
 * every time and is cleared after a save. The base URL and the model are
 * non-secret settings; the model persists locally (`chat/config.ts`). The
 * memories are the durable notes the assistant extracts at conversation end,
 * listed newest first and editable only here.
 *
 * The tab renders on desktop only (the rail filters it); no motion beyond the
 * existing row patterns — confirmation is the app's inline swap (GcalImport's
 * pattern), not a dialog.
 */

export function AiTab() {
  useLocale();
  const [status, setStatus] = useState<ChatKeyStatus | null>(null);
  const [urlDraft, setUrlDraft] = useState(DEFAULT_CHAT_BASE_URL);
  const [keyDraft, setKeyDraft] = useState("");
  /** Replace mode: a key is saved and the user is entering a new one. */
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // One status read per mount: the tab unmounts on every switch, so coming
  // back re-checks. A key saved or removed elsewhere on desktop shows up then.
  useEffect(() => {
    let alive = true;
    getKeyStatus()
      .then(next => {
        if (!alive) return;
        setStatus(next);
        if (next.baseUrl !== null) setUrlDraft(next.baseUrl);
      })
      .catch(() => {
        // Rust unreachable (unexpected on desktop): show no key; a Save
        // attempt surfaces the real failure through the same error path.
        if (alive) setStatus({ hasKey: false, baseUrl: null });
      });
    return () => {
      alive = false;
    };
  }, []);

  const saved = status?.hasKey === true;
  const showKeyField = !saved || editing;

  const save = useCallback(async () => {
    const keyProblem = validateKeyClient(keyDraft);
    const urlProblem = validateBaseUrlClient(urlDraft);
    setKeyError(keyProblem);
    setUrlError(urlProblem);
    if (keyProblem !== null || urlProblem !== null) return;
    setBusy(true);
    try {
      await setKey(keyDraft.trim(), urlDraft.trim());
      setStatus({ hasKey: true, baseUrl: urlDraft.trim() });
      setKeyDraft(""); // the key never lingers in the page (spec S3)
      setEditing(false);
      setConfirmRemove(false);
    } catch (error) {
      // Rust's own wording (validation happens there too; it wins).
      setKeyError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [keyDraft, urlDraft]);

  const remove = useCallback(async () => {
    setBusy(true);
    try {
      await clearKey();
      setStatus({ hasKey: false, baseUrl: null });
      setConfirmRemove(false);
      setEditing(false);
      setKeyDraft("");
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const startReplace = () => {
    setEditing(true);
    setConfirmRemove(false);
    setKeyError(null);
    setUrlError(null);
    setUrlDraft(status?.baseUrl ?? DEFAULT_CHAT_BASE_URL);
  };

  const cancelEdit = () => {
    setEditing(false);
    setKeyError(null);
    setUrlError(null);
    setUrlDraft(status?.baseUrl ?? DEFAULT_CHAT_BASE_URL);
  };

  const onKeyFieldKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void save();
    }
  };

  return (
    <>
      <Section
        title={t("ai.provider.title")}
        description={providerDescription()}
      >
        <SettingRow
          label={t("ai.baseUrl.label")}
          controlId="ai-base-url"
          description={t("ai.baseUrl.description")}
          error={urlError}
        >
          {() => (
            <input
              id="ai-base-url"
              className="form-control ai-field"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={urlDraft}
              readOnly={saved && !editing}
              onChange={event => setUrlDraft(event.target.value)}
            />
          )}
        </SettingRow>
        {showKeyField && (
          <SettingRow
            label={t("ai.apiKey.label")}
            controlId="ai-api-key"
            description={apiKeyDescription()}
            error={keyError}
          >
            {() => (
              <input
                id="ai-api-key"
                className="form-control ai-field"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={saved ? t("ai.apiKey.placeholderNew") : t("ai.apiKey.placeholder")}
                value={keyDraft}
                onChange={event => setKeyDraft(event.target.value)}
                onKeyDown={onKeyFieldKeyDown}
              />
            )}
          </SettingRow>
        )}
        <SettingRow
          label={t("ai.keyStatus.label")}
          description={
            confirmRemove
              ? t("ai.keyStatus.confirm")
              : keyStatusText(status)
          }
        >
          {() =>
            saved && !editing ? (
              confirmRemove ? (
                <div className="ai-actions" role="group" aria-label={t("ai.confirmRemoveKey")}>
                  <button type="button" className="button-danger ai-button" disabled={busy} onClick={() => void remove()}>
                    {t("ai.remove")}
                  </button>
                  <button type="button" className="button ai-button" onClick={() => setConfirmRemove(false)}>
                    {t("ai.keep")}
                  </button>
                </div>
              ) : (
                <div className="ai-actions">
                  <button type="button" className="button ai-button" onClick={startReplace}>
                    {t("ai.replace")}
                  </button>
                  <button type="button" className="button ai-button" onClick={() => setConfirmRemove(true)}>
                    {t("ai.remove")}
                  </button>
                </div>
              )
            ) : (
              <div className="ai-actions">
                <button type="button" className="button ai-button" disabled={busy} onClick={() => void save()}>
                  {t("ai.save")}
                </button>
                {editing && (
                  <button type="button" className="button ai-button" onClick={cancelEdit}>
                    {t("ai.cancel")}
                  </button>
                )}
              </div>
            )
          }
        </SettingRow>
      </Section>

      <ModelSection />

      <MemoriesSection />

      <p className="ai-privacy">{t("ai.privacy")}</p>
    </>
  );
}

/**
 * The model every request names: a free-text field with the NaN
 * default as its one suggestion. Saved locally as the user leaves the field,
 * the way General's time fields commit; an empty commit is refused, never
 * guessed.
 */
function ModelSection() {
  useLocale();
  const [draft, setDraft] = useState(() => getChatModel());
  const [error, setError] = useState<string | null>(null);

  const commit = () => {
    const text = draft.trim();
    if (text === "") {
      setError(t("ai.model.error"));
      return;
    }
    setError(null);
    setChatModel(text);
    setDraft(normalizeChatModel(text));
  };

  const onFieldKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    }
  };

  const restoreDefault = () => {
    setChatModel(DEFAULT_CHAT_MODEL);
    setDraft(DEFAULT_CHAT_MODEL);
    setError(null);
  };

  return (
    <Section title={t("ai.model.title")} description={t("ai.model.description")}>
      <SettingRow label={t("ai.model.label")} controlId="ai-model" error={error}>
        {() => (
          <>
            <input
              id="ai-model"
              className="form-control ai-field"
              type="text"
              list="ai-model-suggestions"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              onChange={event => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={onFieldKeyDown}
            />
            <datalist id="ai-model-suggestions">
              <option value={DEFAULT_CHAT_MODEL} />
            </datalist>
            {draft.trim() !== DEFAULT_CHAT_MODEL && (
              <button type="button" className="link-button" onClick={restoreDefault}>
                {t("ai.model.restoreDefault")}
              </button>
            )}
          </>
        )}
      </SettingRow>
    </Section>
  );
}

/**
 * The durable memories: listed newest first, one delete per row,
 * "Clear all" behind a confirm. Refreshed on mount — the tab remounts on
 * every visit — and whenever the chat changes the notes under it (a
 * confirmed remember/forget or an extraction) through the
 * `planner:chat-memories-changed` window event, so the list is current
 * whenever it is shown.
 */
function MemoriesSection() {
  useLocale();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setMemories(await chatMemoriesList());
    } catch (error) {
      console.warn("settings: loading memories failed", error);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Notes changed elsewhere (the chat's memory tools or extraction).
  useEffect(() => {
    const onChange = () => void refresh();
    window.addEventListener(MEMORIES_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(MEMORIES_CHANGED_EVENT, onChange);
  }, [refresh]);

  const deleteOne = async (id: string) => {
    try {
      setMemories(await chatMemoriesDelete(id));
    } catch (error) {
      console.warn("settings: deleting a memory failed", error);
    }
  };

  const clearAll = async () => {
    try {
      setMemories(await chatMemoriesClear());
      setConfirmClear(false);
    } catch (error) {
      console.warn("settings: clearing memories failed", error);
    }
  };

  const sorted = [...memories].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <Section title={t("ai.memories.title")} description={t("ai.memories.description")}>
      <EngramSection />
      {sorted.length === 0 ? (
        <div className="settings-empty">
          <p>{t("ai.memories.empty")}</p>
          <p className="settings-row-desc">{t("ai.memories.emptyHint")}</p>
        </div>
      ) : (
        <>
          {sorted.map(memory => (
            <div className="settings-row" key={memory.id}>
              <div className="settings-row-text">
                <span className="settings-row-label">{memory.title}</span>
                <span className="settings-row-desc">{memoryPreview(memory.content)}</span>
                <span className="ai-memory-date">{memoryDate(memory.updatedAt)}</span>
              </div>
              <div className="settings-row-control">
                <button type="button" className="link-button ai-danger-link" onClick={() => void deleteOne(memory.id)}>
                  {t("ai.memories.delete")}
                </button>
              </div>
            </div>
          ))}
          <div className="settings-row">
            <div className="settings-row-text">
              <span className="settings-row-label">{t("ai.memories.clearAll")}</span>
              <span className="settings-row-desc">
                {confirmClear ? t("ai.memories.clearConfirm") : t("ai.memories.clearAll.description")}
              </span>
            </div>
            <div className="settings-row-control">
              {confirmClear ? (
                <div className="ai-actions" role="group" aria-label={t("ai.memories.clearConfirmLabel")}>
                  <button type="button" className="button-danger ai-button" onClick={() => void clearAll()}>
                    {t("ai.memories.clear")}
                  </button>
                  <button type="button" className="button ai-button" onClick={() => setConfirmClear(false)}>
                    {t("ai.keep")}
                  </button>
                </div>
              ) : (
                <button type="button" className="button ai-button" onClick={() => setConfirmClear(true)}>
                  {t("ai.memories.clearAll")}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </Section>
  );
}

/**
 * The Engram mirror controls: an optional write-through
 * copy of the memories on a local Engram server. The local store stays the
 * source of truth — mirroring happens in Rust after every applied memory op,
 * best effort, so a dead Engram never blocks the chat; "Sync now" pushes the
 * whole store and reports the last attempt here.
 */
function EngramSection() {
  useLocale();
  const [settings, setSettings] = useState<EngramSettings | null>(null);
  const [status, setStatus] = useState<EngramMirrorStatus | null>(null);
  const [addressDraft, setAddressDraft] = useState("");
  const [projectDraft, setProjectDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // One settings + status read per mount: the tab unmounts on every switch.
  useEffect(() => {
    let alive = true;
    engramSettingsGet()
      .then(loaded => {
        if (!alive) return;
        setSettings(loaded);
        setAddressDraft(loaded.address);
        setProjectDraft(loaded.project);
      })
      .catch(loadingFailure => {
        // Rust unreachable (unexpected on desktop): leave the controls off.
        console.warn("settings: loading Engram settings failed", loadingFailure);
      });
    engramStatus()
      .then(loaded => {
        if (alive) setStatus(loaded);
      })
      .catch(() => {
        /* the status line stays "Not synced yet." */
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = useCallback(
    async (next: EngramSettings) => {
      const addressProblem = validateEngramAddressClient(next.address);
      const projectProblem = validateEngramProjectClient(next.project);
      setError(addressProblem ?? projectProblem);
      if (addressProblem !== null || projectProblem !== null) return false;
      setBusy(true);
      try {
        await engramSettingsSet({ ...next, address: next.address.trim(), project: next.project.trim() });
        setSettings({ ...next, address: next.address.trim(), project: next.project.trim() });
        return true;
      } catch (saveError) {
        // Rust's own wording (validation happens there too; it wins).
        setError(saveError instanceof Error ? saveError.message : String(saveError));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const toggle = useCallback(() => {
    if (settings === null || busy) return;
    void save({ ...settings, enabled: !settings.enabled });
  }, [settings, busy, save]);

  const syncNow = useCallback(async () => {
    if (settings === null || !settings.enabled || busy) return;
    // A refused save (bad address draft) must not trigger a sync of the
    // stored (different) settings.
    if (!(await save(settings))) return;
    setBusy(true);
    try {
      setStatus(await engramSyncNow());
      setError(null);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : String(syncError));
    } finally {
      setBusy(false);
    }
  }, [settings, busy, save]);

  if (settings === null) return null;

  return (
    <>
      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-label">{t("ai.engram.label")}</span>
          <span className="settings-row-desc">{t("ai.engram.description")}</span>
          <span className="ai-memory-date">{engramStatusText(settings.enabled, status)}</span>
        </div>
        <div className="settings-row-control">
          <SettingsSwitch labelledBy="engram-enabled" checked={settings.enabled} disabled={busy} onChange={toggle} />
        </div>
      </div>
      {settings.enabled && (
        <>
          <SettingRow
            label={t("ai.engram.addressLabel")}
            controlId="engram-address"
            description={t("ai.engram.addressDescription")}
            error={error}
          >
            {() => (
              <input
                id="engram-address"
                className="form-control ai-field"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={addressDraft}
                onChange={event => setAddressDraft(event.target.value)}
              />
            )}
          </SettingRow>
          <SettingRow
            label={t("ai.engram.projectLabel")}
            controlId="engram-project"
            description={t("ai.engram.projectDescription")}
          >
            {() => (
              <input
                id="engram-project"
                className="form-control ai-field"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={projectDraft}
                onChange={event => setProjectDraft(event.target.value)}
              />
            )}
          </SettingRow>
          <div className="settings-row">
            <div className="settings-row-text">
              <span className="settings-row-label">{t("ai.engram.syncNow")}</span>
              <span className="settings-row-desc">{t("ai.engram.syncNowDescription")}</span>
            </div>
            <div className="settings-row-control">
              <button type="button" className="button ai-button" disabled={busy} onClick={() => void syncNow()}>
                {t("ai.engram.syncNow")}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
