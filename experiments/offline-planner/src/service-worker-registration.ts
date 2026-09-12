/// <reference types="vite-plugin-pwa/client" />

import { registerSW } from "virtual:pwa-register";

export function registerServiceWorker(): void {
  if ("serviceWorker" in navigator) {
    registerSW({ immediate: true });
  }
}
