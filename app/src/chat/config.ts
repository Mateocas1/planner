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

/** What the mock transport should do this run (`?chatMock=error` streams a failure). */
export function mockMode(mockQuery: string | null): "answer" | "error" {
  return mockQuery === "error" ? "error" : "answer";
}
