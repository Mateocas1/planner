#!/usr/bin/env node
/**
 * Contrast proof for glass materials (G1 acceptance, extended by M2c to the
 * palette's filled rows and the toast's own fill).
 *
 * Reads the real tokens out of `src/app.css` and `src/ui/glass.css`, composites
 * every glass tint over the backdrops the app actually puts behind chrome, and
 * asserts WCAG AA (>= 4.5:1) for each label token on each material, in light
 * and dark mode. Fails loudly if a token pair is below the floor or if a token
 * the script depends on disappears.
 *
 * Usage: node scripts/glass-contrast.mjs [--verbose]
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const verbose = process.argv.includes("--verbose");
const AA = 4.5;

/* ---------- token extraction ---------- */

/**
 * Splits app.css into light and dark mode token maps. Dark tokens are the ones
 * declared inside `@media (prefers-color-scheme: dark)`, so the script reads
 * the block boundaries instead of guessing which value belongs where.
 */
function readSchemeTokens(file) {
  const css = readFileSync(join(appDir, file), "utf8");
  const darkStart = css.indexOf("@media (prefers-color-scheme: dark)");
  if (darkStart < 0) throw new Error(`${file}: no dark-mode block found`);
  let depth = 0;
  let darkEnd = css.length;
  for (let i = css.indexOf("{", darkStart); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        darkEnd = i;
        break;
      }
    }
  }
  const light = new Map();
  const dark = new Map();
  const collect = (text, target) => {
    for (const match of text.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+);/gi)) {
      target.set(match[1], match[2].trim());
    }
  };
  collect(css.slice(0, darkStart), light);
  collect(css.slice(darkStart, darkEnd), dark);
  collect(css.slice(darkEnd), light);
  return { light, dark };
}

/* ---------- colour maths ---------- */

const clamp = (n) => Math.min(255, Math.max(0, n));

/** Parses `#rgb`, `#rrggbb`, `rgb(r g b)`, `rgb(r g b / a)` into [r,g,b,a]. */
function parseColor(value, tokens, seen = new Set()) {
  const text = value.trim();
  if (text.startsWith("var(")) {
    const name = text.slice(4, text.indexOf(")")).trim();
    if (seen.has(name)) throw new Error(`token cycle at ${name}`);
    if (!tokens.has(name)) throw new Error(`unknown token ${name}`);
    return parseColor(tokens.get(name), tokens, new Set([...seen, name]));
  }
  if (text.startsWith("#")) {
    const hex = text.slice(1);
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
      1,
    ];
  }
  const numbers = text.match(/-?[\d.]+(?:%|\s*)?/g);
  if (!numbers) throw new Error(`cannot parse colour: ${value}`);
  const [r, g, b, a = "1"] = numbers.map((n) => n.trim());
  return [Number(r), Number(g), Number(b), Number(a)];
}

const over = (fg, bg) => {
  const alpha = fg[3] * (bg[3] ?? 1);
  return [
    clamp(fg[0] * alpha + bg[0] * (1 - alpha)),
    clamp(fg[1] * alpha + bg[1] * (1 - alpha)),
    clamp(fg[2] * alpha + bg[2] * (1 - alpha)),
    1,
  ];
};

const toHex = (rgb) =>
  `#${rgb
    .slice(0, 3)
    .map((c) => Math.round(c).toString(16).padStart(2, "0"))
    .join("")}`;

const linear = (channel) => {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

function ratio(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/* ---------- the proof ---------- */

const app = readSchemeTokens("src/app.css");
const glass = readSchemeTokens("src/ui/glass.css");

const LABELS = ["--label", "--label-2", "--label-3"];

/**
 * Backdrops a glass surface can sit over, all of them app content: the page
 * gradient, a grouped surface, the two category fills, and the dimmed page
 * behind a sheet.
 *
 * `--accent` is printed as a stress row, not enforced. A saturated fill cannot
 * be cleared by any glass tint short of ~0.95 (thick 0.88 over light accent is
 * 4.32:1 for --label-3), and it is never *behind* a surface in practice: rows,
 * fields and blocks are opaque, so the accent only ever sits inside the glass,
 * not under it. If a surface ever floats over a saturated fill, its text must
 * use --label or --label-2, which do clear it (7.44:1 and 3.99:1 thin).
 */
function backdrops(tokens) {
  const base = parseColor(tokens.get("--bg-top"), tokens);
  return [
    { name: "page-top", color: base, enforced: true },
    { name: "page-bottom", color: parseColor(tokens.get("--bg"), tokens), enforced: true },
    { name: "surface-2", color: parseColor(tokens.get("--surface-2"), tokens), enforced: true },
    { name: "focus-block", color: over(parseColor(tokens.get("--cat-focus-bg"), tokens), base), enforced: true },
    { name: "task-block", color: over(parseColor(tokens.get("--cat-task-bg"), tokens), base), enforced: true },
    {
      // Only the sheet floats over the dimmed page, and it is the thick material.
      name: "scrim-page",
      color: over(parseColor(tokens.get("--scrim"), tokens), base),
      enforced: true,
      materials: ["thick"],
    },
    {
      name: "accent-stress",
      color: parseColor(tokens.get("--accent"), tokens),
      enforced: false,
    },
  ];
}

const materials = [
  { name: "thin", token: "--glass-tint-thin" },
  { name: "regular", token: "--glass-tint-regular" },
  { name: "thick", token: "--glass-tint-thick" },
];

let failures = 0;
const rows = [];

for (const scheme of ["light", "dark"]) {
  const tokens = new Map([
    ...app.light,
    ...glass.light,
    ...(scheme === "dark" ? [...app.dark, ...glass.dark] : []),
  ]);
  const backgrounds = backdrops(tokens);
  for (const material of materials) {
    const tint = parseColor(tokens.get(material.token), tokens);
    if (!(tint[3] > 0 && tint[3] < 1))
      throw new Error(`${material.token} (${scheme}) is not a translucent tint: ${tokens.get(material.token)}`);
    for (const backdrop of backgrounds) {
      const surface = over(tint, backdrop.color);
      for (const label of LABELS) {
        const value = ratio(parseColor(tokens.get(label), tokens), surface);
        const enforced =
          backdrop.enforced && (!backdrop.materials || backdrop.materials.includes(material.name));
        const pass = value >= AA;
        if (enforced && !pass) failures += 1;
        rows.push({
          scheme,
          material: material.name,
          backdrop: backdrop.name,
          label,
          surface: toHex(surface),
          value,
          enforced,
          pass,
        });
      }
    }
  }
}

/* ---------- pills (G3) and the lens host (G5) ---------- */

/**
 * The sliding pill is its own thin layer over the chrome that holds it: the nav
 * pill over the regular sidebar, the tab pill over the thin tab bar. Each fill
 * gets its own proof against the label the pill actually carries.
 *
 * The floating action button is the lens host (G5). It sits directly on the
 * page, so its fill is composited over the page, not over chrome. Its icon is
 * `--accent`, and both the lens fill and the plain thin fallback are proven.
 */
const pills = [
  { name: "nav", host: "--glass-tint-regular", label: "--label" },
  { name: "tab", host: "--glass-tint-thin", label: "--accent" },
  { name: "fab", host: null, label: "--accent" },
];
const pillFills = [
  { name: "pill", token: "--pill", materials: ["nav", "tab"] },
  { name: "lens", token: "--glass-lens-tint", materials: ["fab"] },
  { name: "plain", token: "--glass-tint-thin", materials: ["fab"] },
];

for (const scheme of ["light", "dark"]) {
  const tokens = new Map([
    ...app.light,
    ...glass.light,
    ...(scheme === "dark" ? [...app.dark, ...glass.dark] : []),
  ]);
  const page = parseColor(tokens.get("--bg-top"), tokens);
  for (const pill of pills) {
    const chrome = pill.host ? over(parseColor(tokens.get(pill.host), tokens), page) : page;
    for (const fill of pillFills) {
      if (!fill.materials.includes(pill.name)) continue;
      const surface = over(parseColor(tokens.get(fill.token), tokens), chrome);
      const value = ratio(parseColor(tokens.get(pill.label), tokens), surface);
      const enforced = true;
      const pass = value >= AA;
      if (!pass) failures += 1;
      rows.push({
        scheme,
        material: `${fill.name}-${pill.name}`,
        backdrop: pill.host ? "chrome" : "page",
        label: pill.label,
        surface: toHex(surface),
        value,
        enforced,
        pass,
      });
    }
  }
}

/* ---------- palette (F3) and toast (F1) ---------- */

/**
 * Reads the translucency a component sheet declares for its own surface, e.g.
 * the toast's `color-mix(in srgb, var(--surface) 90%, transparent)`. Reading it
 * instead of restating it keeps the proof honest if the material is retuned.
 */
function readColorMix(file, selector) {
  const css = readFileSync(join(appDir, file), "utf8");
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`${file}: no ${selector} rule`);
  const rule = css.slice(start, css.indexOf("}", start));
  const match = rule.match(/color-mix\(\s*in srgb,\s*var\(--([a-z0-9-]+)\)\s*([\d.]+)%,\s*transparent\s*\)/i);
  if (!match) throw new Error(`${file}: ${selector} has no translucent color-mix background`);
  return { token: `--${match[1]}`, ratio: Number(match[2]) / 100 };
}

/**
 * The token a component sheet paints one property of one element with, so the
 * palette's own text tiers are read from CommandPalette.css instead of being
 * restated here and drifting away from it.
 */
function readToken(file, selector, property) {
  const css = readFileSync(join(appDir, file), "utf8");
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`${file}: no ${selector} rule`);
  const rule = css.slice(start, css.indexOf("}", start));
  const match = rule.match(new RegExp(`${property}\\s*:\\s*var\\((--[a-z0-9-]+)\\)`, "i"));
  if (!match) throw new Error(`${file}: ${selector} does not set ${property} to a token`);
  return match[1];
}

const PALETTE_CSS = "src/ui/CommandPalette.css";
const toastBase = readColorMix("src/ui/UndoToast.css", ".undo-toast");
/* The palette's quiet tier on its filled field: the placeholder and the search
   icon. Text, so it is held to AA like every other label. */
const paletteQuiet = readToken(PALETTE_CSS, ".palette-input::placeholder", "color");
/* The selected row's icon is a graphic object, not text (WCAG 1.4.11 floor). */
const paletteSelectedIcon = readToken(
  PALETTE_CSS,
  '.palette-option[aria-selected="true"] .palette-option-icon',
  "color",
);

/** WCAG 1.4.11: non-text contrast for graphical objects needed to understand the UI. */
const NON_TEXT = 3;

for (const scheme of ["light", "dark"]) {
  const tokens = new Map([
    ...app.light,
    ...glass.light,
    ...(scheme === "dark" ? [...app.dark, ...glass.dark] : []),
  ]);
  const page = parseColor(tokens.get("--bg-top"), tokens);
  const scrim = over(parseColor(tokens.get("--scrim"), tokens), page);
  /* The palette is the thick sheet material over the dimmed page. */
  const palette = over(parseColor(tokens.get("--glass-tint-thick"), tokens), scrim);
  const toastFill = parseColor(tokens.get(toastBase.token), tokens);
  const toast = over([...toastFill.slice(0, 3), toastBase.ratio * toastFill[3]], page);
  const paletteField = over(parseColor(tokens.get("--fill-hover"), tokens), palette);
  const paletteSelected = over(parseColor(tokens.get("--fill-press"), tokens), palette);

  /* Only these three places put text on something other than the plain
     material: the palette's focused field, its selected row, and the toast,
     whose fill is its own recipe and whose backdrop is whatever scrolled. */
  const surfaces = [
    { name: "palette-field", backdrop: "palette", base: paletteField, labels: ["--label", paletteQuiet] },
    { name: "palette-selected", backdrop: "palette", base: paletteSelected, labels: ["--label"] },
    { name: "toast", backdrop: "page", base: toast, labels: ["--label", "--label-2", "--label-3"] },
  ];

  for (const surface of surfaces) {
    for (const label of surface.labels) {
      const value = ratio(parseColor(tokens.get(label), tokens), surface.base);
      const pass = value >= AA;
      if (!pass) failures += 1;
      rows.push({
        scheme,
        material: surface.name,
        backdrop: surface.backdrop,
        label,
        surface: toHex(surface.base),
        value,
        floor: AA,
        enforced: true,
        pass,
      });
    }
  }

  /* The toast's Undo button is the accent pair; the selected palette row paints
     its icon in the accent. One is text, the other a graphic object. */
  const graphics = [
    { name: "toast-action", backdrop: "accent", label: "--on-accent", base: parseColor(tokens.get("--accent"), tokens), floor: AA },
    {
      name: "palette-selected-icon",
      backdrop: "palette",
      label: paletteSelectedIcon,
      base: paletteSelected,
      floor: NON_TEXT,
    },
  ];
  for (const graphic of graphics) {
    const value = ratio(parseColor(tokens.get(graphic.label), tokens), graphic.base);
    const pass = value >= graphic.floor;
    if (!pass) failures += 1;
    rows.push({
      scheme,
      material: graphic.name,
      backdrop: graphic.backdrop,
      label: graphic.label,
      surface: toHex(graphic.base),
      value,
      floor: graphic.floor,
      enforced: true,
      pass,
    });
  }
}

/* The strongest claim the suite can make: every enforced cell clears the WCAG
   floor that applies to it — AA for text, 1.4.11 for a graphic object. */
const floorOf = (row) => row.floor ?? AA;
const enforced = rows.filter((row) => row.enforced);
const text = enforced.filter((row) => floorOf(row) === AA);
const graphics = enforced.filter((row) => floorOf(row) !== AA);
/* Each bucket shares one floor, so the lowest value is the closest call. */
const worstOf = (list) => list.reduce((a, b) => (a.value <= b.value ? a : b));

if (verbose || failures > 0) {
  const header = "scheme  material  backdrop       label      surface   ratio  status";
  console.log(header);
  for (const row of rows) {
    console.log(
      [
        row.scheme.padEnd(7),
        row.material.padEnd(22),
        row.backdrop.padEnd(15),
        row.label.padEnd(10),
        row.surface.padEnd(9),
        row.value.toFixed(2).padStart(5),
        row.enforced ? (row.pass ? "ok" : "FAIL") : "stress",
      ].join(" "),
    );
  }
  console.log("");
}

if (failures > 0) {
  console.error(`${failures} enforced pair(s) below AA ${AA}:1`);
  process.exit(1);
}

const describe = (row) =>
  `${row.value.toFixed(2)}:1, ${row.scheme} ${row.material} ${row.backdrop} ${row.label}`;
console.log(
  `glass contrast: ${text.length} text pairs >= ${AA}:1 (worst ${describe(worstOf(text))}); ` +
    `${graphics.length} graphic pairs >= ${NON_TEXT}:1 (worst ${describe(worstOf(graphics))})`,
);
