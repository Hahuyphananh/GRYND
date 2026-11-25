/**
 * home-polish.test.mjs
 *
 * Pins the small, self-contained home-page polish:
 *
 *   1. The page has a decorative grainy brand gradient (tokens, no hard-coded
 *      colours) that cannot intercept clicks and stops drifting under reduced
 *      motion. It spans the whole page, so it never paints a bounded rectangle
 *      behind the hero.
 *   2. The hero headline/subhead are in the DOM and only animate with CSS.
 *   3. The three "fair by construction" cards use the cursor spotlight, which
 *      is mouse-only and painted from CSS variables.
 *
 * Run: npm run test:home-polish
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const HOME = "src/app/PageClient.jsx";
const BACKDROP = "src/components/home/HeroBackdrop.tsx";
const BACKDROP_CSS = "src/components/home/HeroBackdrop.module.css";
const COPY_CSS = "src/components/home/HeroCopy.module.css";
const SPOTLIGHT = "src/components/ui/SpotlightCard.tsx";
const SPOTLIGHT_CSS = "src/components/ui/SpotlightCard.module.css";

test("the page backdrop is decorative, token-driven and reduced-motion safe", () => {
  const component = read(BACKDROP);
  const css = read(BACKDROP_CSS);
  const home = read(HOME);

  assert.match(component, /aria-hidden="true"/);
  assert.match(css, /feTurbulence/);
  assert.match(css, /var\(--gr-brand-cyan\)/);
  assert.match(css, /var\(--gr-brand-yellow\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);

  // No hard-coded palette in the new decorative layer.
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
  assert.doesNotMatch(css, /rgba?\(/i);

  // The page root isolates the layer, so it paints above the page background
  // but behind the content — page-wide, not clipped to a section rectangle.
  assert.match(home, /<HeroBackdrop \/>/);
  assert.match(home, /relative isolate min-h-dvh/);
  assert.match(home, /relative z-10 grid/);
  assert.doesNotMatch(home, /<section className="relative isolate overflow-hidden/);
  assert.doesNotMatch(home, /border-b border-\[color:var\(--border-hairline\)\]/);
});

test("the hero copy reveals with CSS and keeps its text in the DOM", () => {
  const home = read(HOME);
  const css = read(COPY_CSS);

  assert.match(home, /heroCopy\.reveal\b/);
  assert.match(home, /heroCopy\.revealSoft/);
  assert.match(home, /The competitive home/);
  assert.match(css, /filter: blur\(9px\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test("the feature cards use the mouse-only cursor spotlight", () => {
  const home = read(HOME);
  const card = read(SPOTLIGHT);
  const css = read(SPOTLIGHT_CSS);

  assert.match(home, /<SpotlightCard key=\{feature\.title\}>/);
  assert.equal((home.match(/<SpotlightCard/g) || []).length, 1);

  assert.match(card, /event\.pointerType !== "mouse"/);
  assert.match(card, /--spot-x/);
  assert.match(card, /--spot-y/);
  assert.match(card, /aria-hidden="true"/);

  assert.match(css, /var\(--accent\)/);
  assert.match(css, /var\(--spot-x/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
});
