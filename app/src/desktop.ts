/** True when the page runs inside the Tauri desktop shell (Tauri injects
 * `__TAURI_INTERNALS__` into every webview it creates). Takes the global as an
 * argument so it stays testable without a DOM. */
export function isTauri(scope: object = globalThis): boolean {
  return "__TAURI_INTERNALS__" in scope;
}
