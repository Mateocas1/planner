import { useState } from "react";
import type { BlockView } from "../data/store.ts";
import { type WorkWindow } from "../planning/window.ts";
import { CloseIcon } from "./icons.tsx";
import { briefVisible, morningBriefState, readBriefDismissal, writeBriefDismissal } from "./shutdownRitual.ts";
import "./MorningBrief.css";

/**
 * The morning brief (distinctive roadmap F3, criterion 7): the first Home of a
 * day says what the day already holds and where the first free time is, then
 * gets out of the way. It never asks, never takes focus and never blocks: one
 * sentence, one dismissal, and the plan it points at is the Plan my day card
 * directly under it (F4b), which is why this surface owns no button of its own.
 *
 * "Once a day" is the profile zone's day, and the dismissal is per device
 * (`localStorage`, see shutdownRitual.readBriefDismissal): a dismissal is a
 * property of this screen's morning, not of the planner, so it is not a profile
 * write and it does not travel to the phone in your pocket.
 */

export function MorningBrief({
  blocks,
  timeZone,
  workWindow,
  now,
}: {
  blocks: BlockView[];
  timeZone: string;
  /** The profile's one working window: the free-slot clause is inside it (W1). */
  workWindow: WorkWindow;
  now: Date;
}) {
  const [dismissed, setDismissed] = useState(readBriefDismissal);

  const { today, blockCount, text } = morningBriefState({ blocks, timeZone, workWindow, now });

  if (text === null || !briefVisible({ storedDay: dismissed, today, blockCount })) return null;

  const dismiss = () => {
    writeBriefDismissal(today);
    setDismissed(today);
  };

  return (
    <section className="brief card" aria-labelledby="brief-heading" data-brief="open">
      <div className="brief-head">
        <h3 id="brief-heading" className="section-title">Morning brief</h3>
        <button type="button" className="icon-button" aria-label="Dismiss morning brief" onClick={dismiss}>
          <CloseIcon />
        </button>
      </div>
      <p className="brief-text">{text}</p>
    </section>
  );
}
