/**
 * The contract between the chat panel (UI) and its transport.
 * The UI only ever talks to a `ChatTransport`; the
 * desktop build wires the Tauri transport (Rust holds the API key and makes
 * the HTTPS call), dev and tests wire a mock. Keep this file dependency-free.
 */

/** One turn of the conversation as sent to the model (OpenAI roles). */
export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Assistant only: the tool calls this reply proposes, in the flat
   * `{id, name, arguments}` shape; the Rust transport converts them to the
   * OpenAI wire shape (`{id, type: "function", function: {name, arguments}}`)
   * when it builds the provider body (core/src/chat.rs `provider_body`). */
  toolCalls?: ChatToolCall[];
  /** Tool role only: the id of the call this message answers. */
  toolCallId?: string;
};

/** One tool call the model proposed. `arguments` is the raw JSON string the
 * provider streamed; it is validated before anything runs. */
export type ChatToolCall = { id: string; name: string; arguments: string };

/** A function-tool definition in the OpenAI wire shape. */
export type ChatToolSpec = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

/** A request for one assistant reply. */
export type ChatRequest = {
  /** Opaque id chosen by the caller; `cancel` uses it. */
  id: string;
  /** Model id, e.g. "deepseek-v4-flash". */
  model: string;
  /** Full prompt: system message first, then the conversation. */
  messages: ChatMessage[];
  /** Function tools the model may propose; absent for extraction calls. */
  tools?: ChatToolSpec[];
};

/**
 * Events of one streamed reply, in order:
 * `reasoning`* → (`delta` | `tool_call`)* → (`done` | `error`), or
 * `cancelled` at any point. `reasoning` only signals that the model is
 * thinking (its text is not shown). A `tool_call` fires once per complete
 * call, always before `done`.
 */
export type ChatEvent =
  | { type: "reasoning" }
  | { type: "delta"; text: string }
  | { type: "tool_call"; call: ChatToolCall }
  | { type: "done" }
  | { type: "cancelled" }
  | { type: "error"; code: ChatErrorCode; message: string };

export type ChatErrorCode =
  | "no_key" // no API key stored
  | "unauthorized" // provider rejected the key (401/403)
  | "rate_limited" // 429
  | "network" // DNS/TLS/connection/timeout
  | "provider" // any other non-2xx or malformed stream
  | "invalid_request" // rejected locally (bad base URL, empty messages)
  | "credential_store_unavailable"; // OS keyring missing or locked (Linux Secret Service)

export interface ChatTransport {
  /** Streams one reply. Resolves after the terminal event was emitted. */
  stream(request: ChatRequest, onEvent: (event: ChatEvent) => void): Promise<void>;
  /** Stops the reply with this id; the stream then emits `cancelled`. */
  cancel(id: string): Promise<void>;
  /** One non-streamed completion (used for memory extraction). */
  complete(request: ChatRequest): Promise<string>;
}
