/**
 * light-theme-palette.test.mjs
 *
 * The LIGHT ground palette, pinned at the source level.
 *
 * light-theme.css is generated from scripts/generate-light-theme.mjs, and the
 * page ground is ALSO baked into two runtime copies (the pre-paint bootstrap in
 * layout.tsx and the theme-color in ThemeContext.js) because neither can import
 * the build-time generator. Four copies of one colour is exactly the drift the
 * generator's header warns about, so this suite pins them together.
 *
 * It also encodes the DESIGN requirement, not just the equality. Light mode is
 * NOT a white theme: it uses the dark theme's own blue (the 223° hue of
 * `bg-[#040d24]`) lifted to a deep, saturated blue, and keeps the dark theme's
 * light type on it. So the grounds must be
 *
 *   * blue-dominant and within 10° of the dark ground's hue (the same blue),
 *   * LIGHTER than the dark ground (lifted — it is a different theme),
 *   * still clearly DEEP (relative luminance under 0.20 — not white), and
 *   * readable by the light ink at AA.
 *
 * The previous palette shipped #c9d5f2/#dde4f5 at 0.66/0.78 luminance, which
 * read as white; the ceilings here keep that from coming back.
 *
 * Run:  node --import tsx --test tests/light-theme-palette.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const GENERATOR = read("scripts/generate-light-theme.mjs");
const THEME_CSS = read("src/app/light-theme.css");
const LAYOUT = read("src/app/layout.tsx");
const CONTEXT = read("src/context/ThemeContext.js");

// ── Colour maths (mirrors the generator's own helpers) ─────────────────────

const toRgb = (hex) => {
  const s = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const channel = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const [r, g, b] = toRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
function hue(hex) {
  const [r, g, b] = toRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * (2 + (b - r) / d) : 60 * (4 + (r - g) / d);
  return h < 0 ? h + 360 : h;
}
const contrast = (a, b) => {
  const [hi, lo] = luminance(a) > luminance(b) ? [luminance(a), luminance(b)] : [luminance(b), luminance(a)];
  return (hi + 0.05) / (lo + 0.05);
};

// ── The ground the dark theme is built on ──────────────────────────────────

const DARK_GROUND = "#040d24";

// ── The four copies ────────────────────────────────────────────────────────

const genConst = (name) => GENERATOR.match(new RegExp(`const ${name} = "(#[0-9a-f]{6})"`))?.[1];
const PAGE = genConst("PAGE");
const CARD = genConst("CARD");
const PANEL = genConst("PANEL");

test("the generator still declares the three grounds as plain hexes", () => {
  for (const [name, v] of [["PAGE", PAGE], ["CARD", CARD], ["PANEL", PANEL]]) {
    assert.match(v ?? "", /^#[0-9a-f]{6}$/, `${name} must be a hex constant`);
  }
});

test("one page ground, four copies — they cannot drift", () => {
  const bootstrap = LAYOUT.match(/const THEME_LIGHT_GROUND = "(#[0-9a-f]{6})"/)?.[1];
  const meta = CONTEXT.match(/META_COLOR = \{ dark: "#[0-9a-f]{6}", light: "(#[0-9a-f]{6})" \}/)?.[1];
  // The generated stylesheet's own `html[data-theme="light"]` rule.
  const css = THEME_CSS.match(/html\[data-theme="light"\] \{\n\s+color-scheme: light;\n\s+background-color: (#[0-9a-f]{6});/)?.[1];

  assert.equal(bootstrap, PAGE, "layout.tsx's bootstrap ground must equal the generator's PAGE");
  assert.equal(meta, PAGE, "ThemeContext's light theme-color must equal the generator's PAGE");
  assert.equal(css, PAGE, "the generated css ground must equal the generator's PAGE");
});

// ── The design requirement ─────────────────────────────────────────────────

test("the grounds are the DARK theme's blue, on the same hue", () => {
  for (const [name, v] of [["PAGE", PAGE], ["CARD", CARD], ["PANEL", PANEL]]) {
    const [r, , b] = toRgb(v);
    assert.ok(b > r, `${name} ${v} must stay BLUE-dominant, not neutral grey`);
    const delta = Math.abs(hue(v) - hue(DARK_GROUND));
    assert.ok(
      delta <= 10,
      `${name} ${v} hue ${hue(v).toFixed(1)} must sit within 10° of the dark ground's ${hue(DARK_GROUND).toFixed(1)}`,
    );
  }
});

test("the grounds are LIFTED off the dark theme, not a copy of it", () => {
  for (const [name, v] of [["PAGE", PAGE], ["CARD", CARD], ["PANEL", PANEL]]) {
    assert.ok(
      luminance(v) > luminance(DARK_GROUND) * 2,
      `${name} ${v} must be a visible step above the dark ground ${DARK_GROUND}`,
    );
  }
});

test("no light ground is white — they stay deep blue", () => {
  // #c9d5f2 / #dde4f5 (the previous, rejected palette) measured 0.66 / 0.78 and
  // read as white. The ceiling keeps a full-bleed card deep blue.
  const CEILING = 0.2;
  for (const [name, v] of [["PAGE", PAGE], ["CARD", CARD], ["PANEL", PANEL]]) {
    assert.ok(
      luminance(v) < CEILING,
      `${name} ${v} has relative luminance ${luminance(v).toFixed(3)} — too light, it will read as white`,
    );
  }
});

test("the grounds are ordered panel < page < card (elevation still reads)", () => {
  assert.ok(luminance(CARD) > luminance(PAGE), "the raised surface stays lighter than the page");
  assert.ok(luminance(PANEL) < luminance(PAGE), "the recessed panel stays darker than the page");
});

test("the light ink still clears AA on every ground", () => {
  const INK = GENERATOR.match(/const INK = "(#[0-9a-f]{6})"/)?.[1];
  assert.ok(luminance(INK) > 0.5, "light mode's ink must be LIGHT (the ground is dark)");
  for (const [name, v] of [["PAGE", PAGE], ["CARD", CARD], ["PANEL", PANEL]]) {
    assert.ok(
      contrast(INK, v) >= 4.5,
      `ink ${INK} on ${name} ${v} must clear AA (got ${contrast(INK, v).toFixed(2)})`,
    );
  }
});

test("light mode does not invert text or hairlines", () => {
  // The generated stylesheet must contain NO rule that repaints `text-white`
  // or `border-white/10` — those belong to the dark theme and still read on the
  // lifted blue ground. A rule for them is the regression this guards.
  assert.ok(
    !/html\[data-theme="light"\] \.text-white\b/.test(THEME_CSS),
    "text-white must not be remapped — light mode keeps the dark theme's light type",
  );
  assert.ok(
    !/html\[data-theme="light"\] \.border-white\\\/10\b/.test(THEME_CSS),
    "border-white/10 must not be remapped",
  );
});
