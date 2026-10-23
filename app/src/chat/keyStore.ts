/**
 * Typed helpers for the chat API key (spec S3, Settings tab of task C3).
 * The key lives only in the Windows Credential Manager on the Rust side and
 * is never returned to the webview; the non-secret provider address is
 * stored next to it in Rust and bound to the key: changing provider means
 * setting the key again (`chat_key_set`), never a separate field.
 */

import { invoke } from "@tauri-apps/api/core";

/** The default OpenAI-compatible endpoint (spec S3, parent decision L1/L4). */
export const DEFAULT_CHAT_BASE_URL = "https://api.nan.builders/v1";

/** What Settings may show: whether a key is saved and where it points. */
export type ChatKeyStatus = {
  hasKey: boolean;
  /** The provider base URL bound to the key, or null when none is set. */
  baseUrl: string | null;
};

export function getKeyStatus(): Promise<ChatKeyStatus> {
  return invoke<ChatKeyStatus>("chat_key_status");
}

/**
 * Saves the API key together with the provider address it belongs to.
 * Rust validates both (control characters, URL scheme/userinfo) before
 * storing anything.
 */
export function setKey(key: string, baseUrl: string): Promise<void> {
  return invoke("chat_key_set", { key, baseUrl });
}

/** Removes the API key and the provider address bound to it. */
export function clearKey(): Promise<void> {
  return invoke("chat_key_clear");
}
