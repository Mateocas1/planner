import { useState } from "react";
import type { BlockView } from "../data/store.ts";
import { type WorkWindow } from "../planning/window.ts";
import { CloseIcon } from "./icons.tsx";
import { briefStorageKey, briefVisible, firstFreeSlot, morningBriefText } from "./shutdownRitual.ts";
import { dateKey, wallMinutes } from "./time.ts";
import "./MorningBrief.css";

/**
 * The morning brief (distinctive roadmap F3, criterion 7): the first Home of a
 * day says what the day already holds and where the first free time is, then
 * gets out of the way. It never asks, never takes focus and never blocks: one
 * sentence, one dismissal, and the plan it points at is the Plan my day card
 * directly under it (F4b), which is why this surface owns no button of its own.
 *
 * "Once a day" is the profile zone's day, and the dismissal is per device
 * (`localStorage`, see shutdownRitual.briefStorageKey): a dismissal is a
 * property of this screen's morning, not of the planner, so it is not a profile
 * write and it does not travel to the phone in your pocket.
 */

/** A dismissal can only be read and written when storage is available at all
 *  (private modes and hardened browsers throw on access). */
function readDismissal(): string | null {
  try {
    return window.localStorage.getItem(briefStorageKey);
  } catch {
    return null;
  }
}

function writeDismissal(day: string): void {
  try {
    window.localStorage.setItem(briefStorageKey, day);
  } catch {
    // A browser that refuses storage still gets a dismissal for this mount.
  }
}

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
  const today = dateKey(now, timeZone);
  const [dismissed, setDismissed] = useState(readDismissal);

  const todays = blocks
    .filter(block => dateKey(new Date(block.start), timeZone) === today)
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
  const text = morningBriefText({
    blockCount: todays.length,
    firstStartMinutes: todays.length === 0 ? undefined : wallMinutes(new Date(todays[0].start), timeZone),
    firstFreeSlotMinutes: firstFreeSlot(
      todays.map(block => {
        const startMinutes = wallMinutes(new Date(block.start), timeZone);
        const endMinutes = wallMinutes(new Date(block.end), timeZone);
        return { startMinutes, endMinutes: endMinutes <= startMinutes ? 1440 : endMinutes };
      }),
      workWindow,
      wallMinutes(now, timeZone),
    ),
  });

  if (text === null || !briefVisible({ storedDay: dismissed, today, blockCount: todays.length })) return null;

  const dismiss = () => {
    writeDismissal(today);
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
