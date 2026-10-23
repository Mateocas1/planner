/**
 * Chat configuration (task C2 of odd/tasks/llm-chat.md).
 *
 * The panel's feature gate and the defaults C3 will replace with real
 * settings. `DEFAULT_CHAT_MODEL` is the constant the controller sends until
 * the Settings section lands; `buildSystemPrompt` is a stub C3 will grow into
 * the planner-context prompt (S4) — the conversation controller takes the
 * function as an input, so nothing else changes.
 */

/** The model every chat request names until C3 makes it a setting. */
export const DEFAULT_CHAT_MODEL = "deepseek-v4-flash";

/** The system prompt C3 will build from the planner context (S4). */
export function buildSystemPrompt(): string {
  return "You are the assistant inside the user's personal planner. Be concise and helpful. Format answers with a small Markdown subset: paragraphs, bold, italic, inline code, fenced code blocks, lists and links.";
}

/**
 * When the floating chat panel renders at all (S1): inside the Tauri desktop
 * shell always, and on the web only while developing with `?chatMock` in the
 * URL — a production web build never renders it. The inputs are passed in so
 * the rule stays testable without a browser.
 */
export function chatPanelVisible(options: { desktop: boolean; dev: boolean; mockQuery: string | null }): boolean {
  if (options.desktop) return true;
  return options.dev && options.mockQuery !== null;
}

/** What the mock transport should do this run (`?chatMock=error` streams a failure). */
export function mockMode(mockQuery: string | null): "answer" | "error" {
  return mockQuery === "error" ? "error" : "answer";
}
