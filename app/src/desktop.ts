/** True when the page runs inside the Tauri desktop shell (Tauri injects
 * `__TAURI_INTERNALS__` into every webview it creates). Takes the global as an
 * argument so it stays testable without a DOM. */
export function isTauri(scope: object = globalThis): boolean {
  return "__TAURI_INTERNALS__" in scope;
}

/** The desktop OS family, for copy that names a platform service (the
 * credential store, the sign-in item). The app ships no Tauri OS plugin, so it
 * reads the webview's own platform string — WebView2 reports `Win32` or
 * "Windows", WebKitGTK `Linux x86_64`. Takes `navigator` as an argument so it
 * stays testable without a DOM. */
export type DesktopPlatform = "windows" | "linux" | "macos" | "other";

export type PlatformSource = { platform?: string; userAgentData?: { platform?: string } } | undefined;

export function desktopPlatform(
  nav: PlatformSource = typeof navigator === "undefined" ? undefined : navigator,
): DesktopPlatform {
  const name = nav?.userAgentData?.platform || nav?.platform || "";
  if (/^win/i.test(name)) return "windows";
  if (/mac/i.test(name)) return "macos";
  if (/linux|x11|freebsd|openbsd/i.test(name)) return "linux";
  return "other";
}
