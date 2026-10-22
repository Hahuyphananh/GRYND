/**
 * Odds — the prediction interface renders.
 *
 * The geometry and the selection rules are covered by `odds-ring.test.mjs`;
 * this file renders the two client components through React's server renderer
 * so a broken selector (a missing import, a bad hook, an SVG that renders
 * nothing) fails the suite instead of the player.
 *
 * What it pins:
 *   * zoomed out draws ten grouped intervals and no individual labels;
 *   * medium draws one segment + one label per visible number;
 *   * zoomed in draws fewer, wider segments (and still labels them);
 *   * the range selection is reflected in the accessible name (width/points);
 *   * the panel always offers manual min/max (or a single exact field), the
 *     presets, and the width/points readout.
 *
 * Run:  node --import tsx --test tests/odds-selector-render.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import * as selectorModule from "../src/components/odds/CircularSelector.tsx";
import * as panelModule from "../src/components/odds/PredictionPanel.tsx";

const pick = (mod) => mod?.default?.default ?? mod?.default ?? mod;
const CircularSelector = pick(selectorModule);
const PredictionPanel = pick(panelModule);

const noop = () => {};

const count = (html, tag) => (html.match(new RegExp(`<${tag}`, "g")) ?? []).length;
/** Segments painted as ruled out by the clue. */
const dimmed = (html) => (html.match(/fill-opacity="0\.03"/g) ?? []).length;

function renderSelector(props) {
  return renderToStaticMarkup(
    React.createElement(CircularSelector, {
      value: null,
      mode: "range",
      zoom: 1,
      onChange: noop,
      onZoomChange: noop,
      ...props,
    }),
  );
}

test("the wheel renders as SVG with a keyboard entry point", () => {
  const html = renderSelector({});
  assert.match(html, /<svg/);
  assert.match(html, /viewBox="0 0 260 260"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /role="group"/);
  assert.match(html, /aria-label="Number wheel, 1 to 100\. Nothing selected\./);
  assert.match(html, /Arrow keys move, Enter selects, Escape clears/);
});

test("zoomed out shows ten grouped intervals, not 100 labels", () => {
  const html = renderSelector({ zoom: 0 });
  assert.equal(count(html, "path"), 10, "ten decade arcs");
  assert.equal(count(html, "text"), 10, "ten decade labels");
  assert.ok(html.includes("1–10"));
  assert.ok(html.includes("91–100"));
  // No individual values are printed at this level.
  assert.ok(!html.includes(">47<"));
});

test("medium zoom labels every visible number", () => {
  const html = renderSelector({
    zoom: 1,
    value: { kind: "range", min: 48, max: 58 },
  });
  assert.equal(count(html, "path"), 40, "40 segments at medium zoom");
  assert.equal(count(html, "text"), 40, "one label per segment");
  // The selected range and its boundaries are labelled.
  assert.ok(html.includes(">48<"));
  assert.ok(html.includes(">58<"));
  // Two grabbable boundary handles for a range (the ring itself is a third
  // group, which is why the test hooks onto the handle attribute).
  assert.equal((html.match(/data-odds-handle=/g) ?? []).length, 2);
  assert.ok(html.includes('data-odds-handle="min"'));
  assert.ok(html.includes('data-odds-handle="max"'));
  assert.ok(html.includes('data-odds-ring="zoom-1"'));
});

test("zoomed in magnifies the ring section", () => {
  const zoomed = renderSelector({ zoom: 2 });
  const medium = renderSelector({ zoom: 1 });
  assert.equal(count(zoomed, "path"), 20);
  assert.equal(count(zoomed, "text"), 20);
  assert.ok(count(zoomed, "path") < count(medium, "path"));
});

test("the accessible name reports the call, its width and its points", () => {
  const html = renderSelector({
    value: { kind: "range", min: 48, max: 58 },
  });
  // width 11 → round(100 / 11) = 9 points.
  assert.match(html, /48–58 selected, width 11, about 9 possible points/);

  const exact = renderSelector({ value: { kind: "exact", value: 42 } });
  assert.match(exact, /42 selected, width 1, about 100 possible points/);
  // One marker, no handles, for a one-number call.
  assert.equal((exact.match(/data-odds-handle=/g) ?? []).length, 0);
  assert.equal((exact.match(/data-odds-marker=/g) ?? []).length, 1);
});

test("a full 1–100 call still renders (and cannot be magnified away)", () => {
  const html = renderSelector({
    zoom: 2,
    value: { kind: "range", min: 1, max: 100 },
  });
  // A 100-wide selection forces the full circle, so the decade groups return.
  assert.equal(count(html, "path"), 10);
  assert.match(html, /1–100 selected, width 100, about 1 possible points/);
});

test("values the clue rules out are dimmed, and only those", () => {
  const plain = renderSelector({ zoom: 1 });
  // Without a clue nothing is dimmed.
  assert.equal(dimmed(plain), 0);

  // Medium zoom centres on 50 and shows 30..69. A 40–60 clue leaves 30–39 and
  // 61–69 ruled out: nineteen dimmed segments, and the window's edges stay
  // untouched.
  const clueDimmed = renderSelector({ zoom: 1, ruledOut: { min: 40, max: 60 } });
  assert.equal(dimmed(clueDimmed), 19);
  // The same limit is stated to screen readers, not only painted.
  assert.match(clueDimmed, /The clue limits this to 40–60\./);

  // A selected cell wins over the dimming: the player's own call is never
  // painted as if it were impossible. At the decade level, 1–10 is ruled out
  // by the clue but selected, so seven dimmed decades become six.
  const selected = renderSelector({
    zoom: 0,
    value: { kind: "range", min: 1, max: 10 },
    ruledOut: { min: 40, max: 60 },
  });
  assert.equal(dimmed(selected), 6);
  assert.ok(selected.includes('fill-opacity="0.9"'), "the selected decade stays bright");
});

test("the panel renders the clue context it was given", () => {
  const withClue = renderToStaticMarkup(
    React.createElement(PredictionPanel, {
      value: { kind: "range", min: 48, max: 58 },
      onChange: noop,
      clue: "Between 40 and 60, inclusive.",
    }),
  );
  assert.ok(withClue.includes("dimmed · outside the clue (40–60)"));
  // 48–58 is inside the clue, so there is nothing to warn about.
  assert.ok(!withClue.includes("your call leaves the clue"));

  const outside = renderToStaticMarkup(
    React.createElement(PredictionPanel, {
      value: { kind: "range", min: 70, max: 80 },
      onChange: noop,
      clue: "Between 40 and 60, inclusive.",
    }),
  );
  assert.ok(outside.includes("your call leaves the clue"));

  // An unrecognised clue dims nothing and adds no legend.
  const unknown = renderToStaticMarkup(
    React.createElement(PredictionPanel, {
      value: { kind: "range", min: 48, max: 58 },
      onChange: noop,
      clue: "Something else entirely.",
    }),
  );
  assert.ok(!unknown.includes("dimmed · outside the clue"));
});

test("the panel renders manual inputs, presets and the readout", () => {
  const html = renderToStaticMarkup(
    React.createElement(PredictionPanel, {
      value: { kind: "range", min: 48, max: 58 },
      onChange: noop,
      onSubmit: noop,
    }),
  );

  // Range mode: two fields, both labelled.
  assert.equal(count(html, "input"), 2);
  assert.match(html, /aria-label="Minimum, 1 to 100"/);
  assert.match(html, /aria-label="Maximum, 1 to 100"/);
  // Readout: width 11, 9 points.
  assert.ok(html.includes(">11<"));
  assert.ok(html.includes(">9<"));
  // Mode + presets are pressed-state buttons; 1–100 is always offered.
  assert.ok(count(html, "button") >= 20);
  assert.ok(html.includes("1–100"));
  assert.match(html, /aria-label="Quick ranges"/);
  assert.match(html, /aria-label="Zoom in"/);
  assert.match(html, /aria-label="Zoom out"/);
});

test("exact mode collapses the panel to a single number field", () => {
  const html = renderToStaticMarkup(
    React.createElement(PredictionPanel, {
      value: { kind: "exact", value: 42 },
      onChange: noop,
    }),
  );
  assert.equal(count(html, "input"), 1);
  assert.match(html, /aria-label="Exact number, 1 to 100"/);
  assert.match(html, /value="42"/);
  // The exact toggle is the pressed one.
  assert.match(html, /aria-pressed="true"[^>]*>exact|exact<\/button>/);
});

test("an empty panel invites a call instead of faking one", () => {
  const html = renderToStaticMarkup(
    React.createElement(PredictionPanel, { value: null, onChange: noop }),
  );
  assert.match(html, /tap the wheel, type a range, or pick a preset/);
  assert.match(html, /no call selected/);
  // The readout has nothing to report: min, max, width and points are all
  // placeholders, and no range preset is highlighted.
  assert.ok((html.match(/>—</g) ?? []).length >= 4);
  assert.ok(!html.includes("border-[#f5ff3b] bg-[#f5ff3b]"));
});
