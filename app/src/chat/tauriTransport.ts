/**
 * Desktop transport for the chat panel: the Rust side (`src-tauri/src/chat/`)
 * holds the API key, owns the non-secret provider address (bound to the key,
 * never sent from the page) and performs the HTTPS call, so the key never
 * reaches the page (spec S3). Implements the `ChatTransport` contract from
 * `types.ts` over `invoke` + `Channel`. Key helpers for Settings live in
 * `keyStore.ts`.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import { t } from "../i18n/index.ts";
import type {
  ChatErrorCode,
  ChatEvent,
  ChatRequest,
  ChatTransport,
} from "./types.ts";

function terminal(event: ChatEvent): boolean {
  return (
    event.type === "done" ||
    event.type === "cancelled" ||
    event.type === "error"
  );
}

/**
 * Narrows one raw IPC payload into a `ChatEvent`. Unknown payloads (a Rust
 * shape drifting from this contract) are dropped instead of crashing the
 * panel; this is the only mapping the transport adds.
 */
export function toChatEvent(raw: unknown): ChatEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const type = (raw as { type?: unknown }).type;
  switch (type) {
    case "reasoning":
      return { type: "reasoning" };
    case "delta": {
      const text = (raw as { text?: unknown }).text;
      return typeof text === "string" ? { type: "delta", text } : null;
    }
    case "tool_call": {
      const call = (raw as { call?: unknown }).call;
      if (typeof call !== "object" || call === null) return null;
      const id = (call as { id?: unknown }).id;
      const name = (call as { name?: unknown }).name;
      const args = (call as { arguments?: unknown }).arguments;
      return typeof id === "string" && typeof name === "string" && typeof args === "string"
        ? { type: "tool_call", call: { id, name, arguments: args } }
        : null;
    }
    case "done":
      return { type: "done" };
    case "cancelled":
      return { type: "cancelled" };
    case "error": {
      const code = (raw as { code?: unknown }).code;
      const message = (raw as { message?: unknown }).message;
      if (typeof code !== "string" || typeof message !== "string") return null;
      // A missing or locked keyring gets a localized hint instead of Rust's
      // English diagnostic.
      return code === "credential_store_unavailable"
        ? { type: "error", code, message: t("chat.error.credentialStoreUnavailable") }
        : { type: "error", code: code as ChatErrorCode, message };
    }
    default:
      return null;
  }
}

/**
 * Creates the desktop transport. `stream` resolves once the terminal event
 * was seen on the channel, matching the contract in `types.ts`.
 */
export function createTauriChatTransport(): ChatTransport {
  return {
    stream(request: ChatRequest, onEvent: (event: ChatEvent) => void) {
      return new Promise<void>((resolve, reject) => {
        const channel = new Channel<unknown>();
        let settled = false;
        channel.onmessage = (raw) => {
          const event = toChatEvent(raw);
          if (event === null) return;
          onEvent(event);
          if (terminal(event) && !settled) {
            settled = true;
            resolve();
          }
        };
        invoke("chat_stream", { request, onEvent: channel }).catch(
          (error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          },
        );
      });
    },
    cancel(id: string) {
      return invoke("chat_cancel", { id }).then(() => undefined);
    },
    complete(request: ChatRequest) {
      // The Rust rejection serializes as `{code, message}` (IpcError).
      return invoke<string>("chat_complete", { request });
    },
  };
}
