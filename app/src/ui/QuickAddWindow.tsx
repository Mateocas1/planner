import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { useSession } from "../data/session.ts";
import { useProfileTimeZone } from "../data/profile.ts";
import { t, useLocale } from "../i18n/index.ts";
import { addSeries, type Frequency } from "../data/series.ts";
import { addTask } from "../data/tasks.ts";
import { parseQuickAdd } from "../domain/quickAdd.ts";
import { isTauri } from "../desktop.ts";
import { syncBackdropClasses } from "./desktopBackdrop.ts";
import { QuickAddChips } from "./QuickAddChips.tsx";
import { settle } from "./write.ts";
import "./DesktopShell.css";
import "./QuickAddWindow.css";

/**
 * The global quick-add window (task T5, spec S8.1) — the mini surface the
 * `Ctrl+Alt+Space` hotkey summons. It is the same bundle as the main app
 * (route flag `#quickadd` in main.tsx) rendering only the natural-language
 * quick add: the same `parseQuickAdd`, the same `QuickAddChips`, and the same
 * write path (`addTask` / `addSeries`) as the main window's sheet, so both
 * surfaces can never disagree about a parse or a write. The main window
 * updates through Firestore: both windows share the origin, so auth and the
 * persistent multiple-tab-manager cache in `data/client.ts` already span
 * them.
 *
 * Rust owns the window: it shows, focuses, centers on the cursor monitor and
 * hides on blur. This page only asks to hide (Enter, Esc) and sizes the window
 * to the chips row. The one accepted entrance (`quickadd-in`, 150 ms) is the
 * palette's short soft appearance by decision (AGENTS.md log: user decisions
 * beat reviewer rules for keyboard surfaces) — it replays on every reveal via
 * the `enterCount` key, and `prefers-reduced-motion` keeps the fade only. No
 * exit animation: hiding is instant, never delayed. Focus is never queued
 * behind the animation — the field takes the caret in the shown event.
 */

/** The frame sizes Rust's tauri.conf.json also ships: base, and +1 chip row. */
const WINDOW_WIDTH = 560;
const BASE_HEIGHT = 150;
const CHIP_ROW_HEIGHT = 40;

export function QuickAddWindow() {
  // The last language the main window used (cached in localStorage); the
  // `storage` event switches this window live.
  useLocale();
  const { loading, user } = useSession();
  const profile = useProfileTimeZone(user?.uid ?? null);
  const timeZone = profile.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [title, setTitle] = useState("");
  // Undone chips, the sheet's exact rule: the text stays in the title and is
  // not consumed again by a later parse.
  const [undone, setUndone] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped on every reveal so the entrance replays; the key wraps only the
  // inner tree, so a draft never remounts.
  const [enterCount, setEnterCount] = useState(0);
  const fieldRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(
    () => parseQuickAdd(title, { now: new Date(), timeZone, ignore: undone }),
    [title, timeZone, undone],
  );
  const deadline = parsed.deadline ?? "";
  const repeat: Frequency | "off" = parsed.frequency ?? "off";
  const start = parsed.anchorDate ?? "";

  const hide = useCallback(() => {
    if (isTauri()) void getCurrentWindow().hide();
  }, []);

  // Window glue: the Mica backdrop like the main window's DesktopShell, the
  // size that follows the chips row, and the reveal event that focuses the
  // field and replays the entrance. Everything degrades to no-ops off Tauri.
  useEffect(() => {
    if (!isTauri()) return undefined;
    const root = document.documentElement;
    const window = getCurrentWindow();
    const apply = () => {
      invoke("desktop_backdrop", { dark: root.dataset.theme === "dark" })
        .then(() => syncBackdropClasses(root, true))
        .catch(() => syncBackdropClasses(root, false));
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    let unlisten: (() => void) | undefined;
    listen("quickadd-shown", () => {
      setEnterCount(count => count + 1);
      setError(null);
      setBusy(false);
      window.setSize(new LogicalSize(WINDOW_WIDTH, BASE_HEIGHT)).catch(() => undefined);
      // The caret first, the entrance second: a key typed on the opening
      // frame lands in the field.
      fieldRef.current?.focus();
    })
      .then(off => {
        unlisten = off;
      })
      .catch(() => undefined);
    return () => {
      observer.disconnect();
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- window glue mounts once
  }, []);

  // The window grows only when the NL chips need a row, never for the text.
  useEffect(() => {
    if (!isTauri()) return;
    const rows = Math.ceil(parsed.parts.length / 3);
    getCurrentWindow()
      .setSize(new LogicalSize(WINDOW_WIDTH, chipsHeight(rows)))
      .catch(() => undefined);
  }, [parsed.parts.length]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    // Signed out: the message already says where to sign in; Enter takes the
    // user there (the main window) instead of refusing silently.
    if (!user) {
      if (isTauri()) void invoke("quickadd_focus_main").catch(() => undefined);
      hide();
      return;
    }
    if (parsed.title.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await settle(
        repeat === "off"
          ? addTask(user.uid, parsed.title, deadline === "" ? undefined : deadline, undefined)
          : addSeries(user.uid, parsed.title, repeat, start, deadline === "" ? undefined : deadline, undefined),
      );
      setTitle("");
      setUndone([]);
      hide();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("cal.error.generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="quickadd" key={enterCount}>
      {loading ? (
        <p className="quickadd-note" role="status">{t("quickAdd.checking")}</p>
      ) : !user ? (
        <form className="quickadd-form" onSubmit={event => void onSubmit(event)}>
          <p className="quickadd-note" role="status">{t("quickAdd.signInFirst")}</p>
          <p className="quickadd-hint">{t("quickAdd.openMain")}</p>
        </form>
      ) : (
        <form className="quickadd-form" onSubmit={event => void onSubmit(event)}>
          <label className="sr-only" htmlFor="quickadd-title">{t("quickAdd.taskTitle")}</label>
          <input
            id="quickadd-title"
            ref={fieldRef}
            className="quickadd-input"
            type="text"
            placeholder={t("quickAdd.placeholder")}
            autoFocus
            autoComplete="off"
            value={title}
            onChange={event => setTitle(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Escape") {
                event.preventDefault();
                hide();
              }
            }}
          />
          <QuickAddChips parts={parsed.parts} today={parsed.today} onUndo={part => setUndone(list => [...list, part.text])} />
          {error && <p className="quickadd-hint quickadd-error" role="alert">{error}</p>}
          {!error && <p className="quickadd-hint">{t("quickAdd.hint")}</p>}
        </form>
      )}
    </div>
  );
}

/** Window height for a number of chip rows: the base frame plus one row of
 * chips each, matching the heights in tauri.conf.json. */
function chipsHeight(rows: number): number {
  return BASE_HEIGHT + rows * CHIP_ROW_HEIGHT;
}
