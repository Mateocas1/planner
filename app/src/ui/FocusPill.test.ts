import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("./FocusPill.css", import.meta.url), "utf8");
const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");

/** The declaration block of the first rule whose selector list matches exactly. */
function ruleBody(selector: string): string | undefined {
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map(part => part.trim());
    if (selectors.includes(selector)) return match[2];
  }
  return undefined;
}

test("the pill ring steps once per tick: no perpetual stroke-dashoffset transition", () => {
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /transition[^;]*stroke-dashoffset/);
});

test("the pill window marks <html> before anything paints", () => {
  assert.match(main, /document\.documentElement\.dataset\.window\s*=\s*"pill"/);
});

test("html, body and body::before are transparent in the pill window", () => {
  const html = ruleBody('html[data-window="pill"]');
  const body = ruleBody('html[data-window="pill"] body');
  const backdrop = ruleBody('html[data-window="pill"] body::before');
  assert.match(html ?? "", /background:\s*transparent/);
  assert.match(body ?? "", /background:\s*transparent/);
  assert.match(backdrop ?? "", /(content:\s*none|background:\s*none|display:\s*none)/);
});

test("the pill button hover is gated to fine pointers", () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const gate = stripped.indexOf("@media (hover: hover) and (pointer: fine)");
  const hover = stripped.indexOf(".focus-pill-button:hover");
  assert.ok(gate !== -1 && hover > gate, "hover rule sits inside the hover/pointer media query");
});
