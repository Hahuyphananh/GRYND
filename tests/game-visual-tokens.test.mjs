/**
 * game-visual-tokens.test.mjs
 *
 * The game-visual token layer, pinned at the source level.
 *
 * Phase 1 of the cartoon-2D game redesign added ONE additive block to
 * src/app/globals.css (marked "GRYND GAME VISUAL TOKENS") and the Tailwind
 * names for it. The whole point of that layer is that a colour, a seat or a
 * duration is decided in exactly one place, so this suite guards the things
 * that would silently break that promise:
 *
 *   * every `--gr-*` property Tailwind or the primitives reference EXISTS,
 *   * the two seat colours are not just different hues — seat 2 carries a
 *     shape cue, because under simulated deuteranopia the two fills are close,
 *   * the legibility numbers the block claims (AA for seat ink on the dark
 *     ground, 3:1 for outlines and state cues) still hold, in BOTH themes,
 *   * the block is additive: every class it introduces is `gr-`-prefixed and
 *     therefore cannot restyle a game that ships today,
 *   * light mode re-points ONLY the three grounds, matching the rule the
 *     light-theme generator states, and re-points them to the generator's own
 *     values (no second copy of the light palette), and
 *   * reduced motion zeroes the duration scale at the token.
 *
 * Run:  node --test tests/game-visual-tokens.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const GLOBALS = read("src/app/globals.css");
const THEME_CSS = read("src/app/light-theme.css");
const TAILWIND = read("tailwind.config.js");
const GENERATOR = read("scripts/generate-light-theme.mjs");

// ── The token block, and only the token block ──────────────────────────────

const MARKER = "GRYND GAME VISUAL TOKENS";
const start = GLOBALS.indexOf(MARKER);
assert.ok(start > 0, "globals.css must still carry the GRYND GAME VISUAL TOKENS block");
const BLOCK = GLOBALS.slice(GLOBALS.lastIndexOf("/*", start));

/** The dark-first declarations, i.e. the `:root { … }` block. */
const ROOT = BLOCK.match(/:root \{([\s\S]*?)\n\}/)?.[1] ?? "";
assert.ok(ROOT.length > 0, "the token block must declare a :root { … } of defaults");

/** Declarations, with any trailing CSS comment stripped off the value. */
const declarationsIn = (css) =>
  [...css.matchAll(/^\s*(--gr-[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [
    m[1],
    m[2].replace(/\/\*[\s\S]*?\*\//g, "").trim(),
  ]);

const declared = new Map(declarationsIn(ROOT));

// ── Colour maths (WCAG, as used by the light-theme generator) ──────────────

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
const contrast = (a, b) => {
  const [hi, lo] = luminance(a) > luminance(b) ? [luminance(a), luminance(b)] : [luminance(b), luminance(a)];
  return (hi + 0.05) / (lo + 0.05);
};

/** Simulated deuteranopia, for the "colour is never the only cue" claim. */
const DEUT = [
  [0.367, 0.861, -0.228],
  [0.28, 0.673, 0.047],
  [-0.012, 0.043, 0.969],
];
const simulateDeut = (hex) => {
  const rgb = toRgb(hex).map((v) => v / 255);
  return DEUT.map((row) => row.reduce((sum, k, i) => sum + k * rgb[i], 0)).map((v) => Math.min(1, Math.max(0, v)) * 255);
};
const distance = (a, b) => Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0));

/** The light grounds, read from the generator — never re-typed here. */
const genConst = (name) => GENERATOR.match(new RegExp(`const ${name} = "(#[0-9a-f]{6})"`))?.[1];

// ── 1. Coverage ────────────────────────────────────────────────────────────

test("the required tokens are all declared", () => {
  const required = [
    // brand
    "--gr-brand-cyan",
    "--gr-brand-yellow",
    // neutral surfaces
    "--gr-surface-page",
    "--gr-surface-raised",
    "--gr-surface-panel",
    // text
    "--gr-ink",
    "--gr-ink-muted",
    "--gr-ink-subtle",
    "--gr-ink-on-accent",
    // borders and outlines
    "--gr-hairline",
    "--gr-border",
    "--gr-border-strong",
    "--gr-outline",
    "--gr-outline-width",
    // seats
    "--gr-player-1",
    "--gr-player-2",
    "--gr-seat-neutral",
    "--gr-seat-1-shape",
    "--gr-seat-2-shape",
    // states
    "--gr-selected",
    "--gr-legal-move",
    "--gr-focus-ring",
    "--gr-focus-ring-width",
    "--gr-disabled-ink",
    "--gr-disabled-surface",
    // board cells and pieces
    "--gr-cell-radius",
    "--gr-cell-gap",
    "--gr-piece-radius",
    "--gr-piece-shadow",
    "--gr-piece-highlight",
    "--gr-piece-shade",
    // motion
    "--gr-duration-fast",
    "--gr-duration-base",
    "--gr-duration-slow",
    "--gr-ease-standard",
  ];
  for (const token of required) {
    assert.ok(declared.has(token), `${token} is missing from the token block`);
    assert.ok(declared.get(token).length > 0, `${token} is declared empty`);
  }
});

test("every Tailwind mapping resolves to a declared token", () => {
  const referenced = new Set(
    [...TAILWIND.matchAll(/var\((--gr-[a-z0-9-]+)\)/g)].map((m) => m[1]),
  );
  assert.ok(referenced.size > 0, "tailwind.config.js must reference the tokens, not copy their values");
  for (const token of referenced) {
    assert.ok(declared.has(token), `tailwind.config.js references ${token}, which globals.css does not declare`);
  }
  assert.ok(
    !/--gr-[a-z0-9-]+:(?!\s)/.test(TAILWIND),
    "tailwind.config.js must not declare token values of its own",
  );
});

test("hex colours are opacity-capable; pre-composited ones are left alone", () => {
  const colourTokens = [...declared].filter(([, value]) => /^#[0-9a-f]{6}$/.test(value) || /^rgba?\(/.test(value));
  assert.ok(colourTokens.length >= 15, "expected the colour tokens to be discoverable");
  for (const [name, value] of colourTokens) {
    if (/^#[0-9a-f]{6}$/.test(value)) {
      assert.equal(
        declared.get(`${name}-rgb`),
        toRgb(value).join(" "),
        `${name} is a hex colour, so it needs ${name}-rgb: ${toRgb(value).join(" ")}`,
      );
    } else {
      assert.equal(
        declared.get(`${name}-rgb`),
        undefined,
        `${name} is already semi-transparent — an -rgb triplet would drop its alpha`,
      );
    }
  }
});

test("no Tailwind colour maps a hex through a plain var()", () => {
  // `text-ink/70` on a plain `var(--gr-ink)` emits NO CSS at all — Tailwind
  // cannot decompose an opaque custom property. Only the pre-composited
  // (rgba) tokens may be mapped that way.
  const colours = TAILWIND.slice(TAILWIND.indexOf("colors: {"), TAILWIND.indexOf("borderRadius: {"));
  assert.ok(colours.includes("colors: {"), "tailwind.config.js must still carry the colour mappings");
  // (A `-rgb` reference inside `rgb(var(--x-rgb) / <alpha-value>)` is the
  // correct form and is checked by the triplet test instead.)
  const plain = [...colours.matchAll(/var\((--gr-[a-z0-9-]+)\)/g)]
    .map((m) => m[1])
    .filter((name) => !name.endsWith("-rgb"));
  assert.ok(plain.length > 0, "expected the pre-composited ink tokens to be mapped as plain vars");
  for (const ref of new Set(plain)) {
    assert.match(
      declared.get(ref) ?? "",
      /^rgba?\(/,
      `${ref} is mapped as a plain var(); a hex there would silently drop every opacity modifier`,
    );
  }
});

test("opacity-capable token colours carry a matching rgb triplet", () => {
  // `rgb(var(--x-rgb) / <alpha-value>)` needs a SPACE-separated triple; a
  // comma-separated one renders an invalid rgb(0, 229, 255 / 0.4).
  const pairs = [...TAILWIND.matchAll(/var\((--gr-[a-z0-9-]+)-rgb\)/g)].map((m) => m[1]);
  assert.ok(pairs.length >= 5, "the surfaces, seats and brand colours must expose rgb triplets");
  for (const base of new Set(pairs)) {
    const hex = declared.get(base);
    const triplet = declared.get(`${base}-rgb`);
    assert.match(hex ?? "", /^#[0-9a-f]{6}$/, `${base} must be a plain hex`);
    assert.equal(triplet, toRgb(hex).join(" "), `${base}-rgb must be the space-separated rgb of ${hex}`);
  }
});

// ── 2. Seats: colour AND shape ─────────────────────────────────────────────

test("the two seats use colours GRYND already ships", () => {
  // Cyan is the app's own "you" colour (~1000 uses) and magenta is the
  // opponent family it already draws most often — neither is a new colour.
  assert.equal(declared.get("--gr-player-1"), "#00e5ff");
  assert.equal(declared.get("--gr-player-2"), "#ff4fd8");
  assert.notEqual(declared.get("--gr-player-1"), declared.get("--gr-player-2"));
});

test("the seats are told apart by SHAPE, not hue alone", () => {
  assert.notEqual(
    declared.get("--gr-seat-1-shape"),
    declared.get("--gr-seat-2-shape"),
    "the two seats must carry different shape cues",
  );
  // The shape tokens must actually be used, or they are decoration: seat 2's
  // pip must be reshaped (and rotated into a diamond) by the stylesheet.
  assert.match(
    BLOCK,
    /\.gr-seat--2 \.gr-seat-pip[\s\S]{0,120}?border-radius:\s*\d+%/,
    "seat 2's pip must be reshaped into a diamond",
  );
  assert.match(BLOCK, /\.gr-seat--2 \.gr-seat-pip[\s\S]{0,120}?rotate\(45deg\)/);
  // …and the reason it is mandatory, pinned so a future palette tweak cannot
  // quietly remove the reason: in deuteranopia the two fills are close.
  const sep = distance(simulateDeut(declared.get("--gr-player-1")), simulateDeut(declared.get("--gr-player-2")));
  assert.ok(sep < 160, `the seats now separate at ${sep.toFixed(0)} under deuteranopia — re-check whether the shape cue is still load-bearing`);
});

test("seat ink clears AA on the dark ground, and outlines keep every piece readable", () => {
  const raised = declared.get("--gr-surface-raised");
  const outline = declared.get("--gr-outline");
  for (const seat of ["--gr-player-1", "--gr-player-2"]) {
    const ink = declared.get(seat);
    assert.ok(
      contrast(ink, raised) >= 4.5,
      `${seat} ${ink} on the raised ground ${raised} must clear AA (got ${contrast(ink, raised).toFixed(2)})`,
    );
    // The outline is the theme-independent edge: the light grounds are still
    // deep blues, so a piece must read by its outline against its own fill.
    assert.ok(
      contrast(outline, ink) >= 3,
      `the outline ${outline} must read against ${seat} ${ink} (got ${contrast(outline, ink).toFixed(2)})`,
    );
  }
});

// ── 3. State cues read in BOTH themes ──────────────────────────────────────

test("selection, legal-move and focus cues clear 3:1 on both themes' grounds", () => {
  const darkGrounds = ["--gr-surface-page", "--gr-surface-raised", "--gr-surface-panel"].map((t) => declared.get(t));
  const lightGrounds = [genConst("PAGE"), genConst("CARD"), genConst("PANEL")];
  for (const token of ["--gr-legal-move", "--gr-focus-ring", "--gr-selected"]) {
    const value = declared.get(token);
    assert.match(value, /^#[0-9a-f]{6}$/, `${token} must be a plain hex if it is checked against both grounds`);
    for (const ground of [...darkGrounds, ...lightGrounds]) {
      assert.match(ground, /^#[0-9a-f]{6}$/, "the grounds must be comparable hexes");
      const ratio = contrast(value, ground);
      assert.ok(ratio >= 3, `${token} ${value} on ${ground} is only ${ratio.toFixed(2)}:1 — state cues need 3:1`);
    }
  }
});

test("the disabled treatment is dimmer than the muted ink it replaces", () => {
  assert.ok(
    luminance(declared.get("--gr-disabled-ink")) < luminance(declared.get("--gr-ink")),
    "disabled ink must be dimmer than primary ink, or the state reads as enabled",
  );
  assert.ok(
    luminance(declared.get("--gr-disabled-ink")) < luminance(declared.get("--gr-legal-move")),
    "a disabled control must not out-shine a legal-move cue",
  );
});

// ── 4. Additive: nothing here can restyle a shipped game ───────────────────

test("every class the block introduces is gr- prefixed", () => {
  const rules = BLOCK.replace(/\/\*[\s\S]*?\*\//g, ""); // comments carry braces-adjacent prose
  const selectors = [...rules.matchAll(/(?:^|\}|\n)\s*([^@{}\n][^{}]*?)\s*\{/g)].map((m) => m[1].trim());
  assert.ok(selectors.length >= 8, "expected the block's primitives to be discoverable");
  for (const selector of selectors) {
    if (selector === ":root" || selector.startsWith("@")) continue;
    for (const part of selector.split(",")) {
      const one = part.trim();
      assert.ok(
        one.startsWith(".gr-"),
        `"${one}" is not gr- prefixed — phase 1 must not restyle an existing game class`,
      );
    }
  }
});

test("the token layer does not size boards", () => {
  // Board geometry is load-bearing per game (clamp() rules guarded by the
  // board-fit and mobile-audit harnesses), so the shared layer must not carry
  // a cell size for a game to accidentally adopt.
  assert.equal(declared.get("--gr-cell-size"), undefined, "a shared cell size would fight the per-game board-fit rules");
  assert.ok(!/--gr-(cell|board)-(width|height|size)/.test(ROOT));
});

// ── 5. Light mode moves the grounds, and only the grounds ──────────────────

test("light mode re-points the three grounds and nothing else", () => {
  const rules = [...THEME_CSS.matchAll(/html\[data-theme="light"\] \{\n([\s\S]*?)\n\}/g)].map((m) => m[1]);
  const tokenRule = rules.find((r) => r.includes("--gr-surface-page"));
  assert.ok(tokenRule, "light-theme.css must re-point the surface tokens");

  const overrides = declarationsIn(tokenRule);
  assert.deepEqual(
    overrides.map(([name]) => name).sort(),
    [
      "--gr-surface-page",
      "--gr-surface-page-rgb",
      "--gr-surface-panel",
      "--gr-surface-panel-rgb",
      "--gr-surface-raised",
      "--gr-surface-raised-rgb",
    ],
    "light mode may only move the grounds — brand, seat, state and motion tokens stay as authored",
  );

  const map = new Map(overrides);
  assert.equal(map.get("--gr-surface-page"), genConst("PAGE"));
  assert.equal(map.get("--gr-surface-raised"), genConst("CARD"));
  assert.equal(map.get("--gr-surface-panel"), genConst("PANEL"));
  for (const [hexToken, genName] of [["--gr-surface-page", "PAGE"], ["--gr-surface-raised", "CARD"], ["--gr-surface-panel", "PANEL"]]) {
    const hex = map.get(hexToken);
    assert.equal(
      map.get(`${hexToken}-rgb`),
      toRgb(genConst(genName)).join(" "),
      `${hexToken}-rgb must be the space-separated rgb of the generator's ${genName} (${hex})`,
    );
  }
});

test("the token block and the light theme cannot drift apart by load order", () => {
  // light-theme.css is imported at the top of globals.css, so the token block
  // is parsed LAST. The light overrides win on SPECIFICITY (0,1,1 vs 0,1,0) —
  // this asserts the selector that supplies that, not just the rule's values.
  assert.match(THEME_CSS, /html\[data-theme="light"\] \{\n\s+--gr-surface-page:/);
  assert.match(GLOBALS, /@import "\.\/light-theme\.css"/);
});

// ── 6. Motion ──────────────────────────────────────────────────────────────

test("reduced motion zeroes the whole duration scale", () => {
  const reduced = BLOCK.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.ok(reduced, "the block must carry its own reduced-motion rule");
  for (const token of ["--gr-duration-fast", "--gr-duration-base", "--gr-duration-slow"]) {
    assert.match(declared.get(token), /^\d+m?s$/, `${token} must be a real duration by default`);
    assert.match(
      reduced,
      new RegExp(`${token}:\\s*0s;`),
      `${token} must be zeroed under prefers-reduced-motion`,
    );
  }
});
