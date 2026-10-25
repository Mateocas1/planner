/**
 * Chat configuration (tasks C2–C3b of odd/tasks/llm-chat.md).
 *
 * The panel's feature gate and the model setting. `DEFAULT_CHAT_MODEL` is the
 * model requests carry until the user saves another in Settings' AI tab
 * (`getChatModel` reads it per request); `buildSystemPrompt` is a stub C3
 * grew into the planner-context prompt (S4) — the conversation controller
 * takes the function as an input, so nothing else changes.
 */

/** The default model every chat request names (spec S3, parent decision L1). */
export const DEFAULT_CHAT_MODEL = "deepseek-v4-flash";

/** The model setting's storage key (Settings AI tab, task C3b). */
const MODEL_STORAGE_KEY = "planner.chat.model";

/**
 * The model a request carries for the text the user saved: trimmed, never
 * empty — an empty or whitespace value falls back to the default instead of
 * sending a model name the provider refuses. Unknown names pass through: the
 * provider, not this page, owns the catalog.
 */
export function normalizeChatModel(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  return text === "" ? DEFAULT_CHAT_MODEL : text;
}

/** The saved model, or the default when none was saved (or storage failed). */
export function getChatModel(): string {
  try {
    return normalizeChatModel(window.localStorage.getItem(MODEL_STORAGE_KEY));
  } catch {
    return DEFAULT_CHAT_MODEL;
  }
}

/** Persists the model setting (trimmed; empty clears back to the default). */
export function setChatModel(model: string): void {
  try {
    const text = model.trim();
    if (text === "" || text === DEFAULT_CHAT_MODEL) window.localStorage.removeItem(MODEL_STORAGE_KEY);
    else window.localStorage.setItem(MODEL_STORAGE_KEY, text);
  } catch {
    /* storage denied: the model then lives until the page closes */
  }
}

/**
 * When the floating chat panel renders at all (S1, review #2): the panel is an
 * in-app surface, so inside the Tauri desktop shell it needs a signed-in
 * session — on the sign-in screen neither the launcher nor the panel exists.
 * On the web it renders only while developing with `?chatMock` in the URL, and
 * that dev-mock path is account-free (no emulator user needed) — a production
 * web build never renders it. The inputs are passed in so the rule stays
 * testable without a browser, and callers recompute it every render so a
 * sign-in/out flips visibility immediately.
 */
export function chatPanelVisible(options: { desktop: boolean; dev: boolean; mockQuery: string | null; signedIn: boolean }): boolean {
  const surface = options.desktop || (options.dev && options.mockQuery !== null);
  // The dev-mock path is account-free; the real panel needs a signed-in session.
  return surface && (options.signedIn || options.mockQuery !== null);
}

/** What the mock transport should do this run (`?chatMock=error` streams a
 * failure, `?chatMock=tools` proposes two planner changes, the `agent-*`
 * scenarios drive the ronda4 agentic flow). */
export function mockMode(mockQuery: string | null): "answer" | "error" | "tools" | "agent-read" | "agent-edit" | "agent-delete" | "agent-holiday" {
  if (mockQuery === "error") return "error";
  if (mockQuery === "tools") return "tools";
  if (mockQuery === "agent-read") return "agent-read";
  if (mockQuery === "agent-edit") return "agent-edit";
  if (mockQuery === "agent-delete") return "agent-delete";
  if (mockQuery === "agent-holiday") return "agent-holiday";
  return "answer";
}
