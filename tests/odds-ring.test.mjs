/**
 * Odds — circular selector helpers (`src/components/odds/oddsRing.ts`).
 *
 * The wheel is pure geometry over the fixed 1..100 domain, so everything the
 * component relies on is testable without a DOM:
 *
 *   * pointer → value mapping at every zoom level (hit testing);
 *   * the visible window (wrap at 100 → 1, no duplicates, decade alignment);
 *   * inclusive, NON-wrapping selection (95 then 5 is 5–95);
 *   * zoom never changes the domain or the prediction, and never hides the
 *     current selection;
 *   * the presets (every decade, the twenty-blocks, both halves, 1–100) and
 *     the active-preset round trip;
 *   * the score preview, which must be the engine's own formula.
 *
 * Run:  node --import tsx --test tests/odds-ring.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ODDS_PRESETS,
  RING_CENTER,
  RING_HANDLE,
  RING_INNER,
  RING_OUTER,
  ZOOM_SPANS,
  activePreset,
  angleForIndex,
  angleForValue,
  annularSectorPath,
  clampDomain,
  clampZoom,
  contains,
  exactPrediction,
  isOnRing,
  orderedSelection,
  pointerToAngle,
  pointerToValue,
  polar,
  potentialScore,
  rangePrediction,
  rangesOverlap,
  selectionLabel,
  selectionOf,
  selectionWidth,
  spanForZoom,
  valueAtIndex,
  windowStartFor,
  windowValues,
} from "../src/components/odds/oddsRing.ts";
import {
  TARGET_MAX,
  TARGET_MIN,
  scorePrediction,
} from "../src/lib/odds.ts";

// ── Domain and zoom ──────────────────────────────────────────────────────

test("the wheel is always the fixed 1..100 domain", () => {
  assert.equal(TARGET_MIN, 1);
  assert.equal(TARGET_MAX, 100);
  for (const zoom of ZOOM_SPANS) {
    assert.ok(zoom <= 100);
  }
  assert.deepEqual([...ZOOM_SPANS], [100, 40, 20]);
});

test("zoom clamps to the three supported levels", () => {
  assert.equal(clampZoom(-1), 0);
  assert.equal(clampZoom(0), 0);
  assert.equal(clampZoom(1), 1);
  assert.equal(clampZoom(2), 2);
  assert.equal(clampZoom(9), 2);
  assert.equal(clampZoom(NaN), 0);
});

test("zooming never hides the current selection", () => {
  const narrow = rangePrediction({ min: 48, max: 52 }); // width 5
  const wide = rangePrediction({ min: 1, max: 100 }); // width 100
  const mid = rangePrediction({ min: 20, max: 79 }); // width 60

  // A narrow call can be magnified…
  assert.equal(spanForZoom(0, selectionOf(narrow)), 100);
  assert.ok(spanForZoom(2, selectionOf(narrow)) >= 5);
  // …a wide one cannot be zoomed past its own width…
  assert.ok(spanForZoom(2, selectionOf(mid)) >= 60);
  // …and the whole domain can never be magnified at all.
  assert.equal(spanForZoom(2, selectionOf(wide)), 100);
});

test("the span only depends on the zoom and the selection, never on the round", () => {
  const selection = selectionOf(rangePrediction({ min: 10, max: 20 }));
  assert.equal(spanForZoom(1, selection), spanForZoom(1, selection));
  assert.equal(spanForZoom(1, null), ZOOM_SPANS[1]);
});

// ── Inclusive, non-wrapping selection ────────────────────────────────────

test("a selection is an inclusive interval and never wraps", () => {
  assert.deepEqual(orderedSelection(5, 5), { min: 5, max: 5 });
  assert.deepEqual(orderedSelection(5, 9), { min: 5, max: 9 });
  assert.deepEqual(orderedSelection(9, 5), { min: 5, max: 9 });
  // 95 → 5 is 5–95, NOT 95→100→1→5.
  assert.deepEqual(orderedSelection(95, 5), { min: 5, max: 95 });
  assert.deepEqual(orderedSelection(1, 100), { min: 1, max: 100 });
});

test("clamping keeps every boundary inside the domain", () => {
  assert.equal(clampDomain(0), 1);
  assert.equal(clampDomain(-20), 1);
  assert.equal(clampDomain(101), 100);
  assert.equal(clampDomain(42.4), 42);
  assert.equal(clampDomain(NaN), 1);
  assert.deepEqual(orderedSelection(-5, 400), { min: 1, max: 100 });
});

test("a range prediction keeps min <= max and inclusive width", () => {
  assert.deepEqual(rangePrediction({ min: 60, max: 40 }), {
    kind: "range",
    min: 40,
    max: 60,
  });
  const single = rangePrediction({ min: 42, max: 42 });
  assert.equal(selectionWidth(single), 1);
  assert.equal(potentialScore(single), 100);
});

test("selectionOf reads exact and range predictions the same way", () => {
  assert.deepEqual(selectionOf(exactPrediction(42)), { min: 42, max: 42 });
  assert.deepEqual(selectionOf(rangePrediction({ min: 5, max: 9 })), {
    min: 5,
    max: 9,
  });
  assert.equal(selectionOf(null), null);
});

test("range predicates are inclusive at both edges", () => {
  const range = { min: 10, max: 20 };
  assert.ok(contains(range, 10));
  assert.ok(contains(range, 20));
  assert.ok(!contains(range, 9));
  assert.ok(!contains(range, 21));
  assert.ok(rangesOverlap(range, { min: 20, max: 30 }));
  assert.ok(!rangesOverlap(range, { min: 21, max: 30 }));
});

// ── Visible window ───────────────────────────────────────────────────────

test("the zoomed-out circle starts at 1 so the decades line up", () => {
  assert.equal(windowStartFor(50, 100), 1);
  assert.equal(windowStartFor(93, 100), 1);
  assert.deepEqual(windowValues(1, 100).slice(0, 3), [1, 2, 3]);
  assert.equal(windowValues(1, 100).length, 100);
});

test("a narrow window wraps through 100 → 1 without duplicates", () => {
  const start = windowStartFor(96, 40); // 96 - 20 → 76
  const values = windowValues(start, 40);
  assert.equal(values.length, 40);
  assert.equal(new Set(values).size, 40);
  assert.equal(values[0], start);
  assert.ok(values.includes(1));
  assert.ok(values.includes(96));
  // Every value is inside the domain.
  assert.ok(values.every((value) => value >= 1 && value <= 100));

  const wrapped = windowValues(windowStartFor(3, 20), 20);
  assert.equal(new Set(wrapped).size, 20);
  assert.ok(wrapped.includes(3));
  assert.ok(wrapped.includes(100));
});

test("the window always contains the centred value", () => {
  for (let center = 1; center <= 100; center += 7) {
    for (const span of [40, 20]) {
      const values = windowValues(windowStartFor(center, span), span);
      assert.ok(
        values.includes(center),
        `span ${span} centred on ${center} lost it`,
      );
    }
  }
});

test("index helpers walk clockwise and keep every value distinct", () => {
  for (const span of [100, 40, 20]) {
    const start = 91;
    const seen = new Set();
    for (let index = 0; index < span; index += 1) {
      const value = valueAtIndex(start, span, index);
      assert.ok(value >= 1 && value <= 100);
      seen.add(value);
    }
    assert.equal(seen.size, span);
  }
  // 100 → 1 continues the circle.
  assert.equal(valueAtIndex(99, 20, 0), 99);
  assert.equal(valueAtIndex(99, 20, 1), 100);
  assert.equal(valueAtIndex(99, 20, 2), 1);
});

// ── Hit testing ──────────────────────────────────────────────────────────

test("every segment's centre hit-tests back to its own value", () => {
  for (const span of [100, 40, 20]) {
    for (const start of [1, 37, 91]) {
      for (let index = 0; index < span; index += 1) {
        const angle = angleForIndex(index, span);
        const point = polar(angle, RING_HANDLE);
        const hit = pointerToValue(point.x, point.y, start, span);
        assert.equal(
          hit,
          valueAtIndex(start, span, index),
          `span ${span} start ${start} index ${index}`,
        );
      }
    }
  }
});

test("12 o'clock is the first visible value and the ring walks clockwise", () => {
  // Straight up from the centre.
  const top = { x: RING_CENTER, y: RING_CENTER - RING_HANDLE };
  assert.equal(pointerToValue(top.x, top.y, 1, 40), 1);
  assert.equal(pointerToValue(top.x, top.y, 73, 20), 73);

  // 3 o'clock is a quarter of the way round.
  const right = { x: RING_CENTER + RING_HANDLE, y: RING_CENTER };
  assert.equal(pointerToValue(right.x, right.y, 1, 40), 11); // index 10 of 40
  assert.ok(pointerToAngle(right.x, right.y) > 89);
  assert.ok(pointerToAngle(right.x, right.y) < 91);
});

test("points off the annulus are not a hit", () => {
  assert.equal(isOnRing(RING_CENTER, RING_CENTER), false);
  assert.equal(
    isOnRing(RING_CENTER, RING_CENTER - RING_HANDLE),
    true,
  );
  assert.equal(
    isOnRing(RING_CENTER, RING_CENTER - (RING_INNER - 20)),
    false,
  );
  assert.equal(pointerToValue(RING_CENTER, RING_CENTER, 1, 40), null);
  assert.equal(
    pointerToValue(RING_CENTER, RING_CENTER - (RING_OUTER + 30), 1, 40),
    null,
  );
});

test("a value maps to its own segment, and off-window values to null", () => {
  assert.equal(angleForValue(1, 40, 1), angleForIndex(0, 40));
  assert.equal(angleForValue(1, 40, 40), angleForIndex(39, 40));
  assert.equal(angleForValue(1, 40, 41), null);
  // Wrapping window: 91..100,1..30 at span 40 starting at 91.
  const start = windowStartFor(91, 40);
  assert.notEqual(angleForValue(start, 40, 100), null);
  assert.notEqual(angleForValue(start, 40, 100 + 1), null);
  assert.equal(angleForValue(start, 40, 31), null);
});

test("the segment path is a closed annular sector with two arcs", () => {
  const path = annularSectorPath(0, 9);
  assert.match(path, /^M /);
  assert.equal((path.match(/A /g) ?? []).length, 2);
  assert.ok(path.trim().endsWith("Z"));
  // A full-circle sector must use the large-arc flag.
  assert.match(annularSectorPath(0, 270), /A 104 104 0 1 1/);
  assert.match(annularSectorPath(0, 9), /A 104 104 0 0 1/);
});

// ── Presets ──────────────────────────────────────────────────────────────

test("every ten-number interval is a preset", () => {
  const decades = ODDS_PRESETS.filter(
    (preset) => preset.max - preset.min + 1 === 10,
  );
  assert.equal(decades.length, 10);
  assert.deepEqual(
    decades.map((preset) => [preset.min, preset.max]),
    Array.from({ length: 10 }, (_, index) => [index * 10 + 1, index * 10 + 10]),
  );
  // They tile 1..100 with no gaps or overlaps.
  const covered = new Set();
  for (const preset of decades) {
    for (let value = preset.min; value <= preset.max; value += 1) {
      assert.ok(!covered.has(value), `${value} is in two decades`);
      covered.add(value);
    }
  }
  assert.equal(covered.size, 100);
});

test("the twenty-blocks, both halves and the full domain are presets", () => {
  const pairs = ODDS_PRESETS.map((preset) => `${preset.min}-${preset.max}`);
  for (const expected of [
    "1-20",
    "21-40",
    "41-60",
    "61-80",
    "81-100",
    "1-50",
    "51-100",
    "1-100",
  ]) {
    assert.ok(pairs.includes(expected), `missing preset ${expected}`);
  }
});

test("preset ids are unique and every preset is a legal range", () => {
  assert.equal(new Set(ODDS_PRESETS.map((p) => p.id)).size, ODDS_PRESETS.length);
  for (const preset of ODDS_PRESETS) {
    assert.ok(preset.min >= TARGET_MIN && preset.max <= TARGET_MAX);
    assert.ok(preset.min <= preset.max);
    assert.ok(preset.label.length > 0);
  }
});

test("the active preset round-trips, and only for an exact range", () => {
  for (const preset of ODDS_PRESETS) {
    const prediction = rangePrediction({ min: preset.min, max: preset.max });
    assert.equal(activePreset(prediction), preset.id);
    // One number off is not that preset any more.
    if (preset.max - preset.min > 0) {
      assert.equal(
        activePreset(rangePrediction({ min: preset.min, max: preset.max - 1 })),
        null,
      );
    }
  }
  assert.equal(activePreset(exactPrediction(42)), null);
  assert.equal(activePreset(null), null);
});

// ── Score preview ────────────────────────────────────────────────────────

test("the preview is the engine's own formula", () => {
  const cases = [
    [exactPrediction(42), 100],
    [rangePrediction({ min: 42, max: 42 }), 100],
    [rangePrediction({ min: 41, max: 42 }), 50],
    [rangePrediction({ min: 40, max: 44 }), 20],
    [rangePrediction({ min: 38, max: 47 }), 10],
    [rangePrediction({ min: 33, max: 52 }), 5],
    [rangePrediction({ min: 18, max: 67 }), 2],
    [rangePrediction({ min: 1, max: 100 }), 1],
  ];
  for (const [prediction, expected] of cases) {
    assert.equal(potentialScore(prediction), expected);
    const inside = prediction.kind === "exact" ? prediction.value : prediction.min;
    assert.equal(potentialScore(prediction), scorePrediction(prediction, inside));
  }
  assert.equal(potentialScore(null), 0);
});

test("width and label read the same on both selection kinds", () => {
  assert.equal(selectionWidth(rangePrediction({ min: 48, max: 58 })), 11);
  assert.equal(selectionWidth(exactPrediction(48)), 1);
  assert.equal(selectionWidth(null), 0);
  assert.equal(selectionLabel(rangePrediction({ min: 48, max: 58 })), "48–58");
  assert.equal(selectionLabel(exactPrediction(48)), "48");
  assert.equal(selectionLabel(null), "none");
});

test("the preview can never exceed 100 points or go negative", () => {
  for (let min = 1; min <= 100; min += 3) {
    for (let max = min; max <= 100; max += 3) {
      const points = potentialScore(rangePrediction({ min, max }));
      assert.ok(points >= 1 && points <= 100, `${min}-${max} → ${points}`);
    }
  }
});
