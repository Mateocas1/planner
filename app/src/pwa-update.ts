/// <reference types="vite-plugin-pwa/client" />
import { useSyncExternalStore } from "react";
import { registerSW } from "virtual:pwa-register";

/**
 * The PWA update prompt's state (value roadmap §2 row 1).
 *
 * `vite.config.ts` registers the worker in `prompt` mode on purpose: a new build
 * installs and *waits* instead of taking control and reloading the tab
 * underneath the user, which would interrupt a write that is still being typed.
 * The price was that nothing ever told the user an update was available, so a
 * stale build could run for days. This module holds that fact and the
 * activator, and it registers the worker exactly once, outside React.
 *
 * The activation path is the plugin's own: `onNeedRefresh` is workbox-window's
 * "waiting" event, and the activator it hands back posts SKIP_WAITING to that
 * waiting worker. Changing versions therefore requires an explicit click, which
 * is what makes it safe to reload while the persistent write queue is busy —
 * queued writes survive a reload; a forced one mid-edit does not.
 */

type Activate = (reloadPage?: boolean) => Promise<void>;

let updateReady = false;
let activate: Activate = () => Promise.resolve();
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

/** Registers the app-shell worker and watches for a waiting update. Safe to call
 * once per document; a browser without service workers simply never announces. */
export function installUpdatePrompt(): void {
  if (!("serviceWorker" in navigator)) return;
  activate = registerSW({
    immediate: true,
    onNeedRefresh() {
      updateReady = true;
      publish();
    },
  });
}

/** Lets the waiting worker take over and reloads into it.
 *
 * The plugin's own prompt path reloads from a "controlling" event flagged as an
 * update, which only happens when the tab was already controlled when it
 * registered. A first-visit tab would activate the new worker and keep running
 * the old build, so the reload is bound here instead: the click is the user's
 * decision, and one `controllerchange` after it lands the new version. */
export function activateUpdate(): void {
  navigator.serviceWorker?.addEventListener("controllerchange", () => window.location.reload(), { once: true });
  void activate();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while a new build is installed and waiting for this tab. */
export function useUpdateReady(): boolean {
  return useSyncExternalStore(subscribe, () => updateReady, () => false);
}
