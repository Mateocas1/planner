import { motion } from "motion/react";
import type { DueMoment } from "../../planning/weekly.ts";
import { momentLabel } from "./weeklyFlow.ts";
import { dur, easeOut } from "../motion.ts";

/**
 * The weekly review's quiet Home banner (S3): one line while a moment is due,
 * next to the shutdown banner's own slot, on the web as on the desktop — the
 * toast is the desktop's channel, the banner is everyone's.
 *
 * Three moves, no more: Start opens the flow on the due steps, Later holds
 * the nudge for two hours (`snoozeMinutes`, the same +2 h the toast's Later
 * takes), Skip closes the week without it. The schedule link deep-links the
 * Rituals tab, where the moments are configured. It is "quiet" by construction:
 * no icon parade, one sentence, the app's own buttons.
 *
 * Entrance: opacity plus a 4 px rise, 160 ms — the pane rhythm, not a bounce;
 * the exit is a plain 120 ms fade handled by the host's AnimatePresence.
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
        <p id="weekly-banner-text">Time to close the week.</p>
        <p className="weekly-banner-when">{momentLabel(due.moment)}</p>
      </div>
      <div className="weekly-banner-actions">
        <button type="button" className="button" onClick={onOpen}>
          Start review
        </button>
        <button type="button" className="link-button" onClick={onLater}>
          Later
        </button>
        <button type="button" className="link-button" onClick={onSkip}>
          Skip this week
        </button>
        <button type="button" className="link-button" aria-label="Weekly review schedule" onClick={onOpenSettings}>
          Schedule
        </button>
      </div>
    </motion.section>
  );
}
