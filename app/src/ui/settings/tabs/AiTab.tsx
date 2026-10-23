import { useCallback, useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { DEFAULT_CHAT_MODEL, getChatModel, normalizeChatModel, setChatModel } from "../../../chat/config.ts";
import { DEFAULT_CHAT_BASE_URL, clearKey, getKeyStatus, setKey, type ChatKeyStatus } from "../../../chat/keyStore.ts";
import { chatMemoriesClear, chatMemoriesDelete, chatMemoriesList, type Memory } from "../../../chat/memoryStore.ts";
import {
  keyStatusText,
  memoryDate,
  memoryPreview,
  validateBaseUrlClient,
  validateKeyClient,
} from "../aiSettings.ts";
import { Section, SettingRow } from "../SettingRow.tsx";
import "./AiTab.css";

/**
 * AI (design brief §4, spec S3 + S5): the assistant's setup. The API key is
 * typed once, stored in the Windows Credential Manager by Rust, and never
 * returned to this page — the field is a password input that starts empty
 * every time and is cleared after a save. The base URL and the model are
 * non-secret settings; the model persists locally (`chat/config.ts`). The
 * memories are the durable notes the assistant extracts at conversation end
 * (S5), listed newest first and editable only here.
 *
 * The tab renders on desktop only (the rail filters it); no motion beyond the
 * existing row patterns — confirmation is the app's inline swap (GcalImport's
 * pattern), not a dialog.
 */

export function AiTab() {
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
        title="Provider"
        description="An OpenAI-compatible endpoint. The key lives in Windows Credential Manager and is never returned to this page."
      >
        <SettingRow
          label="Base URL"
          controlId="ai-base-url"
          description="https://, or http:// on this computer (localhost). Changing it means entering the key again."
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
            label="API key"
            controlId="ai-api-key"
            description="Paste the provider's key. It is written to Windows Credential Manager and cleared from this field after saving."
            error={keyError}
          >
            {() => (
              <input
                id="ai-api-key"
                className="form-control ai-field"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={saved ? "Paste the new key" : "Paste your key"}
                value={keyDraft}
                onChange={event => setKeyDraft(event.target.value)}
                onKeyDown={onKeyFieldKeyDown}
              />
            )}
          </SettingRow>
        )}
        <SettingRow
          label="Key status"
          description={
            confirmRemove
              ? "Remove the saved key? The assistant asks for it again before the next chat."
              : keyStatusText(status)
          }
        >
          {() =>
            saved && !editing ? (
              confirmRemove ? (
                <div className="ai-actions" role="group" aria-label="Confirm removing the key">
                  <button type="button" className="button-danger ai-button" disabled={busy} onClick={() => void remove()}>
                    Remove
                  </button>
                  <button type="button" className="button ai-button" onClick={() => setConfirmRemove(false)}>
                    Keep
                  </button>
                </div>
              ) : (
                <div className="ai-actions">
                  <button type="button" className="button ai-button" onClick={startReplace}>
                    Replace
                  </button>
                  <button type="button" className="button ai-button" onClick={() => setConfirmRemove(true)}>
                    Remove
                  </button>
                </div>
              )
            ) : (
              <div className="ai-actions">
                <button type="button" className="button ai-button" disabled={busy} onClick={() => void save()}>
                  Save
                </button>
                {editing && (
                  <button type="button" className="button ai-button" onClick={cancelEdit}>
                    Cancel
                  </button>
                )}
              </div>
            )
          }
        </SettingRow>
      </Section>

      <ModelSection />

      <MemoriesSection />

      <p className="ai-privacy">Conversations are not stored. Memories stay on this computer. Messages go to the provider you configure.</p>
    </>
  );
}

/**
 * The model every request names (spec S3): a free-text field with the NaN
 * default as its one suggestion. Saved locally as the user leaves the field,
 * the way General's time fields commit; an empty commit is refused, never
 * guessed.
 */
function ModelSection() {
  const [draft, setDraft] = useState(() => getChatModel());
  const [error, setError] = useState<string | null>(null);

  const commit = () => {
    const text = draft.trim();
    if (text === "") {
      setError("Name a model, or restore the default.");
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
    <Section title="Model" description="The model id your provider receives, sent with every request.">
      <SettingRow label="Model" controlId="ai-model" error={error}>
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
                Restore default
              </button>
            )}
          </>
        )}
      </SettingRow>
    </Section>
  );
}

/**
 * The durable memories (spec S5): listed newest first, one delete per row,
 * "Clear all" behind a confirm. Refreshed on mount — the tab remounts on
 * every visit, so memories the chat just extracted are here by the next look.
 */
function MemoriesSection() {
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
    <Section title="Memories" description="Notes the assistant keeps between chats, on this computer only.">
      {sorted.length === 0 ? (
        <div className="settings-empty">
          <p>No memories yet.</p>
          <p className="settings-row-desc">As you chat, notes worth keeping are saved here — never in the cloud.</p>
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
                  Delete
                </button>
              </div>
            </div>
          ))}
          <div className="settings-row">
            <div className="settings-row-text">
              <span className="settings-row-label">Clear all</span>
              <span className="settings-row-desc">
                {confirmClear ? "Delete every memory? This cannot be undone." : "Remove every memory from this computer."}
              </span>
            </div>
            <div className="settings-row-control">
              {confirmClear ? (
                <div className="ai-actions" role="group" aria-label="Confirm clearing all memories">
                  <button type="button" className="button-danger ai-button" onClick={() => void clearAll()}>
                    Clear
                  </button>
                  <button type="button" className="button ai-button" onClick={() => setConfirmClear(false)}>
                    Keep
                  </button>
                </div>
              ) : (
                <button type="button" className="button ai-button" onClick={() => setConfirmClear(true)}>
                  Clear all
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </Section>
  );
}
