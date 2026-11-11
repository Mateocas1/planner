/**
 * Typed helpers for the chat API key (Settings tab).
 * The key lives only in the Windows Credential Manager on the Rust side and
 * is never returned to the webview; the non-secret provider address is
 * stored next to it in Rust and bound to the key: changing provider means
 * setting the key again (`chat_key_set`), never a separate field.
 */

import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n/index.ts";

/** The default OpenAI-compatible endpoint. */
export const DEFAULT_CHAT_BASE_URL = "https://api.nan.builders/v1";

/** What Settings may show: whether a key is saved and where it points. */
export type ChatKeyStatus = {
  hasKey: boolean;
  /** The provider base URL bound to the key, or null when none is set. */
  baseUrl: string | null;
};

/**
 * Turns a key command's rejection (`{code, message}` from Rust) into an
 * `Error` Settings can show: a missing or locked system keyring gets the
 * localized hint, anything else keeps Rust's own wording.
 */
export function keyStoreError(raw: unknown): Error {
  if (typeof raw === "object" && raw !== null) {
    const { code, message } = raw as { code?: unknown; message?: unknown };
    if (code === "credential_store_unavailable") return new Error(t("chat.error.credentialStoreUnavailable"));
    if (typeof message === "string") return new Error(message);
  }
  return new Error(String(raw));
}

function rethrow(raw: unknown): never {
  throw keyStoreError(raw);
}

export function getKeyStatus(): Promise<ChatKeyStatus> {
  return invoke<ChatKeyStatus>("chat_key_status").catch(rethrow);
}

/**
 * Saves the API key together with the provider address it belongs to.
 * Rust validates both (control characters, URL scheme/userinfo) before
 * storing anything.
 */
export function setKey(key: string, baseUrl: string): Promise<void> {
  return invoke<void>("chat_key_set", { key, baseUrl }).catch(rethrow);
}

/** Removes the API key and the provider address bound to it. */
export function clearKey(): Promise<void> {
  return invoke<void>("chat_key_clear").catch(rethrow);
}
