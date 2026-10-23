import "./Keycap.css";

/**
 * One keycap, one style (design brief §5): the recorder chips and the
 * read-only "Built in" list both draw their keys through this, so `Ctrl`,
 * `K`, `↑` and `Enter` sit in the same cap. The caption font is the UI font,
 * never the browser's monospace default.
 */
export function Keycap({ children }: { children: string }) {
  return <kbd className="keycap">{children}</kbd>;
}
