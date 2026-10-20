#!/usr/bin/env node
/**
 * Contrast proof for glass materials (G1 acceptance, extended by M2c to the
 * palette's filled rows and the toast's own fill, and by C2b to the solid
 * surfaces: opaque backdrops, accent fills, category tints, selection and the
 * semantic state colours, all of which carry text somewhere in the app).
 *
 * Reads the real tokens out of `src/ui/brand.css`, `src/app.css` and
 * `src/ui/glass.css`, composites every glass tint over the backdrops the app
 * actually puts behind chrome, and asserts WCAG AA (>= 4.5:1) for each label token on each material, in light
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

/**
 * Reads every custom property a sheet declares, for a sheet that has no dark
 * block because it needs none: the brand scale is scheme-independent (one
 * `:root`, and light and dark pick different rungs of it). The scheme-aware
 * loader above throws on such a file, so brand.css gets its own reader.
 */
function readRootTokens(file) {
  const tokens = new Map();
  for (const match of readFileSync(join(appDir, file), "utf8").matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+);/gi))
    tokens.set(match[1], match[2].trim());
  return tokens;
}

const brand = readRootTokens("src/ui/brand.css");

/**
 * Every token the browser would resolve for one scheme. The brand scale comes
 * first so app.css and glass.css win any name they share, and a `var(--ink-N)`
 * reference in either of them resolves through this map instead of failing.
 */
function tokensFor(scheme) {
  return new Map([
    ...brand,
    ...app.light,
    ...glass.light,
    ...(scheme === "dark" ? [...app.dark, ...glass.dark] : []),
  ]);
}

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
  /* Floating chrome (G2) has a floor, not just a tint: below 0.62 the tab bar's
     11px label leaks too much of the page scrolling under it (spec §3). */
  { name: "float", token: "--glass-tint-float", minAlpha: 0.62 },
  { name: "regular", token: "--glass-tint-regular" },
  { name: "thick", token: "--glass-tint-thick" },
];

let failures = 0;
const rows = [];

for (const scheme of ["light", "dark"]) {
  const tokens = tokensFor(scheme);
  const backgrounds = backdrops(tokens);
  for (const material of materials) {
    const tint = parseColor(tokens.get(material.token), tokens);
    if (!(tint[3] > 0 && tint[3] < 1))
      throw new Error(`${material.token} (${scheme}) is not a translucent tint: ${tokens.get(material.token)}`);
    if (material.minAlpha && tint[3] < material.minAlpha)
      throw new Error(
        `${material.token} (${scheme}) is below its ${material.minAlpha} opacity floor: ${tokens.get(material.token)}`,
      );
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
 * pill over the regular sidebar, the tab pill over the floating tab bar. Each
 * fill gets its own proof against the label the pill actually carries.
 *
 * The floating action button is the lens host (G5) and shares the tab bar's
 * float material (G2). It sits directly on the page, so its fill is composited
 * over the page, not over chrome. Its icon is `--accent`, and both the lens fill
 * and the plain float fallback are proven.
 */
const pills = [
  { name: "nav", host: "--glass-tint-regular", label: "--label" },
  { name: "tab", host: "--glass-tint-float", label: "--accent" },
  { name: "fab", host: null, label: "--accent" },
];
const pillFills = [
  { name: "pill", token: "--pill", materials: ["nav", "tab"] },
  { name: "lens", token: "--glass-lens-tint", materials: ["fab"] },
  { name: "plain", token: "--glass-tint-float", materials: ["fab"] },
];

for (const scheme of ["light", "dark"]) {
  const tokens = tokensFor(scheme);
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

/* ---------- palette (F3) and toast (F1, dark glass since G6) ---------- */

/**
 * Reads the translucency a component sheet declares for its own surface, e.g.
 * the palette's error line `color-mix(in srgb, var(--red) 10%, transparent)`.
 * Reading it instead of restating it keeps the proof honest if it is retuned.
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

/**
 * Reads every custom property one rule declares, so the toast's dark tint and
 * its ink come from UndoToast.css instead of being restated here.
 */
function readDeclarations(file, selector) {
  const css = readFileSync(join(appDir, file), "utf8");
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`${file}: no ${selector} rule`);
  const rule = css.slice(start, css.indexOf("}", start));
  const declared = new Map();
  for (const match of rule.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+);/gi)) {
    declared.set(match[1], match[2].trim());
  }
  return declared;
}

const PALETTE_CSS = "src/ui/CommandPalette.css";
const TOAST_CSS = "src/ui/UndoToast.css";
/* The palette's error line: red at 10% over the palette, its text in red. */
const paletteError = readColorMix(PALETTE_CSS, ".palette-error");
const paletteErrorText = readToken(PALETTE_CSS, ".palette-error", "color");
/* The toast's own tokens: the dark tint, its solid twin, and its two ink tiers. */
const toastRule = readDeclarations(TOAST_CSS, ".undo-toast");
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
  const tokens = tokensFor(scheme);
  const page = parseColor(tokens.get("--bg-top"), tokens);
  const scrim = over(parseColor(tokens.get("--scrim"), tokens), page);
  /* The palette is the thick sheet material over the dimmed page. */
  const palette = over(parseColor(tokens.get("--glass-tint-thick"), tokens), scrim);
  const toastTokens = new Map([...tokens, ...toastRule]);
  const toastTint = parseColor(toastTokens.get("--toast-tint"), toastTokens);
  const toastSolid = parseColor(toastTokens.get("--toast-solid"), toastTokens);
  const errorTint = parseColor(tokens.get(paletteError.token), tokens);
  const paletteErrorBase = over([errorTint[0], errorTint[1], errorTint[2], paletteError.ratio], palette);
  const paletteField = over(parseColor(tokens.get("--fill-hover"), tokens), palette);
  const paletteSelected = over(parseColor(tokens.get("--fill-press"), tokens), palette);

  /* Where the palette puts text on something other than the plain material: its
     focused field, its selected row and its error line. */
  /* The toast is dark glass over whatever scrolled behind it, so its ink is
     proven over every enforced backdrop; the solid twin is the reduced-
     transparency fallback and is proven on its own. */
  const toastInk = ["--toast-label", "--toast-quiet"];
  const surfaces = [
    { name: "palette-field", backdrop: "palette", base: paletteField, labels: ["--label", paletteQuiet] },
    { name: "palette-selected", backdrop: "palette", base: paletteSelected, labels: ["--label"] },
    { name: "palette-error", backdrop: "palette", base: paletteErrorBase, labels: [paletteErrorText] },
    ...backdrops(tokens)
      .filter((backdrop) => backdrop.enforced)
      .map((backdrop) => ({
        name: "toast",
        backdrop: backdrop.name,
        base: over(toastTint, backdrop.color),
        labels: toastInk,
        sheet: toastTokens,
      })),
    { name: "toast-solid", backdrop: "reduced transparency", base: toastSolid, labels: toastInk, sheet: toastTokens },
  ];

  for (const surface of surfaces) {
    const sheet = surface.sheet ?? tokens;
    for (const label of surface.labels) {
      const value = ratio(parseColor(sheet.get(label), sheet), surface.base);
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

/* ---------- solid surfaces (C2b) ----------
 *
 * Everything above proves glass. Most text in the app does not sit on glass: it
 * sits on the opaque page and card backdrops, or inside a filled control. These
 * rows hold the same ceiling on the surfaces the tokens are painted on directly.
 *
 * `--now` also appears as *text* (the today marker in the mini calendar, the day
 * header and the agenda's now line), so the state rows prove it per backdrop
 * rather than only as a fill behind `--on-now`.
 */
for (const scheme of ["light", "dark"]) {
  const tokens = tokensFor(scheme);
  const get = (name) => parseColor(tokens.get(name), tokens);
  const pairs = [];
  for (const base of ["--bg-top", "--bg", "--surface", "--surface-2"]) {
    for (const label of LABELS) pairs.push({ name: "solid", backdrop: base, label, bg: get(base), floor: AA });
    pairs.push({ name: "accent-text", backdrop: base, label: "--accent", bg: get(base), floor: AA });
    /* The focus ring is a graphic object, so it is held to 1.4.11 instead. */
    pairs.push({ name: "accent-ring", backdrop: base, label: "--accent", bg: get(base), floor: NON_TEXT });
  }
  for (const [name, bgToken, label] of [
    ["accent-fill", "--accent", "--on-accent"],
    ["accent-hover-fill", "--accent-hover", "--on-accent"],
    ["now-fill", "--now", "--on-now"],
  ])
    pairs.push({ name, backdrop: bgToken, label, bg: get(bgToken), floor: AA });
  /* A category block is a translucent fill over the page, its ink on top. */
  for (const cat of ["focus", "task"])
    for (const base of ["--surface", "--bg-top"])
      pairs.push({
        name: `cat-${cat}`,
        backdrop: base,
        label: `--cat-${cat}-ink`,
        bg: over(get(`--cat-${cat}-bg`), get(base)),
        floor: AA,
      });
  /* `::selection` paints `--label` on the accent wash. */
  for (const base of ["--surface", "--bg-top"])
    pairs.push({ name: "selection", backdrop: base, label: "--label", bg: over(get("--accent-soft"), get(base)), floor: AA });
  /* Semantic state text, proven on every solid it is printed on. */
  for (const state of ["--red", "--orange", "--green", "--now"])
    for (const base of ["--surface", "--bg-top", "--surface-2"])
      pairs.push({ name: "state", backdrop: base, label: state, bg: get(base), floor: AA });
  for (const p of pairs) {
    const value = ratio(get(p.label), p.bg);
    const pass = value >= p.floor;
    if (!pass) failures += 1;
    rows.push({
      scheme,
      material: p.name,
      backdrop: p.backdrop,
      label: p.label,
      surface: toHex(p.bg),
      value,
      floor: p.floor,
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
