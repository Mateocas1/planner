import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../desktop.ts";
import { desktopMicaClass, desktopShellClass, syncBackdropClasses } from "./desktopBackdrop.ts";
import "./DesktopShell.css";

/**
 * Desktop-shell chrome glue — renders nothing.
 *
 * Two jobs, both no-ops in the web build (`isTauri` gates everything):
 *
 * 1. Backdrop. The window config ships `transparent: true`, so the page is
 *    responsible for how much of the Windows 11 Mica backdrop shows through.
 *    `desktop-mica` (set only when the Rust side confirmed Mica applied — it
 *    fails on Windows 10) relaxes the page background; without it the page
 *    keeps its opaque web design, so an unsupported system degrades to a
 *    plain opaque window. Re-applied on every resolved-theme change so the
 *    backdrop tint and the native caption strip follow the app theme.
 *
 * 2. Drag. The app's top bar carries `data-tauri-drag-region` (in App.tsx);
 *    Tauri turns it into a drag surface with double-click maximize only
 *    inside the shell. Interactive controls inside the bar never carry the
 *    attribute, so they stay clickable; in the browser the attribute is inert.
 */
export function DesktopShell() {
  useEffect(() => {
    if (!isTauri()) return undefined;
    const root = document.documentElement;
    root.classList.add(desktopShellClass);
    const apply = () => {
      invoke("desktop_backdrop", { dark: root.dataset.theme === "dark" })
        .then(() => syncBackdropClasses(root, true))
        .catch(() => syncBackdropClasses(root, false));
    };
    apply();
    // Theme changes repaint `data-theme`; mirror them into the backdrop.
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      observer.disconnect();
      root.classList.remove(desktopShellClass, desktopMicaClass);
    };
  }, []);
  return null;
}
