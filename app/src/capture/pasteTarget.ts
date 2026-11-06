/**
 * Paste-anywhere (Ronda 8, S3, plan §1): a page-level paste with no field
 * focused and no dialog open opens the capture sheet pre-filled. Pure and
 * DOM-free so the rule is testable; App.tsx reads the event and the document
 * and asks this module what to do.
 *
 * Pasting into a field must behave exactly as before, so every doubt answers
 * "not mine": a field as target or as the focused element, an open dialog or
 * sheet, a paste with no text (an image, a blank clipboard).
 */

import { isTypingTarget } from "../ui/shortcuts.ts";

export type PasteContext = {
  /** The paste event's target. */
  target: unknown;
  /** `document.activeElement`: the paste target can be the body while a field holds focus. */
  active: unknown;
  /** A dialog, sheet or other modal surface is open (`dialogOpen()` in ui/shortcuts.ts). */
  dialogOpen: boolean;
  /** The clipboard's plain text. */
  text: string;
};

/** The text to pre-fill the capture sheet with, or null when the paste is not for it. */
export function pasteCaptureText({ target, active, dialogOpen, text }: PasteContext): string | null {
  if (dialogOpen) return null;
  if (isTypingTarget(target) || isTypingTarget(active)) return null;
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}
