/**
 * Pure rules for the Settings AI tab (spec S3, task C3b): the status line,
 * the provider host a saved key is bound to, and the page-side validation
 * that mirrors the Rust side's refusals (`src-tauri/core/src/chat.rs`
 * `validate_key`/`validate_base_url`) so obvious mistakes never pay an IPC
 * round trip. Rust re-validates everything; its error string wins when the
 * two ever disagree.
 */

import { getLocale, intlLocale, t } from "../../i18n/index.ts";
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
  if (status === null) return t("ai.keyStatus.checking");
  if (!status.hasKey) return t("ai.keyStatus.none");
  return t("ai.keyStatus.saved", { host: providerHost(status.baseUrl ?? DEFAULT_CHAT_BASE_URL) });
}

/** The Rust key rules worth repeating in the page: empty after trimming. */
export function validateKeyClient(key: string): string | null {
  if (key.trim() === "") return t("ai.error.keyEmpty");
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
    return t("ai.error.baseUrl");
  }
  if (parsed.username !== "" || parsed.password !== "") return t("ai.error.baseUrl");
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback)) return null;
  return t("ai.error.baseUrl");
}

/** The memories list is newest first (spec S5); a preview keeps one line. */
export function memoryPreview(content: string, max = 96): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** The row's date in the app's language ("Oct 24, 2026" in English). */
export function memoryDate(updatedAt: number): string {
  return new Intl.DateTimeFormat(intlLocale(getLocale()), { dateStyle: "medium" }).format(new Date(updatedAt));
}

/**
 * The Engram mirror status line (task R2, spec S2). Mirroring off wins over
 * the last attempt; a failed attempt shows "Engram unreachable: …" with the
 * error Rust recorded; success shows how many memories the attempt touched.
 */
export function engramStatusText(
  enabled: boolean,
  status: { ok: boolean; synced: number; error: string | null } | null,
): string {
  if (!enabled) return t("ai.engram.off");
  if (status === null) return t("ai.engram.notSynced");
  if (!status.ok) return t("ai.engram.unreachable", { error: status.error ?? t("ai.engram.unknownError") });
  return t("ai.engram.synced", { count: status.synced });
}

/**
 * The Rust Engram address rules (planner_core::engram::validate_engram_address):
 * loopback only, on either scheme — the mirror talks to a local Engram, and a
 * remote address would send the memories off this computer. The message is
 * the Rust command's own wording.
 */
export function validateEngramAddressClient(url: string): string | null {
  const refused = t("ai.engram.addressError");
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return refused;
  }
  if (parsed.username !== "" || parsed.password !== "") return refused;
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if ((parsed.protocol === "https:" || parsed.protocol === "http:") && loopback) return null;
  return refused;
}

/** The Rust project rule worth repeating in the page: not empty (Rust also
 * caps the length and rejects control characters; its word wins). */
export function validateEngramProjectClient(project: string): string | null {
  if (project.trim() === "") return t("ai.engram.projectError");
  return null;
}
