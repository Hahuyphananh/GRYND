/**
 * route-transition-visibility.test.mjs
 *
 * The shared page wrapper must never be able to hide the page, and must never
 * paint a full-screen flash over it.
 *
 * History: the wrapper used to be a keyed framer-motion child inside
 * `<AnimatePresence mode="wait">`, and when Next's navigation interleaved with
 * the exit/enter hand-off it was left on its `initial` opacity for good —
 * Pool Masters, Precision and the Chess "created, waiting for opponent" page
 * rendered a complete waiting room in the DOM that painted nothing until the
 * player refreshed (docs/route-transition-blank-page.md).
 *
 * The first fix kept a 0.25s page fade and added `.route-wipe`, a full-viewport
 * veil at 34% page colour for 280ms on every navigation. That veil is what read
 * as a camera flash; it has been removed in favour of a 6px content settle and
 * a 2px accent hairline, and these assertions keep it removed.
 *
 * These are wiring-level assertions, which is this repo's convention for page
 * contracts; the behavioural half of the guard is the browser check
 * `node qa/games-blank-audit.mjs --create-only`, which fails when any create
 * journey leaves a page invisible.
 *
 * Assertions run against the files with their comments stripped: the comments
 * document the old markup, and prose must neither satisfy nor trip a guard
 * about what the code does.
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

test("the settle has no opacity-0 resting state", () => {
  assert.match(css, /@keyframes routeSettle\s*\{/);
  assert.match(css, /\.route-settle\s*\{\s*animation: routeSettle/);
  assert.doesNotMatch(
    ruleOf(".route-settle"),
    /opacity:\s*0/,
    "a base opacity of 0 on the page wrapper is the bug being fixed",
  );
  const keyframes = css.slice(css.indexOf("@keyframes routeSettle"));
  const endState = keyframes.slice(0, keyframes.indexOf("@keyframes", 1));
  assert.match(endState, /to\s*\{\s*opacity:\s*1;/);
  // The entrance is a step, not a fade from black: starting near 0 would read
  // as the same flash the veil caused.
  assert.match(endState, /from\s*\{\s*opacity:\s*0\.86;/);
});

test("the settle is applied on navigation, and the wrapped children carry it", () => {
  const classAt = wrapper.indexOf("route-settle min-h-dvh");
  const childrenAt = wrapper.indexOf("{children}");
  const closingAt = wrapper.indexOf("</div>", classAt);
  assert.ok(classAt !== -1, `${WRAPPER} must apply the route settle class`);
  assert.ok(
    childrenAt > classAt && childrenAt < closingAt,
    `${WRAPPER} must render {children} inside the settled element`,
  );
  // ...and it must be conditional on a first-mount flag: a hard load has to
  // paint its content immediately rather than starting translated/translucent.
  assert.match(
    wrapper,
    /className=\{[^}]*route-settle min-h-dvh[^}]*\}/,
    "the settle must be conditional, so a hard load paints immediately",
  );
  assert.match(wrapper, /firstMount/, "the condition must be the first mount");
});

test("nothing flashes a full-screen veil over the page", () => {
  // The removed veil was `fixed inset-0 z-[60]` at 34% page colour. Any
  // full-viewport fixed layer in this wrapper is the regression.
  assert.doesNotMatch(wrapper, /route-wipe/, "the darkening wipe must stay removed");
  assert.doesNotMatch(
    wrapper,
    /fixed inset-0/,
    `${WRAPPER} must not paint a full-viewport overlay on navigation`,
  );
  assert.doesNotMatch(css, /@keyframes routeWipe\b/);
  assert.doesNotMatch(css, /\.route-wipe/);
});

test("the replacement is a 2px accent hairline that cannot cover content", () => {
  assert.match(wrapper, /route-accent-sweep/);
  const rule = ruleOf(".route-accent-sweep");
  assert.match(rule, /height:\s*2px;/, "the sweep must stay a hairline");
  assert.match(rule, /pointer-events:\s*none;/, "the sweep must never eat a click");
  assert.match(rule, /position:\s*fixed;/);
  assert.match(rule, /animation:\s*routeAccentSweep/);
  assert.match(rule, /inset:\s*0 0 auto 0;/, "the sweep belongs to the top edge only");

  // It must be inside the keyed element so it remounts and replays, and it
  // must not exist on a hard load.
  const keyAt = wrapper.indexOf("key={pathname}");
  const sweepAt = wrapper.indexOf("route-accent-sweep");
  const childrenAt = wrapper.indexOf("{children}");
  assert.ok(
    keyAt !== -1 && sweepAt > keyAt && sweepAt < childrenAt,
    "the sweep must sit inside the keyed wrapper, before the page content",
  );
  assert.match(
    wrapper,
    /navigating \? <span[^>]*className="route-accent-sweep" \/> : null/,
    "the sweep is a navigation-only element",
  );
});

test("providers still wrap every route in the wrapper", () => {
  assert.match(providers, /import RouteTransition from "\.\.\/components\/RouteTransition"/);
  assert.match(providers, /<RouteTransition>\{children\}<\/RouteTransition>/);
});
