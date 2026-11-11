import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { DueMoment } from "../../planning/weekly.ts";
import { t } from "../../i18n/index.ts";
import { momentLabel } from "./weeklyFlow.ts";
import { dur, easeOut } from "../motion.ts";

/**
 * The weekly review's quiet Home banner: one line while a moment is due,
 * next to the shutdown banner's own slot, on the web as on the desktop — the
 * toast is the desktop's channel, the banner is everyone's.
 *
 * The actions keep a clear order: "Start review" is the one primary button;
 * "Later" holds the nudge for two hours (`snoozeMinutes`, the same +2 h the
 * toast's Later takes) as a quiet text button; "Skip this week" and
 * "Schedule" live behind the ⋯ disclosure, so the banner never reads as one
 * run of links. The Rituals tab, where the moments are configured, is what
 * "Schedule" opens.
 *
 * Entrance: opacity plus a 4 px rise, 160 ms — the pane rhythm, not a bounce;
 * the exit is a plain 120 ms fade handled by the host's AnimatePresence. The
 * ⋯ menu fades in the same way. Escape and a pointer press outside close it.
 */
export function WeeklyBanner({
  due,
  onOpen,
  onLater,
  onSkip,
  onOpenSettings,
}: {
  due: DueMoment;
  onOpen: () => void;
  onLater: () => void;
  onSkip: () => void;
  onOpenSettings: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const more = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!more.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setMenuOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <motion.section
      className="weekly-banner"
      aria-labelledby="weekly-banner-text"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: dur.page, ease: easeOut } }}
      transition={{ duration: dur.enter, ease: easeOut }}
    >
      <div className="weekly-banner-text">
        <p id="weekly-banner-text">{t("weekly.banner.text")}</p>
        <p className="weekly-banner-when">{momentLabel(due.moment)}</p>
      </div>
      <div className="weekly-banner-actions">
        <button type="button" className="button button-accent weekly-banner-start" onClick={onOpen}>
          {t("weekly.banner.start")}
        </button>
        <button type="button" className="weekly-quiet" onClick={onLater}>
          {t("weekly.banner.later")}
        </button>
        <div className="weekly-banner-more" ref={more}>
          <button
            ref={trigger}
            type="button"
            className="weekly-quiet weekly-banner-dots"
            aria-label={t("weekly.banner.more")}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(open => !open)}
          >
            ⋯
          </button>
          <AnimatePresence>
            {menuOpen && (
              <motion.div
                className="weekly-banner-menu"
                role="group"
                aria-label={t("weekly.banner.options")}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: dur.page, ease: easeOut } }}
                transition={{ duration: dur.enter, ease: easeOut }}
              >
                <button
                  type="button"
                  className="weekly-banner-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onSkip();
                  }}
                >
                  {t("weekly.banner.skip")}
                </button>
                <button
                  type="button"
                  className="weekly-banner-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenSettings();
                  }}
                >
                  {t("weekly.banner.schedule")}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.section>
  );
}
