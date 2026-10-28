/**
 * Pure keyboard rules for a listbox (ARIA APG select-only combobox): type-ahead
 * and the arrow/Home/End/Page movement. No DOM, so the rules are unit-tested.
 */

/** A pause longer than this starts a new prefix. */
export const TYPEAHEAD_RESET_MS = 500;

export type TypeaheadState = { buffer: string; at: number };

/** One printable character with no command modifier. */
export function isTypeaheadKey(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return [...event.key].length === 1;
}

/**
 * The index a typed character moves the active option to, and the buffer to keep.
 * One letter, or the same letter repeated, jumps to the next label starting with
 * it (wrapping, so repeats cycle); a longer prefix searches from the active
 * label inclusive, so it keeps its place while the prefix narrows. No match
 * leaves the active index as it is (-1 when there is none).
 */
export function typeahead(
  labels: readonly string[],
  active: number,
  key: string,
  state: TypeaheadState,
  now: number,
): { index: number; state: TypeaheadState } {
  const live = state.buffer !== "" && now - state.at <= TYPEAHEAD_RESET_MS;
  const buffer = (live ? state.buffer : "") + key;
  const next: TypeaheadState = { buffer, at: now };
  const needle = buffer.toLocaleLowerCase();
  const letters = [...needle];
  const cycling = letters.every(letter => letter === letters[0]);
  const prefix = cycling ? letters[0] : needle;
  const from = cycling ? active + 1 : Math.max(active, 0);
  const count = labels.length;
  for (let step = 0; step < count; step += 1) {
    const index = (from + step) % count;
    if (labels[index].toLocaleLowerCase().startsWith(prefix)) return { index, state: next };
  }
  return { index: active, state: next };
}

/** The active index after an arrow, Home, End or Page key; clamped, never wrapping. */
export function moveActive(active: number, count: number, key: "ArrowDown" | "ArrowUp" | "Home" | "End" | "PageDown" | "PageUp"): number {
  if (count <= 0) return -1;
  const last = count - 1;
  const from = Math.min(Math.max(active, 0), last);
  switch (key) {
    case "ArrowDown": return Math.min(from + 1, last);
    case "ArrowUp": return Math.max(from - 1, 0);
    case "Home": return 0;
    case "End": return last;
    case "PageDown": return Math.min(from + 10, last);
    case "PageUp": return Math.max(from - 10, 0);
  }
}
