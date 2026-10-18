// qa/game-primitives-check.mjs
//
// Drives qa/game-primitives-harness.tsx — the REAL GameBoardFrame / GameCell /
// GamePiece / TurnBanner, mounted against the REAL stylesheet (globals.css plus
// the shipped Tailwind output, with the light theme inlined the way Next does
// it) — and measures what a component test cannot: the styles the browser
// actually computes.
//
// Why this exists next to tests/game-primitives.test.mjs: that suite renders the
// components to HTML and checks the contract (roles, hooks, tokens, no copy).
// An SSR string cannot tell you whether `bg-surface-raised` produced any CSS at
// all — a class name is only a promise. This check reads it back:
//
//   1. tokens resolve          — the ground, the panel and the ink, in BOTH themes
//   2. the sharp HUD variant    — 3px corners, the cyan edge, the corner brackets
//   3. five cell states differ  — default / occupied / legal / selected / disabled
//   4. legal-move contrast      — the marker clears 3:1 on the dark AND light ground
//   5. focus                    — a real 2px ring from the token, on a real <button>
//   6. accessibility            — live-region politeness, aria-disabled cells stay
//                                 focusable, ownership pip is a SHAPE per seat
//   7. touch + responsive       — 44px opt-in floor, 9 columns at 320px, no
//                                 horizontal overflow at 320/360/390/1280
//   8. no clipping              — a label that overhangs its cell is still hit-testable
//   9. pieces                   — 8 distinct silhouettes, one 2px outline, three
//                                 shading values, ownership pip per seat
//  10. reduced motion           — the duration scale collapses to 0s
//
// Run: node qa/game-primitives-check.mjs        (add --trace for a trace zip)
//
// Fully offline: no dev server, no auth, no database.

import esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { chromium } from "playwright";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "grynd-game-primitives-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });
const TRACE = process.argv.includes("--trace");
const require = createRequire(import.meta.url);

// ── Bundle the harness ────────────────────────────────────────────────────
await esbuild.build({
  entryPoints: [join(root, "qa/game-primitives-harness.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"development"' },
});

// ── The app's REAL stylesheet ─────────────────────────────────────────────
// Next inlines `@import "./light-theme.css"`, so the check does too: this is the
// only way the light-mode measurements below mean anything.
const lightTheme = readFileSync(join(root, "src/app/light-theme.css"), "utf8");
const globals = readFileSync(join(root, "src/app/globals.css"), "utf8")
  .replace(/@import\s+"\.\/light-theme\.css";?/, lightTheme)
  .replace(/@import\s+url\(["']?https?:\/\/[^)]*\);?/g, "");

const tailwindConfig = require(join(root, "tailwind.config.js"));
const compiled = await postcss([
  tailwindcss({
    ...tailwindConfig,
    // The harness lives outside `src/`, so its own layout utilities have to be
    // part of the scan or the fixture grid would render unstyled.
    content: [join(root, "src/**/*.{js,jsx,ts,tsx}"), join(root, "qa/game-primitives-harness.tsx")],
  }),
  autoprefixer(),
]).process(globals, { from: join(root, "src/app/globals.css") });
writeFileSync(join(outDir, "app.css"), compiled.css);
console.log(`compiled stylesheet: ${(compiled.css.length / 1024).toFixed(0)}KB`);

writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Game primitives check</title>
<link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

const fileUrl = pathToFileURL(join(outDir, "index.html")).href;

// ── Reporting ─────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  if (ok) pass++;
  else fail++;
};

/** WCAG contrast from two computed `rgb()`/`rgba()` strings. */
const parseColour = (value) => {
  const m = String(value).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b] = m[1].split(/[,\s/]+/).filter(Boolean).slice(0, 3).map(Number);
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  return [r, g, b];
};
const luminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
};

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message)));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
if (TRACE) await page.context().tracing.start({ screenshots: true, snapshots: true });

await page.goto(fileUrl);
await page.waitForFunction(() => window.__gr?.ready === true, null, { timeout: 20000 });
await page.waitForTimeout(250);

/** Read a bundle of computed styles in one round trip. */
/**
 * Wait for every running CSS transition/animation to finish.
 *
 * The cells animate their colours on the token's duration (`transition-colors
 * duration-fast`), and headless Chromium only advances a transition when a frame
 * is produced — so a fixed sleep is both slower and racier than asking the DOM.
 */
const settle = () =>
  page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))).then(() => true),
  );

const probe = (selectors) =>
  page.evaluate((list) => {
    const read = (sel, pseudo) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el, pseudo);
      const box = el.getBoundingClientRect();
      return {
        background: cs.backgroundColor,
        borderColor: cs.borderColor,
        borderStyle: cs.borderStyle,
        borderWidth: cs.borderWidth,
        borderRadius: cs.borderTopLeftRadius,
        outlineColor: cs.outlineColor,
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        boxShadow: cs.boxShadow,
        color: cs.color,
        text: (el.textContent || "").trim(),
        tag: el.tagName,
        ariaLive: el.getAttribute("aria-live"),
        role: el.getAttribute("role"),
        ariaDisabled: el.getAttribute("aria-disabled"),
        nativeDisabled: el.hasAttribute("disabled"),
        width: Math.round(box.width * 10) / 10,
        height: Math.round(box.height * 10) / 10,
        top: Math.round(box.top * 10) / 10,
        tabIndex: el.tabIndex,
        backgroundImage: cs.backgroundImage === "none" ? "none" : "gradients",
      };
    };
    const out = {};
    for (const sel of list) out[sel] = read(sel);
    out["::legal-marker"] = read('[data-testid="cell-legal"]', "::after");
    out["::default-marker"] = read('[data-testid="cell-default"]', "::after");
    return out;
  }, selectors);

const CORE = [
  '[data-testid="frame-rounded"]',
  '[data-testid="frame-sharp"]',
  '[data-testid="frame-nine"]',
  '#root > main',
  '[data-testid="cell-default"]',
  '[data-testid="cell-occupied"]',
  '[data-testid="cell-legal"]',
  '[data-testid="cell-selected"]',
  '[data-testid="cell-disabled"]',
  '[data-testid="cell-touch"]',
  '[data-testid="cell-owner-1"]',
  '[data-testid="cell-owner-2"]',
  '[data-testid="cell-oblong"]',
  '[data-testid="cell-overhang"]',
  '[data-testid="overhang-label"]',
  '[data-testid="banner-yours"]',
  '[data-testid="banner-quiet"]',
  '[data-testid="banner-ended"]',
  '[data-testid="banner-dense"]',
];

const dark = await probe(CORE);

// ── 1. The tokens actually resolve ────────────────────────────────────────
check(
  "the raised-surface token reaches the frame (dark)",
  dark['[data-testid="frame-rounded"]']?.background === "rgb(4, 13, 36)",
  dark['[data-testid="frame-rounded"]']?.background,
);
check(
  "the recessed panel token reaches an empty cell",
  dark['[data-testid="cell-default"]']?.background === "rgb(0, 25, 51)",
  dark['[data-testid="cell-default"]']?.background,
);
check(
  "the frame carries real depth (token shadow, not none)",
  /rgba?\(3, 8, 23/.test(dark['[data-testid="frame-rounded"]']?.boxShadow ?? ""),
  dark['[data-testid="frame-rounded"]']?.boxShadow?.slice(0, 48),
);
check(
  "the board frame has the cell-radius family, not a fixed pixel box",
  dark['[data-testid="frame-rounded"]']?.borderRadius !== "0px",
  dark['[data-testid="frame-rounded"]']?.borderRadius,
);

// ── 2. Light mode follows the tokens with no component change ─────────────
// The theme flip is followed by `settle()`: a cell animates its colours, and
// reading mid-transition would capture an interpolated value (which is exactly
// what this check reported the first time it ran).
await page.evaluate(() => window.__gr.setTheme("light"));
await settle();
const light = await probe([
  '[data-testid="frame-rounded"]',
  '[data-testid="cell-default"]',
  '[data-testid="cell-legal"]',
  '#root > main',
]);
check(
  "light mode re-points the frame's ground (raised)",
  light['[data-testid="frame-rounded"]']?.background === "rgb(49, 80, 143)",
  light['[data-testid="frame-rounded"]']?.background,
);
check(
  "light mode re-points the cell's recessed panel",
  light['[data-testid="cell-default"]']?.background === "rgb(27, 50, 102)",
  light['[data-testid="cell-default"]']?.background,
);
await page.evaluate(() => window.__gr.setTheme("dark"));
await settle();
const backToDark = await probe(['[data-testid="frame-rounded"]', '[data-testid="cell-default"]']);
check(
  "and the theme flips back cleanly",
  backToDark['[data-testid="frame-rounded"]']?.background === "rgb(4, 13, 36)" &&
    backToDark['[data-testid="cell-default"]']?.background === "rgb(0, 25, 51)",
  `${backToDark['[data-testid="frame-rounded"]']?.background} / ${backToDark['[data-testid="cell-default"]']?.background}`,
);

// ── 3. The sharp HUD variant ──────────────────────────────────────────────
check(
  "the sharp frame keeps Four-In-A-Row's 3px corners",
  dark['[data-testid="frame-sharp"]']?.borderRadius === "3px",
  dark['[data-testid="frame-sharp"]']?.borderRadius,
);
check(
  "the sharp frame keeps the 1px cyan edge",
  /rgba?\(0, 229, 255/.test(dark['[data-testid="frame-sharp"]']?.borderColor ?? ""),
  dark['[data-testid="frame-sharp"]']?.borderColor,
);
check(
  "the sharp frame keeps its inset cyan haze",
  /rgba?\(0, 229, 255/.test(dark['[data-testid="frame-sharp"]']?.boxShadow ?? ""),
  dark['[data-testid="frame-sharp"]']?.boxShadow?.slice(0, 64),
);
const corners = await page.evaluate(() => {
  const el = document.querySelector('[data-gr-frame-accent="corners"]');
  return el ? getComputedStyle(el).backgroundImage !== "none" : false;
});
check("the HUD corner brackets paint (8 gradient arms)", corners === true);

// ── 4. Five distinct cell states ──────────────────────────────────────────
const stateTuples = ["default", "occupied", "legal", "selected", "disabled"].map((state) => {
  const s = dark[`[data-testid="cell-${state}"]`];
  return `${s.background}|${s.borderColor}|${s.borderStyle}|${s.outlineStyle}`;
});
check(
  "default / occupied / legal / selected / disabled all render differently",
  new Set(stateTuples).size === 5,
  `${new Set(stateTuples).size} distinct of 5`,
);
check(
  "the legal cell advertises itself with a dashed edge AND a marker",
  dark['[data-testid="cell-legal"]']?.borderStyle === "dashed",
  dark['[data-testid="cell-legal"]']?.borderStyle,
);
check(
  "the marker is drawn as a real pseudo-element (not a colour swap)",
  dark["::legal-marker"]?.borderWidth === "2px" &&
    dark["::default-marker"]?.borderWidth === "0px" &&
    dark["::legal-marker"]?.background !== "rgba(0, 0, 0, 0)",
  `legal w=${dark["::legal-marker"]?.borderWidth} bg=${dark["::legal-marker"]?.background} · default w=${dark["::default-marker"]?.borderWidth}`,
);
check(
  "selection uses the dashed brand-yellow outline (a shape, not just a hue)",
  parseColour(dark['[data-testid="cell-selected"]']?.outlineColor)?.[0] > 200 &&
    dark['[data-testid="cell-selected"]']?.outlineStyle === "dashed",
  `outline=${dark['[data-testid="cell-selected"]']?.outlineColor} ${dark['[data-testid="cell-selected"]']?.outlineStyle}`,
);

// ── 5. The legal marker survives BOTH themes ──────────────────────────────
const markerContrast = (cell, pseudo) => {
  const cellRgb = parseColour(cell?.background);
  const markerRgb = parseColour(pseudo?.borderColor);
  if (!cellRgb || !markerRgb) return null;
  return contrast(markerRgb, cellRgb);
};
const darkMarker = markerContrast(dark['[data-testid="cell-legal"]'], dark["::legal-marker"]);
const lightMarker = markerContrast(light['[data-testid="cell-legal"]'], dark["::legal-marker"]);
check(
  "the legal-move marker clears 3:1 on the dark board",
  darkMarker !== null && darkMarker >= 3,
  darkMarker === null ? "unmeasured" : `${darkMarker.toFixed(2)}:1`,
);
check(
  "…and clears 3:1 on the LIGHT board too",
  lightMarker !== null && lightMarker >= 3,
  lightMarker === null ? "unmeasured" : `${lightMarker.toFixed(2)}:1`,
);

// ── 6. Focus: a real ring, on a real button ───────────────────────────────
await page.evaluate(() => {
  document.body.setAttribute("tabindex", "-1");
  document.body.focus();
});
let focusedCell = null;
for (let i = 0; i < 30 && !focusedCell; i++) {
  await page.keyboard.press("Tab");
  focusedCell = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || !el.hasAttribute("data-gr-cell")) return null;
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName,
      testid: el.getAttribute("data-testid"),
      outlineWidth: cs.outlineWidth,
      outlineStyle: cs.outlineStyle,
      outlineColor: cs.outlineColor,
      focusVisible: el.matches(":focus-visible"),
    };
  });
}
check(
  "keyboard focus reaches a cell and draws the token's ring",
  focusedCell?.outlineStyle === "solid" &&
    focusedCell?.outlineWidth === "2px" &&
    focusedCell?.outlineColor === "rgb(157, 216, 255)",
  JSON.stringify(focusedCell),
);
check(
  "an offered cell is a real <button>",
  focusedCell?.tag === "BUTTON",
  focusedCell?.tag,
);

const blockedFocusable = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="cell-disabled"]');
  el.focus();
  return {
    focused: document.activeElement === el,
    ariaDisabled: el.getAttribute("aria-disabled"),
    nativeDisabled: el.hasAttribute("disabled"),
  };
});
check(
  "a disabled cell keeps aria-disabled and stays reachable by keyboard",
  blockedFocusable.ariaDisabled === "true" &&
    blockedFocusable.nativeDisabled === false &&
    blockedFocusable.focused === true,
  JSON.stringify(blockedFocusable),
);

// ── 7. Accessibility of the banner ────────────────────────────────────────
check(
  "the turn banner is a polite live region",
  dark['[data-testid="banner-yours"]']?.role === "status" &&
    dark['[data-testid="banner-yours"]']?.ariaLive === "polite",
  `${dark['[data-testid="banner-yours"]']?.role}/${dark['[data-testid="banner-yours"]']?.ariaLive}`,
);
check(
  "the silent banner has no live region at all",
  dark['[data-testid="banner-quiet"]']?.role === null &&
    dark['[data-testid="banner-quiet"]']?.ariaLive === null,
  `${dark['[data-testid="banner-quiet"]']?.role}/${dark['[data-testid="banner-quiet"]']?.ariaLive}`,
);
check(
  "an assertive banner is assertive",
  dark['[data-testid="banner-ended"]']?.ariaLive === "assertive",
  dark['[data-testid="banner-ended"]']?.ariaLive,
);
check(
  "the banner shows the app's own string, in the app's own words",
  dark['[data-testid="banner-yours"]']?.text.includes("Your move"),
  dark['[data-testid="banner-yours"]']?.text,
);

// ── 8. Ownership: colour AND shape ────────────────────────────────────────
const ownership = await page.evaluate(() => {
  const pip = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      radius: cs.borderTopLeftRadius,
      transform: cs.transform,
      background: cs.backgroundColor,
      inlineSize: cs.width,
    };
  };
  const piece = (sel) => {
    const el = document.querySelector(sel);
    return el
      ? { pip: el.querySelector("[data-gr-owner-pip]") ? true : false, width: Math.round(el.getBoundingClientRect().width) }
      : null;
  };
  return {
    pieceOne: pip('[data-testid="piece-disc-1"] [data-gr-owner-pip]'),
    pieceTwo: pip('[data-testid="piece-disc-2"] [data-gr-owner-pip]'),
    cellOne: pip('[data-testid="cell-owner-1"] [data-gr-owner-pip]'),
    cellTwo: pip('[data-testid="cell-owner-2"] [data-gr-owner-pip]'),
    neutral: piece('[data-testid="piece-neutral"]'),
    filled: piece('[data-testid="piece-fill"]'),
  };
});
check(
  "seat 1's pip is a CIRCLE and seat 2's is a DIAMOND",
  ownership.pieceOne?.transform === "none" &&
    /matrix\(0\.7071/.test(ownership.pieceTwo?.transform ?? "") &&
    ownership.pieceOne?.radius !== ownership.pieceTwo?.radius,
  `1=${ownership.pieceOne?.radius}/${ownership.pieceOne?.transform} 2=${ownership.pieceTwo?.radius}/${ownership.pieceTwo?.transform}`,
);
check(
  "the ownership pip is the outline colour, so it reads on either seat fill",
  ownership.cellOne?.background === "rgb(5, 16, 31)" &&
    ownership.cellTwo?.background === "rgb(5, 16, 31)",
  `${ownership.cellOne?.background} / ${ownership.cellTwo?.background}`,
);
check(
  "a neutral piece (a hazard, a wall) carries no owner pip",
  ownership.neutral?.pip === false,
  JSON.stringify(ownership.neutral),
);

// ── 9. Pieces: one outline weight, distinct silhouettes, three values ─────
const pieces = await page.evaluate(() => {
  const out = { paths: {}, strokes: {}, shapes: [] };
  for (const silhouette of ["disc", "tile", "diamond", "hex", "bar", "card", "spike", "glyph"]) {
    const el = document.querySelector(`[data-testid="piece-${silhouette}-1"]`);
    if (!el) continue;
    out.shapes.push(silhouette);
    // The outline path, not the depth path behind it.
    const path = el.querySelector("svg path[stroke]") ?? el.querySelector("svg path");
    out.paths[silhouette] = path ? path.getAttribute("d") : null;
    if (path) {
      const cs = getComputedStyle(path);
      out.strokes[silhouette] = {
        width: cs.strokeWidth,
        colour: cs.stroke,
        fill: cs.fill,
        vectorEffect: path.getAttribute("vector-effect"),
      };
    }
  }
  // The glyph fixture that actually receives caller art (piece-glyph), not the
  // bare one from the silhouette sweep (piece-glyph-1).
  const glyph = document.querySelector('[data-testid="piece-glyph"]');
  out.glyphOwnSilhouette = glyph ? glyph.querySelectorAll("svg path[stroke]").length : null;
  out.glyphChildren = glyph ? glyph.querySelectorAll("svg").length === 1 : null;
  return out;
});
const distinct = new Set(Object.values(pieces.paths).filter(Boolean));
check(
  "all eight silhouettes are present and seven of them are different shapes",
  Object.keys(pieces.paths).length === 8 && distinct.size === 7,
  `${Object.keys(pieces.paths).length} rendered, ${distinct.size} distinct paths`,
);
check(
  "every piece draws the SAME 2px outline at every size",
  Object.values(pieces.strokes).every((s) => s.width === "2px" && s.colour === "rgb(5, 16, 31)"),
  JSON.stringify(pieces.strokes.disc),
);
check(
  "the outline is scale-proof (non-scaling-stroke)",
  Object.values(pieces.strokes).every((s) => s.vectorEffect === "non-scaling-stroke"),
);
check(
  "a glyph piece draws no silhouette of its own — the game supplies the art",
  pieces.glyphOwnSilhouette === 0 && pieces.glyphChildren === true,
  `own silhouettes=${pieces.glyphOwnSilhouette}, caller art=${pieces.glyphChildren}`,
);
const shading = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="piece-disc-1"]');
  return [...el.querySelectorAll("path")].map((p) => getComputedStyle(p).fill);
});
check(
  "a piece is drawn with three values: fill, highlight and shade",
  new Set(shading).size >= 3,
  JSON.stringify(shading),
);

// ── 10. Touch target and the tight 9-column grid ──────────────────────────
check(
  "the opt-in touch target is a real 44px",
  (dark['[data-testid="cell-touch"]']?.height ?? 0) >= 44 &&
    (dark['[data-testid="cell-touch"]']?.width ?? 0) >= 44,
  `${dark['[data-testid="cell-touch"]']?.width}x${dark['[data-testid="cell-touch"]']?.height}`,
);
check(
  "a cell is square by default (a grid cell must not collapse to its border)",
  Math.abs(
    (dark['[data-testid="cell-default"]']?.height ?? 0) -
      (dark['[data-testid="cell-default"]']?.width ?? 0),
  ) <= 1,
  `${dark['[data-testid="cell-default"]']?.width}x${dark['[data-testid="cell-default"]']?.height}`,
);
check(
  "a game can opt out of the square ratio for an oblong cell",
  (dark['[data-testid="cell-oblong"]']?.height ?? 0) !==
    (dark['[data-testid="cell-oblong"]']?.width ?? 0),
  `${dark['[data-testid="cell-oblong"]']?.width}x${dark['[data-testid="cell-oblong"]']?.height}`,
);


// ── 11. No clipping: an overhanging label stays hit-testable ──────────────
const overhang = await page.evaluate(() => {
  const cell = document.querySelector('[data-testid="cell-overhang"]');
  const label = document.querySelector('[data-testid="overhang-label"]');
  if (!cell || !label) return null;
  const box = label.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  const cellBox = cell.getBoundingClientRect();
  const frame = document.querySelector('[data-testid="frame-rounded"]');
  return {
    hitIsLabel: hit === label || label.contains(hit),
    overhangs: box.top < cellBox.top,
    cellOverflow: getComputedStyle(cell).overflow,
    frameOverflow: getComputedStyle(frame).overflow,
  };
});
check(
  "a label that overhangs its cell is still painted and hit-testable",
  overhang?.overhangs === true && overhang?.hitIsLabel === true,
  JSON.stringify(overhang),
);
check(
  "neither the cell nor the frame clips its content",
  overhang?.cellOverflow === "visible" && overhang?.frameOverflow === "visible",
  `${overhang?.cellOverflow}/${overhang?.frameOverflow}`,
);

// ── 12. Reduced motion collapses the duration scale ──────────────────────
const duration = () =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--gr-duration-base").trim(),
  );
/** Flip the theme and report the transition durations the cell starts with. */
const flipAndReadTransitions = () =>
  page.evaluate(() => {
    const cell = document.querySelector('[data-testid="cell-default"]');
    window.__gr.setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
    return cell.getAnimations().map((a) => Number(a.effect?.getTiming?.().duration));
  });

await page.evaluate(() => window.__gr.setTheme("dark"));
await settle();
const normalDuration = await duration();
const normalTransitions = await flipAndReadTransitions();
await settle();
await page.emulateMedia({ reducedMotion: "reduce" });
const reducedDuration = await duration();
// …and the primitives inherit it: with the token at 0s a colour change runs no
// visible transition at all, with no per-game rule to remember. (Chromium still
// reports a 0.01ms placeholder, hence the sub-millisecond comparison.)
const reducedTransitions = await flipAndReadTransitions();
await page.emulateMedia({ reducedMotion: "no-preference" });
await page.evaluate(() => window.__gr.setTheme("dark"));
await settle();
check(
  "the motion scale starts at the token's real duration",
  normalDuration === "200ms",
  normalDuration,
);
check(
  "prefers-reduced-motion zeroes it for every adopter at once",
  reducedDuration === "0s",
  reducedDuration,
);
check(
  "a primitive's colour transition runs on the token's duration normally",
  normalTransitions.length > 0 && normalTransitions.every((d) => d >= 100 && d <= 150),
  `transitions: ${JSON.stringify(normalTransitions)}ms`,
);
check(
  "…and collapses to nothing under prefers-reduced-motion",
  reducedTransitions.length > 0 && reducedTransitions.every((d) => d < 1),
  `transitions: ${JSON.stringify(reducedTransitions)}ms`,
);

// ── 13. Responsive: no board pushes the page wider than the viewport ─────
for (const [width, height] of [
  [320, 720],
  [360, 780],
  [390, 844],
  [1280, 900],
]) {
  const context = await browser.newContext({ viewport: { width, height } });
  const vp = await context.newPage();
  await vp.goto(fileUrl);
  await vp.waitForSelector('[data-testid="frame-nine"]');
  await vp.waitForTimeout(150);
  const metrics = await vp.evaluate(() => {
    const frame = document.querySelector('[data-testid="frame-nine"]');
    const cell = document.querySelector('[data-testid="nine-cell-first"]');
    const frameBox = frame.getBoundingClientRect();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      frameWidth: Math.round(frameBox.width),
      frameRight: Math.round(frameBox.right),
      cellWidth: Math.round(cell.getBoundingClientRect().width),
      cellHeight: Math.round(cell.getBoundingClientRect().height),
    };
  });
  check(
    `${width}px: the 9-column board fits the viewport with no horizontal scroll`,
    metrics.scrollWidth <= metrics.innerWidth + 1 && metrics.frameRight <= metrics.innerWidth + 1,
    JSON.stringify(metrics),
  );
  check(
    `${width}px: its cells stay square and usable`,
    metrics.cellWidth >= 20 && Math.abs(metrics.cellWidth - metrics.cellHeight) <= 1,
    `${metrics.cellWidth}x${metrics.cellHeight}`,
  );
  if (width === 320) {
    check(
      "320px: the 44px touch floor stays OPT-IN (a 9-column cell is left at its own size)",
      metrics.cellWidth < 44,
      `${metrics.cellWidth}px cell in a 9-column board`,
    );
  }
  if (width === 390) await vp.screenshot({ path: join(REPORTS, "game-primitives-390.png") });
  await context.close();
}

// ── 14. Nothing threw ───────────────────────────────────────────────────
const structural = (errors) =>
  errors.filter((e) =>
    /validateDOMNesting|descendant of|hydration|Cannot read|Cannot update|is not a function|unique "key"/i.test(e),
  );
check(
  "no page or React structural errors",
  pageErrors.length === 0 && structural(consoleErrors).length === 0,
  JSON.stringify([...pageErrors, ...structural(consoleErrors)].slice(0, 3)),
);

await page.screenshot({ path: join(REPORTS, "game-primitives-kitchen-sink.png"), fullPage: true });
if (TRACE) {
  await page.context().tracing.stop({ path: join(REPORTS, "game-primitives-trace.zip") });
}
await browser.close();

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`screenshots: qa/reports/game-primitives-*.png`);
if (fail > 0) process.exitCode = 1;
