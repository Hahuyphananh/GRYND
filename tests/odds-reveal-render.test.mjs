/**
 * Odds — the target reveal and the score readout render correctly.
 *
 * These are the two places where a decoration could lie about the game, so the
 * tests are mostly about what is NOT allowed:
 *
 *   * the reveal draws nothing at all while the target is still secret,
 *   * the target it prints, and the marker's landing point, come from the target
 *     prop (which only ever holds the server's resolved number),
 *   * hit/miss comes from the awarded points — a 0-point round reads "miss"
 *     even if the animation is still running,
 *   * under `prefers-reduced-motion` the marker is already at the target on the
 *     first frame and the delayed flourishes are not rendered at all.
 *
 * The animation itself cannot be observed from server-rendered markup, so what
 * is asserted here is the settled geometry and the reduced-motion branch; the
 * timing maths lives in `odds-motion.test.mjs`.
 *
 * Run:  node --import tsx --test tests/odds-reveal-render.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import * as revealModule from "../src/components/odds/TargetReveal.tsx";
import * as scoreModule from "../src/components/odds/AnimatedScore.tsx";
import { sweepDegrees } from "../src/components/odds/oddsMotion.ts";
import { polar } from "../src/components/odds/oddsRing.ts";

const pick = (mod) => mod?.default?.default ?? mod?.default ?? mod;
const TargetReveal = pick(revealModule);
const AnimatedScore = pick(scoreModule);

const CENTER = 100;
const MARKER_RADIUS = 74;

function renderReveal(props) {
  return renderToStaticMarkup(React.createElement(TargetReveal, props));
}

/** The marker's translate, i.e. where the sweep has settled in this render. */
function markerOffset(html) {
  const group = html.match(/<g style="transform:([^"]+)"/);
  if (!group) return null;
  const x = /translateX\((-?[\d.]+)px\)/.exec(group[1]);
  const y = /translateY\((-?[\d.]+)px\)/.exec(group[1]);
  return { x: x ? Number(x[1]) : 0, y: y ? Number(y[1]) : 0 };
}

/** Render with the media query claiming reduced motion, then restore the globals. */
function withReducedMotion(render) {
  const listeners = { addEventListener() {}, removeEventListener() {} };
  const query = {
    matches: true,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  };
  globalThis.window = { ...listeners, matchMedia: () => query };
  try {
    return render();
  } finally {
    delete globalThis.window;
  }
}

test("the reveal shows the server's target and a hit", () => {
  const html = renderReveal({
    target: 62,
    prediction: { kind: "range", min: 40, max: 55 },
    points: 8,
  });

  // Everything a player is told comes from the props.
  assert.match(html, /aria-label="Target 62\. Your call 40–55 hit for 8 points\."/);
  assert.ok(html.includes(">62<"), "the revealed number is printed");
  assert.ok(html.includes("hit · +8"));
  assert.ok(html.includes("your call"));
  assert.ok(html.includes("40–55"));
  // The call is drawn as its own band, and the marker exists.
  assert.equal((html.match(/data-odds-reveal="band"/g) ?? []).length, 1);
  assert.equal((html.match(/data-odds-reveal="marker"/g) ?? []).length, 1);
  assert.match(html, /data-odds-reveal="marker"[^>]*fill="#f5ff3b"|fill="#f5ff3b"[^>]*data-odds-reveal="marker"/);
});

test("a zero-point round reads as a miss, not a near hit", () => {
  const html = renderReveal({
    target: 62,
    prediction: { kind: "range", min: 40, max: 55 },
    points: 0,
  });
  assert.match(html, /Target 62\. Your call 40–55 missed\./);
  assert.ok(html.includes("miss · target outside your call"));
  assert.ok(!html.includes("hit ·"));
  // The call band is faded back so the marker is the only highlight.
  assert.match(html, /data-odds-reveal="band"[^>]*stroke-opacity="0\.18"|stroke-opacity="0\.18"[^>]*data-odds-reveal="band"/);
  assert.match(html, /data-odds-reveal="marker"[^>]*fill="#ffffff"|fill="#ffffff"[^>]*data-odds-reveal="marker"/);
});

test("nothing is revealed while the target is still secret", () => {
  for (const points of [0, 10, null]) {
    const html = renderReveal({
      target: null,
      prediction: { kind: "range", min: 40, max: 55 },
      points,
    });
    assert.equal(html, "", "a secret round renders no target, no marker, no verdict");
  }
});

test("a full-circle call is drawn as a ring, and still scores from its points", () => {
  const html = renderReveal({
    target: 62,
    prediction: { kind: "range", min: 1, max: 100 },
    points: 1,
  });
  // The 100-wide call covers the whole circle; a single arc would collapse to
  // nothing, so it is drawn as a ring instead.
  assert.match(html, /<circle[^>]*data-odds-reveal="band"|data-odds-reveal="band"[^>]*r="74"/);
  assert.ok(html.includes("hit · +1"));
  assert.match(html, /Your call 1–100 hit for 1 points/);
});

test("the marker starts at the top and finishes on the target", () => {
  // No reduced motion in this render (no window during SSR): the marker starts
  // at 12 o'clock, which is where the sweep begins.
  const animated = renderReveal({
    target: 62,
    prediction: { kind: "range", min: 40, max: 55 },
    points: 8,
  });
  const start = markerOffset(animated);
  assert.deepEqual(start, { x: 0, y: -MARKER_RADIUS });
  assert.equal((animated.match(/data-odds-reveal="pulse"/g) ?? []).length, 1);

  // Reduced motion renders the settled frame: the marker is already exactly on
  // the target's own segment, and no delayed flourish is mounted.
  const settled = withReducedMotion(() => renderReveal({
    target: 62,
    prediction: { kind: "range", min: 40, max: 55 },
    points: 8,
  }));
  assert.equal((settled.match(/data-odds-reveal="pulse"/g) ?? []).length, 0);
  const landed = markerOffset(settled);
  const expected = polar(sweepDegrees(62), MARKER_RADIUS, CENTER);
  assert.ok(Math.abs(landed.x - (expected.x - CENTER)) < 0.01, `x ${landed.x}`);
  assert.ok(Math.abs(landed.y - (expected.y - CENTER)) < 0.01, `y ${landed.y}`);
});

test("the score readout shows the value it was given", () => {
  const html = renderToStaticMarkup(
    React.createElement(AnimatedScore, { value: 0, className: "odds-readout" }),
  );
  assert.equal(html, '<span class="odds-readout">0</span>');

  const later = renderToStaticMarkup(
    React.createElement(AnimatedScore, { value: 137 }),
  );
  assert.equal(later, "<span class=\"\">137</span>");
});

test("the reveal is announced once, with the settled verdict", () => {
  const html = renderReveal({
    target: 7,
    prediction: { kind: "exact", value: 7 },
    points: 100,
  });
  // One live region, carrying only the awarded outcome.
  assert.equal((html.match(/aria-live="polite"/g) ?? []).length, 1);
  assert.ok(html.includes("hit · +100"));
  assert.match(html, /aria-label="Target 7\. Your call 7 hit for 100 points\."/);
});
