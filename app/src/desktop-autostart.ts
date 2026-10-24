import { useEffect, useRef } from "react";
import { isTauri } from "./desktop.ts";
import type { WorkWindow } from "./planning/window.ts";
import { briefVisible, morningBriefState, readBriefDismissal } from "./ui/shutdownRitual.ts";

/**
 * Start at sign-in (task T10, spec S8.6). The autostart entry launches Planner
 * with `--autostart` (`src-tauri/src/autostart.rs`). Every other launch shows
 * the window as before. A sign-in launch stays hidden (tray only, L13) unless
 * today's morning brief applies; then it is revealed once the blocks are
 * loaded, so the window never flashes at sign-in for a day with nothing to say.
 */

export type SignInRevealInput = {
  /** The day the brief was dismissed on this device, or null. */
  storedDay: string | null;
  today: string;
  blockCount: number;
  /** The brief sentence Home would show, or null when there is none. */
  briefText: string | null;
};

/** Whether a sign-in launch shows the window: the same rule that shows the brief on Home. */
export function shouldRevealAtSignIn(input: SignInRevealInput): boolean {
  return input.briefText !== null && briefVisible(input);
}

/**
 * Reveals the window for a sign-in launch whose brief applies. Runs once per
 * launch, after the store and profile have loaded. Mounted only by the signed-in
 * shell, so a sign-in launch that is not signed in stays hidden, by design.
 * A no-op in a plain browser.
 */
export function useSignInReveal(input: {
  ready: boolean;
  blocks: readonly { start: string; end: string }[];
  timeZone: string | null;
  workWindow: WorkWindow;
}): void {
  const decided = useRef(false);
  const { ready, blocks, timeZone, workWindow } = input;

  useEffect(() => {
    if (!ready || timeZone === null || decided.current || !isTauri()) return;
    decided.current = true;
    void (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      if (!(await invoke<boolean>("desktop_launched_at_sign_in"))) return;
      const brief = morningBriefState({ blocks, timeZone, workWindow, now: new Date() });
      const reveal = shouldRevealAtSignIn({
        storedDay: readBriefDismissal(),
        today: brief.today,
        blockCount: brief.blockCount,
        briefText: brief.text,
      });
      if (reveal) await invoke("desktop_show_main");
    })().catch(() => undefined);
  }, [ready, blocks, timeZone, workWindow]);
}
