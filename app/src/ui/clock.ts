/** Clock text helpers shared by the settings rows and the block form; plain TypeScript so the node tests load them. */

/**
 * "HH:MM" for minutes after midnight. The end of the day reads as 24:00.
 */
export function formatClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/**
 * Minutes after midnight for a typed time, or null when the text is not a time.
 * The range is the caller's rule: 25:00 parses to 1500 so the caller can reject
 * it as outside the day, which is a different sentence from "not a time".
 * `9`, `09`, `9:30`, `09:30` and `0930` all read; `9:5` does not.
 */
export function parseClock(text: string): number | null {
  const match = /^(\d{1,2})(?::?(\d{2}))?$/.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const rest = match[2] === undefined ? 0 : Number(match[2]);
  if (rest > 59) return null;
  return hours * 60 + rest;
}
