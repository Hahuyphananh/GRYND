// src/lib/hexBoardGeometry.ts
//
// Pure, DOM-free helpers for Hex Duel's board presentation. Keeping the maths
// here (instead of inside the components) makes it testable in Node without a
// browser and keeps the visual layer free of layout guesswork:
//
//   • troopDotCount   — how many dots a territory's army draws
//   • arrowGeometry   — source→destination arrow, stopping at the hex edges
//   • describeAttackPreview — the one-line "will this conquer?" expectation
//
// None of this touches gameplay: the authoritative count/outcome is still
// decided by src/lib/hex-duel/rules.ts.

/** Dots are arranged in a compact 10-column formation. */
export const TROOP_DOT_COLUMNS = 10;

/** A territory never draws more than this many dots. */
export const MAX_TROOP_DOTS = 100;

/**
 * Number of army dots for an authoritative troop count: one dot per troop,
 * floored, clamped to 0..100.
 */
export function troopDotCount(troops: number): number {
  const n = Number.isFinite(troops) ? Math.floor(troops) : 0;
  if (n <= 0) return 0;
  return Math.min(n, MAX_TROOP_DOTS);
}

export interface Point {
  x: number;
  y: number;
}

export interface ArrowGeometry {
  /** Where the line starts (at the source hex edge). */
  start: Point;
  /** Where the line ends (at the destination hex edge). */
  end: Point;
  /** SVG `points` for the arrowhead, pointing at the destination. */
  head: string;
  /** Midpoint of the line (for reference/testing). */
  mid: Point;
  /** Suggested position for the troop-count label, offset off the line. */
  label: Point;
  /** Direction of travel in radians. */
  angle: number;
}

export interface ArrowGeometryOptions {
  /** Distance kept clear of the source centre (roughly the hex radius). */
  startInset?: number;
  /** Distance kept clear of the destination centre. */
  endInset?: number;
  headLength?: number;
  headWidth?: number;
  /** Perpendicular offset of the troop-count label from the line. */
  labelOffset?: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Geometry for a directional arrow between two tile centres, expressed in the
 * board's own layout pixels. Returns null when the two centres are too close
 * to draw a meaningful arrow.
 */
export function arrowGeometry(
  from: Point,
  to: Point,
  options: ArrowGeometryOptions = {},
): ArrowGeometry | null {
  const startInset = options.startInset ?? 0;
  const endInset = options.endInset ?? 0;
  const headLength = options.headLength ?? 11;
  const headWidth = options.headWidth ?? 7;
  const labelOffset = options.labelOffset ?? 16;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);

  if (!Number.isFinite(distance) || distance <= startInset + endInset + headLength) {
    return null;
  }

  const ux = dx / distance;
  const uy = dy / distance;
  const start = { x: from.x + ux * startInset, y: from.y + uy * startInset };
  const end = { x: to.x - ux * endInset, y: to.y - uy * endInset };

  const angle = Math.atan2(uy, ux);
  // Arrowhead: the tip sits on `end`, the base is `headLength` back, and the
  // two wings are pushed out perpendicular to the direction of travel.
  const base = { x: end.x - ux * headLength, y: end.y - uy * headLength };
  const px = -uy;
  const py = ux;
  const head = [
    `${round(end.x)},${round(end.y)}`,
    `${round(base.x + (px * headWidth) / 2)},${round(base.y + (py * headWidth) / 2)}`,
    `${round(base.x - (px * headWidth) / 2)},${round(base.y - (py * headWidth) / 2)}`,
  ].join(" ");

  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const label = { x: mid.x + px * labelOffset, y: mid.y + py * labelOffset };

  return { start, end, head, mid, label, angle };
}

export interface AttackPreview {
  /** One-line expectation, e.g. "Conquers · 4 survive". */
  text: string;
  /** True when the attack is expected to take the territory. */
  conquers: boolean;
}

type AttackOutcomeLike =
  | { kind: "conquer"; remainingTroops: number; conqueredCapital: boolean }
  | { kind: "tie"; tileTroops: number }
  | { kind: "failed"; newDefenderTroops: number; defenderWipedOut: boolean };

/**
 * Turn the rulebook's combat outcome into the popup's expectation line. The
 * survivor count is clamped to the level-1 conquest ceiling for display, which
 * is also the rule the validator enforces on the send size.
 */
export function describeAttackPreview(
  outcome: AttackOutcomeLike,
  conquestCapacity = 10,
): AttackPreview {
  if (outcome.kind === "conquer") {
    const survivors = Math.min(outcome.remainingTroops, conquestCapacity);
    return {
      conquers: true,
      text: outcome.conqueredCapital
        ? `Conquers the capital · ${survivors} survive`
        : `Conquers · ${survivors} survive`,
    };
  }
  if (outcome.kind === "tie") {
    return {
      conquers: false,
      text: "Mutual destruction · tile becomes neutral",
    };
  }
  return {
    conquers: false,
    text: outcome.defenderWipedOut
      ? "Defender wiped out · tile becomes neutral"
      : `Does not conquer · defender left with ${outcome.newDefenderTroops}`,
  };
}
