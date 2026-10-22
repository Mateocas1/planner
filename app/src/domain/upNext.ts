/**
 * What "Up next" means, once, for every surface that shows it: the sidebar's
 * card, the Now mode headline and the desktop tray line (T6, S8.2).
 *
 * The rule is deliberately simple and lives here so no surface can drift:
 *
 * - `current` is the block running at this instant, not at this date: a block
 *   that began at 23:50 is still the block being worked on at 00:10, so it
 *   keeps its row across midnight.
 * - `next` is the first block still to start *today*, in the profile timezone.
 *   Only "next" is a question about a date.
 *
 * Both are plain data: the caller decides what "now" is and how to word the
 * answer.
 */
import type { BlockView } from "../data/store.ts";
import { dateKey } from "../ui/time.ts";

/** The running block, and the next block still to start today. */
export type UpNextBlocks = {
  current: BlockView | undefined;
  next: BlockView | undefined;
};

/** The block running at `nowMs`, then the first block still to start today. */
export function currentAndNext(blocks: BlockView[], nowMs: number, timeZone: string): UpNextBlocks {
  const sorted = [...blocks].sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
  const today = dateKey(new Date(nowMs), timeZone);
  const current = sorted.find(block => Date.parse(block.start) <= nowMs && nowMs < Date.parse(block.end));
  const next = sorted.find(
    block => Date.parse(block.start) > nowMs && dateKey(new Date(block.start), timeZone) === today,
  );
  return { current, next };
}
