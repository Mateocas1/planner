/**
 * Pure rules for the Settings AI tab (spec S3, task C3b): the status line,
 * the provider host a saved key is bound to, and the page-side validation
 * that mirrors the Rust side's refusals (`src-tauri/core/src/chat.rs`
 * `validate_key`/`validate_base_url`) so obvious mistakes never pay an IPC
 * round trip. Rust re-validates everything; its error string wins when the
 * two ever disagree.
 */

import { DEFAULT_CHAT_BASE_URL, type ChatKeyStatus } from "../../chat/keyStore.ts";

/**
 * The host a saved key points at ("Key saved for api.nan.builders"), or the
 * raw text when the URL does not parse — a status line must never be blank.
 */
export function providerHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** The one-line status under the API key row. */
export function keyStatusText(status: ChatKeyStatus | null): string {
  if (status === null) return "Checking…";
  if (!status.hasKey) return "No key.";
  return `Key saved for ${providerHost(status.baseUrl ?? DEFAULT_CHAT_BASE_URL)}.`;
}

/** The Rust key rules worth repeating in the page: empty after trimming. */
export function validateKeyClient(key: string): string | null {
  if (key.trim() === "") return "The API key must not be empty.";
  return null;
}

/**
 * The Rust base-URL rules: `https://`, or `http://` on the loopback (a local
 * gateway), and never userinfo — a credential inside the URL would echo back
 * in errors. The message is the Rust command's own wording.
 */
export function validateBaseUrlClient(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return "The provider address is not allowed.";
  }
  if (parsed.username !== "" || parsed.password !== "") return "The provider address is not allowed.";
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback)) return null;
  return "The provider address is not allowed.";
}

/** The memories list is newest first (spec S5); a preview keeps one line. */
export function memoryPreview(content: string, max = 96): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** The row's date, in the app's English UI ("Oct 24, 2026"). */
export function memoryDate(updatedAt: number): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(updatedAt));
}
