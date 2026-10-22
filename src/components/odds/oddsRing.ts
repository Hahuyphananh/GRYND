// src/components/odds/oddsRing.ts
//
// Pure geometry and selection rules for the Odds circular selector. No React,
// no DOM: the ring component renders these numbers and the tests assert them.
//
// The wheel always represents the same fixed domain (1..100) — zooming only
// changes how many of those numbers are drawn across the full circle, never the
// numbers themselves, the target, the prediction or the score. That is what
// makes "a full 1–100 call is still selectable in round five" true by
// construction: `rangePrediction` is the same shape the engine validates.

import {
  TARGET_MAX,
  TARGET_MIN,
  predictionWidth,
  scorePrediction,
  type OddsPrediction,
} from "../../lib/odds";

/** The square viewBox everything is drawn in. */
export const RING_VIEWBOX = 260;
export const RING_CENTER = RING_VIEWBOX / 2;
/** Annulus the numbers live in. */
export const RING_OUTER = 104;
export const RING_INNER = 74;
/** Radius for the printed numbers, outside the annulus. */
export const RING_LABEL = 120;
/** Radius for the min/max drag handles. */
export const RING_HANDLE = 92;
/** How close a pointer must be to a handle to grab it (viewBox units). */
export const HANDLE_HIT_RADIUS = 13;

/**
 * How many values are drawn across the full circle at each zoom step.
 *
 *   0 — zoomed out: all 100, grouped into ten decades (no individual labels)
 *   1 — medium: 40 numbers, each with its own label
 *   2 — zoomed in: 20 numbers, wide targets and readable boundaries
 */
export const ZOOM_SPANS = [100, 40, 20] as const;

export type OddsZoom = 0 | 1 | 2;

export type OddsRange = { min: number; max: number };

export function clampZoom(zoom: number): OddsZoom {
  if (!Number.isFinite(zoom) || zoom <= 0) return 0;
  if (zoom >= 2) return 2;
  return Math.floor(zoom) as OddsZoom;
}

export function clampDomain(value: number): number {
  if (!Number.isFinite(value)) return TARGET_MIN;
  return Math.min(TARGET_MAX, Math.max(TARGET_MIN, Math.round(value)));
}

/**
 * Inclusive, NON-wrapping selection. Selecting 95 then 5 is 5–95, never a
 * 95→100→1→5 arc: the engine only ever sees `{ min, max }` with min <= max.
 */
export function orderedSelection(a: number, b: number): OddsRange {
  const first = clampDomain(a);
  const second = clampDomain(b);
  return {
    min: Math.min(first, second),
    max: Math.max(first, second),
  };
}

export function rangePrediction(range: OddsRange): OddsPrediction {
  const ordered = orderedSelection(range.min, range.max);
  return { kind: "range", min: ordered.min, max: ordered.max };
}

export function exactPrediction(value: number): OddsPrediction {
  return { kind: "exact", value: clampDomain(value) };
}

/** The span (and min/max) a prediction covers, or null when there is none. */
export function selectionOf(
  prediction: OddsPrediction | null | undefined,
): OddsRange | null {
  if (!prediction) return null;
  if (prediction.kind === "exact") {
    return { min: prediction.value, max: prediction.value };
  }
  return orderedSelection(prediction.min, prediction.max);
}

/** How many values the ring draws at this zoom, given the current selection. */
export function spanForZoom(
  zoom: OddsZoom,
  selection: OddsRange | null,
): number {
  const base = ZOOM_SPANS[clampZoom(zoom)];
  if (!selection) return base;
  // The selection must stay fully visible while zooming, so a wide call simply
  // cannot be magnified past its own width.
  const width = selection.max - selection.min + 1;
  return Math.min(TARGET_MAX - TARGET_MIN + 1, Math.max(base, width + 4));
}

/** First value of the visible window, normalised into 1..100. */
export function windowStartFor(center: number, span: number): number {
  const size = Math.min(TARGET_MAX - TARGET_MIN + 1, Math.max(1, Math.round(span)));
  // A full circle always starts at 1, so the decade groups line up with
  // 1–10, 11–20 … 91–100 instead of rotating with the last selection.
  if (size >= TARGET_MAX - TARGET_MIN + 1) return TARGET_MIN;
  const half = Math.floor(size / 2);
  const start = clampDomain(center) - half;
  return (((start - TARGET_MIN) % 100) + 100) % 100 + TARGET_MIN;
}

/** Value at a ring index, walking clockwise and wrapping at 100 → 1. */
export function valueAtIndex(start: number, span: number, index: number): number {
  const size = Math.min(TARGET_MAX - TARGET_MIN + 1, Math.max(1, Math.round(span)));
  const offset = ((Math.round(index) % size) + size) % size;
  return ((clampDomain(start) - TARGET_MIN + offset) % 100) + TARGET_MIN;
}

/** The visible window, in ring order. */
export function windowValues(start: number, span: number): number[] {
  const size = Math.min(TARGET_MAX - TARGET_MIN + 1, Math.max(1, Math.round(span)));
  return Array.from({ length: size }, (_, index) =>
    valueAtIndex(start, size, index),
  );
}

/** Angle (degrees, clockwise from 12 o'clock) at the centre of one segment. */
export function angleForIndex(index: number, span: number): number {
  const size = Math.max(1, Math.round(span));
  return ((index + 0.5) * 360) / size;
}

/** Angle at the leading edge of one segment. */
export function edgeAngleForIndex(index: number, span: number): number {
  const size = Math.max(1, Math.round(span));
  return (index * 360) / size;
}

/** Angle of a value inside the window, or null when it is off-window. */
export function angleForValue(
  start: number,
  span: number,
  value: number,
): number | null {
  const size = Math.min(TARGET_MAX - TARGET_MIN + 1, Math.max(1, Math.round(span)));
  const offset =
    (((value - clampDomain(start)) % 100) + 100) % 100;
  if (offset >= size) return null;
  return angleForIndex(offset, size);
}

/** Pointer position → clockwise angle from 12 o'clock, in [0, 360). */
export function pointerToAngle(
  x: number,
  y: number,
  center: number = RING_CENTER,
): number {
  const degrees = (Math.atan2(x - center, center - y) * 180) / Math.PI;
  return ((degrees % 360) + 360) % 360;
}

/** Pointer position → the value whose segment it is, or null off the ring. */
export function pointerToValue(
  x: number,
  y: number,
  start: number,
  span: number,
  center: number = RING_CENTER,
): number | null {
  if (!isOnRing(x, y, center)) return null;
  const size = Math.min(TARGET_MAX - TARGET_MIN + 1, Math.max(1, Math.round(span)));
  const angle = pointerToAngle(x, y, center);
  const index = Math.min(size - 1, Math.floor((angle / 360) * size));
  return valueAtIndex(start, size, index);
}

/** Is the point on the number annulus (with a little slop for fingertips)? */
export function isOnRing(
  x: number,
  y: number,
  center: number = RING_CENTER,
): boolean {
  const radius = Math.hypot(x - center, y - center);
  return radius >= RING_INNER - 10 && radius <= RING_OUTER + 10;
}

/** Polar → cartesian in the ring's viewBox (0° = 12 o'clock, clockwise). */
export function polar(
  angle: number,
  radius: number,
  center: number = RING_CENTER,
): { x: number; y: number } {
  const radians = (angle * Math.PI) / 180;
  return {
    x: center + Math.sin(radians) * radius,
    y: center - Math.cos(radians) * radius,
  };
}

/**
 * SVG path for one annular sector — the ring's segment shape.
 *
 * `gap` (degrees) is carved out of each edge so neighbouring numbers read as
 * separate cells instead of one continuous band.
 */
export function annularSectorPath(
  startAngle: number,
  endAngle: number,
  outer: number = RING_OUTER,
  inner: number = RING_INNER,
  center: number = RING_CENTER,
): string {
  const from = startAngle;
  const to = Math.max(startAngle + 0.0001, endAngle);
  const largeArc = to - from > 180 ? 1 : 0;

  const outerStart = polar(from, outer, center);
  const outerEnd = polar(to, outer, center);
  const innerEnd = polar(to, inner, center);
  const innerStart = polar(from, inner, center);

  return [
    `M ${round(outerStart.x)} ${round(outerStart.y)}`,
    `A ${outer} ${outer} 0 ${largeArc} 1 ${round(outerEnd.x)} ${round(outerEnd.y)}`,
    `L ${round(innerEnd.x)} ${round(innerEnd.y)}`,
    `A ${inner} ${inner} 0 ${largeArc} 0 ${round(innerStart.x)} ${round(innerStart.y)}`,
    "Z",
  ].join(" ");
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Do two inclusive ranges overlap at all? */
export function rangesOverlap(a: OddsRange, b: OddsRange): boolean {
  return a.min <= b.max && b.min <= a.max;
}

export function contains(range: OddsRange, value: number): boolean {
  return value >= range.min && value <= range.max;
}

// ── Score preview ─────────────────────────────────────────────────────
// The preview is NOT a second copy of the paytable: it calls the engine's own
// scorer against a target the call certainly contains, so the number shown
// before submission is exactly the number the round would award.

export function potentialScore(prediction: OddsPrediction | null): number {
  if (!prediction) return 0;
  const inside =
    prediction.kind === "exact" ? prediction.value : prediction.min;
  return scorePrediction(prediction, inside);
}

export function selectionWidth(prediction: OddsPrediction | null): number {
  return predictionWidth(prediction) ?? 0;
}

/** "42" or "48–58" — the one-line label for a prediction. */
export function selectionLabel(prediction: OddsPrediction | null): string {
  if (!prediction) return "none";
  if (prediction.kind === "exact") return String(prediction.value);
  return `${prediction.min}–${prediction.max}`;
}

// ── Presets ───────────────────────────────────────────────────────────

export type OddsPreset = {
  id: string;
  label: string;
  min: number;
  max: number;
};

const decade = (index: number): OddsPreset => {
  const min = index * 10 + 1;
  const max = min + 9;
  return { id: `d${min}`, label: `${min}–${max}`, min, max };
};

const block = (min: number, max: number): OddsPreset => ({
  id: `b${min}-${max}`,
  label: `${min}–${max}`,
  min,
  max,
});

/**
 * The quick picks: every ten-number interval, the twenty-number blocks, both
 * halves and the whole domain. 1–100 is always here, all five rounds.
 */
export const ODDS_PRESETS: OddsPreset[] = [
  ...Array.from({ length: 10 }, (_, index) => decade(index)),
  block(1, 20),
  block(21, 40),
  block(41, 60),
  block(61, 80),
  block(81, 100),
  block(1, 50),
  block(51, 100),
  block(1, 100),
];

/** The decade presets, for the zoomed-out ring's group labels. */
export const ODDS_DECADES: OddsPreset[] = Array.from({ length: 10 }, (_, index) =>
  decade(index),
);

/** Which preset the current prediction is exactly, if any. */
export function activePreset(prediction: OddsPrediction | null): string | null {
  if (!prediction || prediction.kind !== "range") return null;
  const match = ODDS_PRESETS.find(
    (preset) =>
      preset.min === prediction.min && preset.max === prediction.max,
  );
  return match ? match.id : null;
}
