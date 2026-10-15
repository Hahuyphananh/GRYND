/**
 * route-transition-visibility.test.mjs
 *
 * The shared page wrapper must never be able to hide a page. It used to be a
 * keyed framer-motion child inside `<AnimatePresence mode="wait">`, and when
 * Next's navigation interleaved with the exit/enter hand-off the wrapper was
 * left on its `initial` opacity for good — Pool Masters, Precision and the
 * Chess "created, waiting for opponent" page rendered a complete waiting room
 * in the DOM that painted nothing until the player refreshed. Measured on the
 * create journey: 7/8, 8/8 and 7/9 attempts respectively
 * (docs/route-transition-blank-page.md).
 *
 * These are wiring-level assertions, which is this repo's convention for page
 * contracts; the behavioural half of the guard is the browser check
 * `node qa/games-blank-audit.mjs --create-only`, which fails when any create
 * journey leaves a page invisible.
 *
 * Assertions run against the files with their comments stripped: the comment
 * above documents the old markup, and prose must neither satisfy nor trip a
 * guard about what the code does.
 *
 * Run:  node --import tsx --test tests/route-transition-visibility.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const WRAPPER = "src/components/RouteTransition.jsx";
const CSS = "src/app/globals.css";
const PROVIDERS = "src/app/providers.tsx";

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const wrapper = stripComments(fs.readFileSync(WRAPPER, "utf8"));
const css = stripComments(fs.readFileSync(CSS, "utf8"));
const providers = stripComments(fs.readFileSync(PROVIDERS, "utf8"));

// Pull a CSS rule's declarations by selector.
const ruleOf = (selector) => {
  const at = css.indexOf(selector);
  assert.ok(at !== -1, `${selector} must exist in ${CSS}`);
  return css.slice(at, css.indexOf("}", at));
};

test("the shared wrapper never drives page visibility from a JS animation", () => {
  // The whole failure mode: an `initial` opacity that only a completed enter
  // animation clears. Any of these coming back reintroduces it.
  assert.doesNotMatch(
    wrapper,
    /AnimatePresence/,
    `${WRAPPER} must not gate the page on an AnimatePresence hand-off`,
  );
  assert.doesNotMatch(
    wrapper,
    /initial=/,
    `${WRAPPER} must not carry an initial opacity the page can be left on`,
  );
  assert.doesNotMatch(
    wrapper,
    /from "framer-motion"/,
    `${WRAPPER} must not depend on framer-motion for page visibility`,
  );
});

test("the fade class has no opacity-0 resting state", () => {
  assert.match(css, /@keyframes routeFadeIn\s*\{/);
  assert.match(css, /\.route-fade-in\s*\{\s*animation: routeFadeIn/);
  assert.doesNotMatch(
    ruleOf(".route-fade-in"),
    /opacity:\s*0/,
    "a base opacity of 0 on the page wrapper is the bug being fixed",
  );
  const keyframes = css.slice(css.indexOf("@keyframes routeFadeIn"));
  const endState = keyframes.slice(0, keyframes.indexOf("@keyframes", 1));
  assert.match(endState, /100%\s*\{\s*opacity:\s*1;\s*\}/);
});

test("the fade is applied on navigation, and the wrapped children carry it", () => {
  // The fade must sit on the element that actually renders the page...
  const classAt = wrapper.indexOf("route-fade-in min-h-screen");
  const childrenAt = wrapper.indexOf("{children}");
  const closingAt = wrapper.indexOf("</div>", classAt);
  assert.ok(classAt !== -1, `${WRAPPER} must apply the route fade class`);
  assert.ok(
    childrenAt > classAt && childrenAt < closingAt,
    `${WRAPPER} must render {children} inside the faded element`,
  );
  // ...and it must be conditional on a first-mount flag: a hard load has to
  // paint its content immediately rather than starting at opacity 0.
  assert.match(
    wrapper,
    /className=\{[^}]*route-fade-in min-h-screen[^}]*\}/,
    "the fade must be conditional, so a hard load paints immediately",
  );
  assert.match(wrapper, /firstMount/, "the condition must be the first mount");
});

test("the wipe veil rests transparent so it can never cover the page", () => {
  // The transparent resting state is applied unconditionally — a veil that
  // lost it would sit at its natural opacity of 1, an opaque sheet over the
  // page — while only the flash is conditional (so nothing flashes on a hard
  // load). The literal prefix below only matches while that holds.
  assert.match(wrapper, /route-wipe pointer-events-none fixed inset-0 z-\[60\] bg-\[#030817\]/);
  assert.doesNotMatch(
    ruleOf(".route-wipe"),
    /animation:/,
    ".route-wipe must carry only the transparent resting state",
  );
  assert.match(ruleOf(".route-wipe"), /opacity:\s*0;/);
  assert.match(ruleOf(".route-wipe-flash"), /animation: routeWipe/);
  assert.match(ruleOf(".route-wipe-flash"), /forwards/);

  // Exactly one keyed element: React cannot remount two siblings that share a
  // key, and a veil reused instead of remounted never replays its one-shot
  // animation (measured: it sat at its transparent resting opacity).
  assert.equal(
    (wrapper.match(/key=\{pathname\}/g) || []).length,
    1,
    "exactly one element may be keyed by the pathname",
  );
  const veilAt = wrapper.indexOf("route-wipe");
  assert.ok(
    veilAt > wrapper.indexOf("route-fade-in min-h-screen"),
    "the veil must sit inside the keyed wrapper so it remounts with it",
  );
});

test("providers still wrap every route in the wrapper", () => {
  assert.match(providers, /import RouteTransition from "\.\.\/components\/RouteTransition"/);
  assert.match(providers, /<RouteTransition>\{children\}<\/RouteTransition>/);
});
