/**
 * The value one step from a typed draft, held to `[min, max]`. An empty or
 * unreadable draft starts from `fallback`, so the first press moves from the
 * current stored value rather than from zero.
 */
export function stepWithin(draft: string, delta: number, min: number, max: number, fallback: number): number {
  const current = draft === "" || !Number.isFinite(Number(draft)) ? fallback : Number(draft);
  return Math.min(max, Math.max(min, current + delta));
}
