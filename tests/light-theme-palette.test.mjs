/**
 * light-theme-palette.test.mjs
 *
 * The LIGHT ground palette, pinned at the source level.
 *
 * Light mode is no longer a generated utility-remap sheet: the grounds are
 * semantic tokens (`--bg-page/surface/panel`) aliased to `--gr-surface-*`, and
 * `html[data-theme="light"]` re-points those three tokens. The page ground is
 * ALSO baked into two runtime copies (the pre-paint bootstrap in layout.tsx and
 * the theme-color in ThemeContext.js), so this suite pins all copies together.
 *
 * It encodes the DESIGN requirement, not just equality: light mode is NOT a
 * white theme. It uses the dark theme's own blue (223°) lifted to a deep,
 * saturated blue, and keeps the dark theme's light type on it. The grounds must
 * be blue-dominant and within 10° of the dark ground's hue, lighter than the
 * dark ground, still deep (luminance under 0.20), and AA-legible under the ink.
 *
 * Run:  node --import tsx --test tests/light-theme-palette.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const GLOBALS = read("src/app/globals.css");
const LAYOUT = read("src/app/layout.tsx");
const CONTEXT = read("src/context/ThemeContext.js");

// ── Colour maths ───────────────────────────────────────────────────────────

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

const DARK_GROUND = "#040d24";

/** The `html[data-theme="light"]` block in globals.css. */
const LIGHT_BLOCK = GLOBALS.match(/html\[data-theme="light"\] \{([\s\S]*?)\n\}/)?.[1] ?? "";
const token = (name) => LIGHT_BLOCK.match(new RegExp(`${name}: (#[0-9a-f]{6});`))?.[1];
const PAGE = token("--gr-surface-page");
const CARD = token("--gr-surface-raised");
const PANEL = token("--gr-surface-panel");

test("light mode is a token override in globals.css, not a generated sheet", () => {
  assert.ok(!GLOBALS.includes("light-theme.css"), "the generated remap sheet must be retired");
  assert.ok(!fs.existsSync("src/app/light-theme.css"), "light-theme.css must not exist");
  for (const [name, v] of [["PAGE", PAGE], ["CARD", CARD], ["PANEL", PANEL]]) {
    assert.match(v ?? "", /^#[0-9a-f]{6}$/, `${name} must be a hex token in the light block`);
  }
});

test("one page ground, four copies — they cannot drift", () => {
  const bootstrap = LAYOUT.match(/const THEME_LIGHT_GROUND = "(#[0-9a-f]{6})"/)?.[1];
  const meta = CONTEXT.match(/META_COLOR = \{ dark: "#[0-9a-f]{6}", light: "(#[0-9a-f]{6})" \}/)?.[1];

  assert.equal(bootstrap, PAGE, "layout.tsx's bootstrap ground must equal the light page token");
  assert.equal(meta, PAGE, "ThemeContext's light theme-color must equal the light page token");
});

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
  const INK = GLOBALS.match(/--gr-ink: (#[0-9a-f]{6})/)?.[1];
  assert.ok(INK, "the ink token must be declared");
  assert.ok(luminance(INK) > 0.5, "light mode's ink must be LIGHT (the ground is dark)");
  for (const [name, v] of [["PAGE", PAGE], ["CARD", CARD], ["PANEL", PANEL]]) {
    assert.ok(
      contrast(INK, v) >= 4.5,
      `ink ${INK} on ${name} ${v} must clear AA (got ${contrast(INK, v).toFixed(2)})`,
    );
  }
});

test("light mode does not repaint text or hairlines", () => {
  assert.ok(
    !/\.text-white\b/.test(LIGHT_BLOCK),
    "text-white must not be remapped — light mode keeps the dark theme's light type",
  );
  assert.ok(
    !/\.border-white/.test(LIGHT_BLOCK),
    "border-white/10 must not be remapped",
  );
});
