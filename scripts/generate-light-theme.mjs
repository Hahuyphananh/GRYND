/**
 * generate-light-theme.mjs — emits src/app/light-theme.css
 *
 * WHY THIS EXISTS
 * ---------------
 * GRYND was built dark-first: screen colours are literal utilities
 * (`bg-[#040d24]`, `text-white`, `border-[#00e5ff]/40`, …) rather than
 * semantic tokens, so there is no `dark:` variant to flip. A light theme
 * therefore has to remap the utilities themselves.
 *
 * Doing that by hand is impossible to keep honest: the app uses ~1,150
 * distinct colour utilities. Doing it by hand per screen is worse — it drifts
 * the moment someone adds a class. So the remap is DERIVED from the source:
 * this script scans src/ for every colour utility actually in use, maps each
 * one through the palette below, and writes exact selectors.
 *
 *   npm run theme:light      # regenerate (only needed when the palette changes)
 *
 * The palette itself is the hand-authored part (see TARGETS / FAMILY_TEXT /
 * SURFACE). The per-utility expansion is mechanical.
 *
 * HOW THE SELECTORS WIN
 * ---------------------
 * Every rule is `html[data-theme="light"]` + the utility's own selector:
 *
 *   html[data-theme="light"] .text-white            → (0,2,1)
 *   html[data-theme="light"] .hover\:text-white:hover → (0,3,1)
 *
 * A Tailwind utility is (0,1,0) and its hover variant (0,2,0), so a plain
 * variant can never out-rank the base rule it is supposed to override — which
 * is exactly the failure mode a naive "just append !important" layer has:
 * `text-white hover:text-cyan-300` would lose its hover entirely. Emitting a
 * rule for the variant too, at one class higher, keeps the hover working.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const srcRoot = path.join(projectRoot, "src");

// Tailwind's own palette — read from the package so the hexes can never drift
// from what the utilities actually resolve to.
const tw = require("tailwindcss/colors.js");

// ══════════════════════════════════════════════════════════════════════════
// Colour maths
// ══════════════════════════════════════════════════════════════════════════

function toRgb(hex) {
  let s = hex.replace("#", "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  if (s.length !== 6) return null;
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}

const channel = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Hue (deg), saturation (0-1), lightness (0-1). */
function hsl([r, g, b]) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * (2 + (bn - rn) / d);
    else h = 60 * (4 + (rn - gn) / d);
  }
  if (h < 0) h += 360;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s, l };
}

const rgba = (rgb, alpha) =>
  `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]} / ${Number(alpha.toFixed(3))})`;

const hexOf = (rgb) =>
  "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");

// ══════════════════════════════════════════════════════════════════════════
// The light palette (hand-authored)
// ══════════════════════════════════════════════════════════════════════════

// Recessed grounds first, then raised surfaces — the same three steps the
// dark theme uses (page → panel → card), so elevation still reads, just
// inverted: in dark, "raised" is lighter; in light, "raised" is lighter too.
//
// THE GROUNDS ARE THE DARK THEME'S OWN BLUE, LIGHTENED — not white.
//
// GRYND's dark theme is a blue theme: the page ground is #030817, the panels
// are #040d24 (#001933, #08142f, #0b224f …), and the body copy is cyan-tinted.
// The light grounds are therefore DERIVED from #040d24, the navy the app uses
// most: its hue is 223°, and every ground below sits on that same 223° so the
// two themes are recognisably one product.
//
// THE RULE: light mode moves ONLY the near-black grounds. Everything else —
// text, hairlines, shadows, neon accents — is exactly what the dark theme
// authored, because the ground it sits on is still dark. `text-white` stays
// white, `border-white/10` stays a light hairline, #00e5ff stays #00e5ff.
//
// Earlier passes ALSO inverted the ink to a blue-black, which is what turned
// the whole screen white and washed out: a full-bleed card was #e6f0fc (then
// #dde4f5) with dark text on it. That inversion is gone; the grounds below are
// deep, saturated blues (the dark ground's 223° hue, lifted a clear step) and
// the dark theme's light type reads on them unchanged.
const PAGE = "#24417f"; // page ground      (dark: #030817)
const CARD = "#31508f"; // raised surface   (dark: #040d24)
const PANEL = "#1b3266"; // recessed surface (dark: #001933)

/** Light ink — used by the bespoke CSS below for star dots and hairlines. */
const INK = "#eaf2ff";
/** Muted light ink, same use. */
const MUTED_INK = "#b7c9ea";
/** Near-black, for the bespoke CSS's drop shadows over a dark blue ground. */
const SHADOW = "#050b18";
/**
 * Retained for reference only: the dark-ink counterpart of an accent. Light
 * mode no longer needs one, because accents stay as authored.
 */
const ROSE_INK = "#a30f35";

/* The same colours as `r, g, b`, for the bespoke CSS below. */
const INK_CSV = toRgb(INK).join(", ");
const MUTED_CSV = toRgb(MUTED_INK).join(", ");
const CARD_CSV = toRgb(CARD).join(", ");
const SHADOW_CSV = toRgb(SHADOW).join(", ");

/**
 * Deep tinted grounds, so a red panel still reads as "red area" and a gold one
 * as gold — each family keeps its own hue, at the same deep-blue lightness
 * band as the neutral grounds. They are dark, not pale: a tinted card is a
 * dark red/blue/gold panel, never white with a hint of hue.
 */
const TARGETS = {
  neutral: { page: PAGE, card: CARD, panel: PANEL },
  green: { page: "#1d4a3a", card: "#265a47", panel: "#163a2d" },
  rose: { page: "#4a2432", card: "#5a2e3d", panel: "#3a1b26" },
  purple: { page: "#38265e", card: "#463070", panel: "#2c1c4a" },
  gold: { page: "#4a3a1a", card: "#5a4722", panel: "#3a2d13" },
  cyan: { page: "#17414f", card: "#1d5062", panel: "#113340" },
};

/**
 * The dark-ink counterpart of an accent, kept only because the standard-palette
 * helpers below still reference it. Light mode does NOT use it: on the lifted
 * blue ground the accents are left exactly as the dark theme authored them.
 */
function familyText(h, s) {
  // A "light grey" on dark was secondary copy. On a blue ground the muted
  // ink has to be a blue-slate, or it reads as grey text on a blue page.
  if (s < 0.12) return "#2e3d5a";
  if (h < 20 || h >= 330) return ROSE_INK;
  if (h < 45) return "#92400e";
  if (h < 70) return "#7a5500";
  if (h < 95) return "#756000";
  if (h < 175) return "#036048";
  if (h < 215) return "#0b5c73";
  if (h < 255) return "#17517f";
  if (h < 300) return "#7e22ce";
  return ROSE_INK;
}

function familyOf(h, s) {
  if (s <= 0.22) return "neutral";
  if (h < 45) return "gold";
  if (h < 95) return "gold";
  if (h < 175) return "green";
  if (h < 215) return "cyan";
  if (h < 255) return "neutral"; // the blue darks ARE the app's own surfaces
  if (h < 300) return "purple";
  return "rose";
}

// ── Arbitrary-value (#hex) mapping ────────────────────────────────────────

/** Backgrounds / gradient stops / rings. */
function mapSurface(hex) {
  const rgb = toRgb(hex);
  if (!rgb) return null;
  const L = luminance(rgb);
  // Anything already bright or chromatic enough to read on white is left
  // alone — that is every solid accent chip, button fill and badge in the app.
  if (L >= 0.09) return null;
  const { h, s } = hsl(rgb);
  const fam = familyOf(h, s);
  const role = L < 0.0035 ? "page" : L < 0.009 ? "card" : "panel";
  return TARGETS[fam][role];
}

/**
 * Text colours are NOT remapped.
 *
 * The ground light mode uses is still dark, so every colour the dark theme
 * authored for type already reads on it: white copy stays white, `/60` copy
 * stays muted, accents stay neon. Returning null leaves the utility untouched.
 */
function mapText() {
  return null;
}

/** Border / divider / outline colours — likewise left as authored. */
function mapBorder() {
  return null;
}

/** Per-property dispatcher for #hex values. */
function mapHex(prop, hex) {
  switch (prop) {
    case "bg":
    case "from":
    case "via":
    case "to":
    case "ring":
    case "ring-offset":
      return mapSurface(hex);
    case "text":
    case "caret":
    case "placeholder":
    case "decoration":
    case "fill":
    case "stroke":
      return mapText(hex);
    case "border":
    case "divide":
    case "outline":
      return mapBorder(hex);
    default:
      return null;
  }
}

// ── Standard Tailwind palette mapping ─────────────────────────────────────

const NEUTRAL_FAMILIES = new Set(["slate", "gray", "zinc", "neutral", "stone"]);
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

function stdHex(name, shade) {
  if (name === "white") return [255, 255, 255];
  if (name === "black") return [0, 0, 0];
  const fam = tw[name];
  if (!fam || typeof fam !== "object") return null;
  const v = fam[shade];
  return typeof v === "string" ? toRgb(v) : null;
}

/** Light surfaces the dark greys become, darkest-first. */
const GREY_SURFACE = { 700: PANEL, 800: PAGE, 900: PAGE, 950: CARD };

function mapStd(prop, name, shade, alpha) {
  const s = shade;

  // ── only GROUNDS are lifted ────────────────────────────────────────────
  //
  // Everything the dark theme authored for type, edges, fills and translucent
  // washes already reads on the lifted blue ground, so NONE of it is remapped:
  // `text-white` stays white, `border-white/10` stays a light hairline, and
  // `bg-white/5` stays a sheen. The single exception is a dark NEUTRAL surface
  // (a near-black panel, popover or scrim), which is the ground being lifted.
  if (alpha != null) return null;
  if (
    name === "white" ||
    name === "black" ||
    name === "transparent" ||
    name === "current" ||
    name === "inherit"
  ) {
    return null;
  }
  if (!NEUTRAL_FAMILIES.has(name)) return null;

  switch (prop) {
    case "bg":
    case "from":
    case "via":
    case "to":
    case "ring-offset": {
      const t = stdBgTarget(name, s);
      const rgb = t ? toRgb(t) : null;
      return rgb ? hexOf(rgb) : null;
    }
    default:
      return null;
  }
}

function stdTextTarget(name, s) {
  if (!NEUTRAL_FAMILIES.has(name)) {
    // Bright roles → a dark step of the same hue, so "danger" is still red.
    const target = s <= 300 ? 700 : s <= 600 ? 600 : s;
    const hex = shadeOf(name, target);
    const rgb = hex ? toRgb(hex) : null;
    if (!rgb) return hex;
    // ...then through the curated family ink. Tailwind's own shade was only
    // ever tuned against white; these inks were tuned against THIS ground, so
    // `text-cyan-700` lands on the value that clears AA here (it was 4.08:1
    // against #d3e2f7 before this, 5.7:1 after) instead of tailwind's #0e7490.
    const { h, s: sat } = hsl(rgb);
    return familyText(h, sat);
  }
  // Neutrals were muted labels; they should stay muted, not turn near-black.
  const target = s <= 300 ? 600 : s <= 500 ? 600 : s === 600 ? 700 : s;
  return shadeOf(name, target);
}

function stdBgTarget(name, s) {
  if (NEUTRAL_FAMILIES.has(name)) {
    return s >= 600 ? GREY_SURFACE[Math.min(950, s)] ?? GREY_SURFACE[900] : null;
  }
  // Only the very dark steps are ambiguous; everything mid/bright is a fill.
  if (s >= 700) return shadeOf(name, 100) ?? null;
  return null;
}

function stdBorderTarget(name, s) {
  if (NEUTRAL_FAMILIES.has(name)) {
    if (s >= 500) return shadeOf(name, 300);
    if (s >= 400) return shadeOf(name, 300);
    return null;
  }
  if (s >= 600) return shadeOf(name, 400);
  return null;
}

function shadeOf(name, shade) {
  const v = tw[name]?.[shade];
  return typeof v === "string" ? v : null;
}

// ══════════════════════════════════════════════════════════════════════════
// Scan src/ for the colour utilities actually in use
// ══════════════════════════════════════════════════════════════════════════

const NAMED = [
  ...NEUTRAL_FAMILIES,
  "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal",
  "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink",
  "rose", "white", "black", "transparent", "current", "inherit",
].join("|");

const PROPS =
  "bg|text|border|from|via|to|ring|ring-offset|fill|stroke|divide|placeholder|caret|outline|decoration";

const VARIANTS = "hover|focus|focus-visible|active|disabled|group-hover|sm|md|lg|xl|2xl";

const TOKEN_RE = new RegExp(
  `(?<![\\w:.#\\/-])((?:(?:${VARIANTS}):)*)((?:${PROPS})-(?:\\[#[0-9a-fA-F]{3,8}\\]|(?:${NAMED})(?:-\\d{2,3})?))(?:(\\/)(\\d{1,3}))?`,
  "g",
);

function listSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(p));
    else if (/\.(jsx?|tsx?)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const tokens = new Set();
for (const file of listSourceFiles(srcRoot)) {
  const source = fs.readFileSync(file, "utf8");
  let m;
  while ((m = TOKEN_RE.exec(source))) {
    tokens.add(m[1] + m[2] + (m[3] ? m[3] + m[4] : ""));
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Selector + declaration construction
// ══════════════════════════════════════════════════════════════════════════

const cssEscape = (s) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);

const BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 };
const PSEUDO = {
  hover: ":hover",
  focus: ":focus",
  "focus-visible": ":focus-visible",
  active: ":active",
  disabled: ":disabled",
};

function parseToken(token) {
  const m = token.match(
    /^((?:(?:[a-z-]+):)*)(.+?)(?:\/(\d{1,3}))?$/,
  );
  if (!m) return null;
  const variants = m[1] ? m[1].slice(0, -1).split(":") : [];
  let body = m[2];
  let alpha = m[3] != null ? Number(m[3]) : null;

  // A plain `body/40` split can land inside an arbitrary value
  // (`bg-[#00e5ff]/40`), so re-split on the LAST slash outside brackets.
  const bracketEnd = body.lastIndexOf("]");
  const slash = body.indexOf("/", bracketEnd + 1);
  if (slash !== -1) {
    alpha = Number(body.slice(slash + 1));
    body = body.slice(0, slash);
  }

  // `ring-offset-` is the only two-word property, so it is read first.
  let prop;
  let value;
  if (body.startsWith("ring-offset-")) {
    prop = "ring-offset";
    value = body.slice("ring-offset-".length);
  } else {
    const dash = body.indexOf("-");
    prop = body.slice(0, dash);
    value = body.slice(dash + 1);
  }

  let hex = null;
  let name = null;
  let shade = null;
  if (value.startsWith("[#")) {
    hex = value.slice(2, -1);
  } else {
    const parts = value.split("-");
    if (parts.length === 2 && SHADES.includes(Number(parts[1]))) {
      name = parts[0];
      shade = Number(parts[1]);
    } else if (parts.length === 1 && NAMED.split("|").includes(parts[0])) {
      name = parts[0];
    } else {
      return null;
    }
  }

  return { variants, prop, hex, name, shade, alpha };
}

function declarations(parsed) {
  const { prop, hex, name, shade, alpha } = parsed;

  const mapped = hex != null
    ? mapHex(prop, hex)
    : mapStd(prop, name, shade, alpha);
  if (!mapped) return null;

  const solid = mapped; // "#rrggbb" | "rgb(r g b / a)"
  // Keep the author's own transparency, but lift faint edges so a 5%-opacity
  // hairline still reads against a white ground.
  const withAlpha = (color, boost = 1) => {
    if (alpha == null) return color;
    if (color.startsWith("rgb(")) return color;
    const rgb = toRgb(color);
    return rgba(rgb, Math.min(1, (alpha / 100) * boost));
  };

  switch (prop) {
    case "bg":
      return [`background-color: ${withAlpha(solid)} !important;`];
    case "text":
      return [`color: ${withAlpha(solid)} !important;`];
    case "caret":
      return [`caret-color: ${withAlpha(solid)} !important;`];
    case "placeholder":
      return [`color: ${withAlpha(solid)} !important;`];
    case "decoration":
      return [`text-decoration-color: ${withAlpha(solid)} !important;`];
    case "fill":
      return [`fill: ${withAlpha(solid)} !important;`];
    case "stroke":
      return [`stroke: ${withAlpha(solid)} !important;`];
    case "border":
      return [`border-color: ${withAlpha(solid, 1.5)} !important;`];
    case "divide":
      return [`border-color: ${withAlpha(solid, 1.5)} !important;`];
    case "outline":
      return [`outline-color: ${withAlpha(solid)} !important;`];
    case "ring":
      return [`--tw-ring-color: ${withAlpha(solid)} !important;`];
    case "ring-offset":
      return [`--tw-ring-offset-color: ${withAlpha(solid)} !important;`];
    case "from":
      return [
        `--tw-gradient-from: ${withAlpha(solid)} var(--tw-gradient-from-position) !important;`,
        `--tw-gradient-to: ${transparentOf(solid)} var(--tw-gradient-to-position) !important;`,
      ];
    case "via":
      return [
        `--tw-gradient-to: ${transparentOf(solid)} var(--tw-gradient-to-position) !important;`,
        `--tw-gradient-stops: var(--tw-gradient-from), ${withAlpha(solid)} var(--tw-gradient-via-position), var(--tw-gradient-to) !important;`,
      ];
    case "to":
      return [
        `--tw-gradient-to: ${withAlpha(solid)} var(--tw-gradient-to-position) !important;`,
      ];
    default:
      return null;
  }
}

function transparentOf(color) {
  if (color.startsWith("rgb(")) {
    const nums = color.match(/\d+/g);
    return `rgb(${nums[0]} ${nums[1]} ${nums[2]} / 0)`;
  }
  const rgb = toRgb(color);
  return `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]} / 0)`;
}

function buildRule(token) {
  const parsed = parseToken(token);
  if (!parsed) return null;

  const decls = declarations(parsed);
  if (!decls) return null;

  let base = "." + cssEscape(token);
  let pseudo = "";
  let groupPrefix = "";
  let media = null;

  for (const v of parsed.variants) {
    if (BREAKPOINTS[v]) {
      media = BREAKPOINTS[v];
    } else if (v === "group-hover") {
      groupPrefix = ".group:hover ";
    } else if (PSEUDO[v]) {
      pseudo += PSEUDO[v];
    }
  }

  let selector = `html[data-theme="light"] ${groupPrefix}${base}${pseudo}`;
  // `divide-*` styles the *children* of the element carrying the class.
  if (parsed.prop === "divide") {
    selector += " > :not([hidden]) ~ :not([hidden])";
  } else if (parsed.prop === "placeholder") {
    selector += "::placeholder";
  } else if (parsed.prop === "caret") {
    // caret-color is on the element itself.
  }

  const body = `  ${decls.join("\n  ")}`;
  const rule = `${selector} {\n${body}\n}`;
  return media ? `@media (min-width: ${media}px) {\n  ${rule}\n}` : rule;
}

// Build, dropping any token whose mapped value is identical to the declared
// one (nothing to say) and de-duplicating equal selectors.
const rules = [];
const seen = new Set();
let unmapped = 0;
for (const token of [...tokens].sort()) {
  const parsed = parseToken(token);
  if (!parsed) continue;
  const rule = buildRule(token);
  if (!rule) {
    unmapped += 1;
    continue;
  }
  const key = rule.split("{\n")[0];
  if (seen.has(key)) continue;
  seen.add(key);
  rules.push(rule);
}

// ══════════════════════════════════════════════════════════════════════════
// Bespoke CSS in globals.css that sets colours outside a utility
// ══════════════════════════════════════════════════════════════════════════

const BESPOKE = `
/* ── Hand-written surfaces in globals.css ──────────────────────────────
   These paint colour from CSS rather than a utility, so the utility sweep
   above never sees them. */

html[data-theme="light"] .animated-bg {
  background: linear-gradient(270deg, ${PAGE}, ${PANEL}, ${CARD}, ${PAGE}) !important;
}

html[data-theme="light"] .casino-surface {
  background: rgba(${CARD_CSV}, 0.72) !important;
  border-color: rgba(250, 204, 21, 0.22) !important;
  box-shadow: 0 18px 35px rgba(${SHADOW_CSV}, 0.45) !important;
}

html[data-theme="light"] .space-bg {
  background:
    radial-gradient(1px 1px at 15% 20%, rgba(${INK_CSV}, 0.5), transparent),
    radial-gradient(1px 1px at 70% 30%, rgba(${INK_CSV}, 0.5), transparent),
    radial-gradient(1px 1px at 40% 70%, rgba(${INK_CSV}, 0.5), transparent),
    radial-gradient(2px 2px at 85% 80%, rgba(${INK_CSV}, 0.5), transparent),
    linear-gradient(to bottom, ${CARD}, ${PAGE}) !important;
}

html[data-theme="light"] .skeleton {
  background: linear-gradient(90deg, ${PANEL} 0%, ${CARD} 50%, ${PANEL} 100%) !important;
}

/* Four-In-A-Row paints its board, sockets and HUD from stylesheet colour, not
   utilities. Its base styles are already a dark blue with NEON CYAN rims, so
   light mode only lifts the GROUNDS and leaves every cyan accent as authored.
   The previous pass repainted those rims teal-on-white, which is exactly the
   washed-out look this file moved away from. */
html[data-theme="light"] .four-in-a-row-board {
  background:
    linear-gradient(rgba(0, 229, 255, 0.06) 1px, transparent 1px) 0 0 / 100% 2.5rem,
    linear-gradient(180deg, ${CARD} 0%, ${PAGE} 58%, ${PANEL} 100%) !important;
  box-shadow:
    inset 0 0 0 1px rgba(0, 229, 255, 0.08),
    inset 0 0 44px rgba(0, 229, 255, 0.05),
    0 18px 34px rgba(${SHADOW_CSV}, 0.45) !important;
}

html[data-theme="light"] .four-in-a-row-slot {
  background: radial-gradient(circle at 50% 46%, ${PAGE} 0 44%, ${PANEL} 74%, ${SHADOW} 100%) !important;
}

html[data-theme="light"] .four-in-a-row-panel {
  background: linear-gradient(180deg, ${CARD}, ${PAGE}) !important;
  box-shadow: 0 18px 35px rgba(${SHADOW_CSV}, 0.45), 0 0 24px rgba(0, 229, 255, 0.07) !important;
}
`;

// ══════════════════════════════════════════════════════════════════════════
// Emit
// ══════════════════════════════════════════════════════════════════════════

const header = `/* ══════════════════════════════════════════════════════════════════════
   LIGHT THEME — GENERATED FILE, DO NOT EDIT BY HAND
   Regenerate with:  npm run theme:light
   Source of truth:  scripts/generate-light-theme.mjs

   GRYND is dark-first: colour lives in literal utilities (bg-[#040d24],
   text-white, border-[#00e5ff]/40, …), so there is no \`dark:\` variant to
   flip. The light theme therefore remaps those utilities instead, and this
   file is the result of scanning src/ for every colour utility the app
   actually uses (${tokens.size} of them) and mapping each one to a light
   counterpart.

   Every rule is \`html[data-theme="light"]\` + the utility's own selector, so
   a variant rule (\`hover:\`, \`focus-visible:\`, \`group-hover:\`, \`disabled:\`)
   still out-ranks the base rule it is meant to override — otherwise
   \`text-white hover:text-cyan-300\` would silently lose its hover.

   The theme is switched by src/context/ThemeContext.js, which sets
   data-theme on <html>.
   ══════════════════════════════════════════════════════════════════════ */

/* Native form controls, scrollbars and the like follow the theme. */
html[data-theme="light"] {
  color-scheme: light;
  background-color: ${PAGE};
}

html[data-theme="dark"] {
  color-scheme: dark;
}
`;

const out = [
  header,
  `/* ── Colour utilities in use in src/ ──────────────────────────────────
   ${rules.length} rules. Grouped only by the source-order scan; each rule is
   independent. */\n`,
  rules.join("\n\n"),
  BESPOKE,
].join("\n");

const outFile = path.join(srcRoot, "app", "light-theme.css");
fs.writeFileSync(outFile, out);
console.log(
  `light-theme.css written: ${rules.length} rules from ${tokens.size} tokens ` +
    `(${unmapped} left alone).`,
);
console.log("Unmapped (by design — already legible on a light ground):");
console.log(
  [...tokens]
    .filter((t) => !buildRule(t))
    .slice(0, 12)
    .map((t) => "  " + t)
    .join("\n"),
);
