import { useEffect } from "react";
import { motion } from "motion/react";
import { t } from "../../i18n/index.ts";
import { isTauri } from "../../desktop.ts";
import type { WorkWindow } from "../../planning/window.ts";
import type { WeeklyReviewSettings } from "../../planning/weekly.ts";
import { dur, easeOut, phoneQuery, spring, useMediaQuery } from "../motion.ts";
import { availableSettingsTabs, resolveSettingsTab, type SettingsTab } from "./tabs.ts";
import { AiTab } from "./tabs/AiTab.tsx";
import { DesktopTab } from "./tabs/DesktopTab.tsx";
import { GeneralTab } from "./tabs/GeneralTab.tsx";
import { RitualsTab } from "./tabs/RitualsTab.tsx";
import { ShortcutsTab } from "./tabs/ShortcutsTab.tsx";
import "./SettingsView.css";

/**
 * Settings as a view in the shell (Ronda 2, S1): a left tab rail plus a
 * content column, rendered in `<main>` like Home/Tasks/Calendar, so the app
 * sidebar stays and the user never leaves the shell. The tab state lives in
 * the shell (`openSettings(tab?)` is the single entry point, so nudges, chat
 * and the palette can deep-link); Escape or the Back button returns to the
 * view Settings was opened from, and any sidebar nav item navigates away the
 * ordinary way.
 *
 * Motion (brief §6): the tab pane cross-fades — 160 ms opacity plus a 4 px
 * rise, the old pane unmounting instantly, exactly the page fade's tempo —
 * and the active pill travels between rail items on the shell's snappy
 * spring. Reduced motion drops the movement and keeps the opacity, which
 * `MotionConfig reducedMotion="user"` already arranges.
 */

export function SettingsView({
  uid,
  workWindow,
  shutdownTime,
  shortcutsEnabled,
  weeklyReview,
  tab,
  onTab,
  onBack,
}: {
  uid: string;
  workWindow: WorkWindow;
  shutdownTime: number;
  shortcutsEnabled: boolean;
  /** The profile's weekly review schedule (S3); the Rituals tab edits it. */
  weeklyReview: WeeklyReviewSettings;
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  /** Returns to the view Settings was opened from. */
  onBack: () => void;
}) {
  const phone = useMediaQuery(phoneQuery);
  const desktop = isTauri();
  const tabs = availableSettingsTabs(desktop);
  const active = resolveSettingsTab(tab, desktop);

  // Escape returns, the way every sheet's Escape closes — unless a recorder
  // is listening: its capture-phase handler consumes the key first, so a
  // recording is cancelled instead of navigating away.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const openGeneral = () => onTab("general");

  return (
    <section aria-label="Settings" className={`settings${phone ? " is-phone" : ""}`}>
      {/* The page head every view carries (Today, Tasks, Calendar): the 34 px
          title, and on the phone the back chevron, since the rail's Back is
          desktop-only there. */}
      <header className="page-head settings-page-head">
        {phone && (
          <button type="button" className="settings-back-icon-button" aria-label={t("shell.back")} onClick={onBack}>
            <ChevronLeftIcon />
          </button>
        )}
        <h2 className="large-title">{t("shell.title.settings")}</h2>
      </header>
      <div className="settings-rail">
        {!phone && (
          <button type="button" className="settings-back" onClick={onBack}>
            <ChevronLeftIcon />
            {t("shell.back")}
          </button>
        )}
        <nav aria-label="Settings sections" className="settings-nav">
          {tabs.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className="settings-nav-item"
              aria-current={active === id ? "page" : undefined}
              onClick={() => onTab(id)}
            >
              {active === id && (
                <motion.span layoutId="settings-pill" className="settings-pill" transition={spring.snappy} aria-hidden="true" />
              )}
              <TabIcon id={id} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </div>
      <div className="settings-pane">
        {/* The tab's own heading carries the pane; the cross-fade is the tab
            switch's whole entrance, the old pane unmounting at once. */}
        <motion.div
          key={active}
          className="settings-pane-inner"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: dur.enter, ease: easeOut }}
        >
          <header className="settings-head">
            <h3>{tabs.find(entry => entry.id === active)?.label}</h3>
            <p>{tabs.find(entry => entry.id === active)?.description}</p>
          </header>
          {active === "general" && (
            <GeneralTab uid={uid} workWindow={workWindow} shutdownTime={shutdownTime} shortcutsEnabled={shortcutsEnabled} />
          )}
          {active === "rituals" && (
            <RitualsTab uid={uid} settings={weeklyReview} shutdownTime={shutdownTime} onOpenGeneral={openGeneral} />
          )}
          {active === "shortcuts" && (
            <ShortcutsTab desktop={desktop} shortcutsEnabled={shortcutsEnabled} onOpenGeneral={openGeneral} />
          )}
          {active === "desktop" && <DesktopTab />}
          {active === "ai" && <AiTab />}
        </motion.div>
      </div>
    </section>
  );
}

/** The rail's 18 px icons, drawn in ui/icons.tsx's stroke family on the same
 * 24 px grid. One per tab; no icon is shared with a nav view. */
function TabIcon({ id }: { id: SettingsTab }) {
  const base = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: "settings-nav-icon",
  };
  if (id === "general") {
    return (
      <svg {...base}>
        <path d="M4 8h9M17 8h3M4 16h3M11 16h9" />
        <circle cx="15" cy="8" r="2" />
        <circle cx="9" cy="16" r="2" />
      </svg>
    );
  }
  if (id === "rituals") {
    return (
      <svg {...base}>
        <path d="M20 12a8 8 0 1 1-2.3-5.6" />
        <path d="M20 4v3h-3" />
        <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (id === "shortcuts") {
    return (
      <svg {...base}>
        <rect x="3" y="6.5" width="18" height="11" rx="2.5" />
        <path d="M7 10h.01M11 10h.01M15 10h.01M7 13.5h.01M11 13.5h6" />
      </svg>
    );
  }
  if (id === "desktop") {
    return (
      <svg {...base}>
        <rect x="3" y="4.5" width="18" height="12.5" rx="2.5" />
        <path d="M9 21h6M12 17v4" />
      </svg>
    );
  }
  return (
    <svg {...base}>
      <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 9 9 0 0 1-3.2-.6L4 20l1-4.1a8 8 0 0 1-1.5-4.4A8.4 8.4 0 0 1 12 3.2a8.4 8.4 0 0 1 9 8.3Z" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="settings-back-icon">
      <path d="m14.5 6-6 6 6 6" />
    </svg>
  );
}
