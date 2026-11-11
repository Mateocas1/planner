/**
 * Desktop backdrop class sync — the pure half of
 * `DesktopShell.tsx`, kept in a `.ts` module so the node test runner
 * (`--experimental-strip-types`) can load it without a JSX transform.
 *
 * The Tauri window ships `transparent: true`; these are the classes that
 * decide how much of the Windows 11 Mica backdrop the page lets through:
 *
 * - `desktop-shell` — the page runs inside the Tauri shell (desktop-only
 *   hooks may key on it; the web build never sets it).
 * - `desktop-mica` — the Rust side confirmed the Mica backdrop applied. It
 *   fails on Windows 10 and Mica-less systems; without the class the page
 *   keeps its opaque web design, so an unsupported system degrades to a
 *   plain opaque window instead of content over the raw desktop.
 */

export const desktopShellClass = "desktop-shell";
export const desktopMicaClass = "desktop-mica";

/** Reconciles the root classes after one backdrop attempt. `applied` is
 * whether the `desktop_backdrop` command succeeded. */
export function syncBackdropClasses(
  root: Pick<Element, "classList">,
  applied: boolean,
): void {
  root.classList.add(desktopShellClass);
  root.classList.toggle(desktopMicaClass, applied);
}
