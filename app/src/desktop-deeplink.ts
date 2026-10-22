import { useEffect, useRef } from "react";
import { isTauri } from "./desktop.ts";

/**
 * `calendar://` deep links inside the Tauri shell. Rust parses and validates
 * the link (`src-tauri/core/src/route.rs`), keeps the last valid route and pings
 * this window; the page then asks for it. Only the two route shapes below are
 * ever acted on, and a payload that is not exactly one of them is dropped.
 */
export type DeepLinkRoute = { kind: "today" } | { kind: "day"; date: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The route in a command payload, or null for anything else. */
export function parseDeepLinkRoute(payload: unknown): DeepLinkRoute | null {
  if (payload === null || typeof payload !== "object") return null;
  const { kind, date } = payload as { kind?: unknown; date?: unknown };
  if (kind === "today") return { kind };
  if (kind === "day" && typeof date === "string" && DATE.test(date)) return { kind, date };
  return null;
}

export type DeepLinkHandlers = { today: () => void; day: (date: string) => void };

/** Applies deep-link routes to the shell. A no-op in a plain browser. */
export function useDeepLink(handlers: DeepLinkHandlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    if (!isTauri()) return undefined;
    let live = true;
    let unlisten: (() => void) | undefined;

    const take = async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const route = parseDeepLinkRoute(await invoke("deeplink_take_pending"));
      if (!live || route === null) return;
      if (route.kind === "today") latest.current.today();
      else latest.current.day(route.date);
    };

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const off = await listen("deeplink-pending", () => void take().catch(() => undefined));
      if (!live) {
        off();
        return;
      }
      unlisten = off;
      // A link that launched the app arrived before this listener existed.
      await take();
    })().catch(() => undefined);

    return () => {
      live = false;
      unlisten?.();
    };
  }, []);
}
