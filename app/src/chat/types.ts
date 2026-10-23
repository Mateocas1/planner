/**
 * The contract between the chat panel (UI) and its transport (task C0 of
 * odd/tasks/llm-chat.md). The UI only ever talks to a `ChatTransport`; the
 * desktop build wires the Tauri transport (Rust holds the API key and makes
 * the HTTPS call), dev and tests wire a mock. Keep this file dependency-free.
 */

/** One turn of the conversation as sent to the model. */
export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/** A request for one assistant reply. */
export type ChatRequest = {
  /** Opaque id chosen by the caller; `cancel` uses it. */
  id: string;
  /** Model id, e.g. "deepseek-v4-flash". */
  model: string;
  /** Full prompt: system message first, then the conversation. */
  messages: ChatMessage[];
};

/**
 * Events of one streamed reply, in order:
 * `reasoning`* → `delta`* → (`done` | `error`), or `cancelled` at any point.
 * `reasoning` only signals that the model is thinking (its text is not shown).
 */
export type ChatEvent =
  | { type: "reasoning" }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "cancelled" }
  | { type: "error"; code: ChatErrorCode; message: string };

export type ChatErrorCode =
  | "no_key" // no API key stored
  | "unauthorized" // provider rejected the key (401/403)
  | "rate_limited" // 429
  | "network" // DNS/TLS/connection/timeout
  | "provider" // any other non-2xx or malformed stream
  | "invalid_request"; // rejected locally (bad base URL, empty messages)

export interface ChatTransport {
  /** Streams one reply. Resolves after the terminal event was emitted. */
  stream(request: ChatRequest, onEvent: (event: ChatEvent) => void): Promise<void>;
  /** Stops the reply with this id; the stream then emits `cancelled`. */
  cancel(id: string): Promise<void>;
  /** One non-streamed completion (used for memory extraction). */
  complete(request: ChatRequest): Promise<string>;
}
