// src/lib/mini-golf/ui.ts
//
// Pure client-side helpers for the Mini Golf match view.
//
// Everything here is a deterministic function of its arguments — no DOM, no
// canvas, no React — so the aiming maths, the trajectory sampler and the
// scorecard labels can be unit-tested directly and shared between the canvas
// renderer and the controls.
//
// IMPORTANT: nothing in this module is authoritative. The aim preview and the
// local power estimate only decide what the player *asks* for; the ball's final
// position, the stroke count, the hole winner and the match result always come
// from the server's `ShotResult` / match snapshot.

import {
  BALL_RADIUS,
  COURSE_HEIGHT,
  COURSE_WIDTH,
  POWER_MAX,
  POWER_MIN,
} from "./constants";
import type { Hole, HoleDifficulty, Vec2 } from "./types";

// ── Seat colours (duotone used by every GRYND 1v1 match view) ─────────────

export const SEAT_COLORS = {
  player1: "#f59e0b",
  player2: "#22d3ee",
} as const;

/** Colour for a seat, or the neutral fallback for an unknown viewer. */
export function seatColor(seat: string | null | undefined): string {
  if (seat === "player1") return SEAT_COLORS.player1;
  if (seat === "player2") return SEAT_COLORS.player2;
  return "#94a3b8";
}

// ── Aim + power ───────────────────────────────────────────────────────────

/** Degrees in [0, 360) from `from` to `to` (0° = +x / right, 90° = +y / down). */
export function degreesBetween(from: Vec2, to: Vec2): number {
  const deg = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

export function distanceBetween(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function clampPower(power: number): number {
  if (!Number.isFinite(power)) return POWER_MIN;
  if (power < POWER_MIN) return POWER_MIN;
  if (power > POWER_MAX) return POWER_MAX;
  return Math.round(power);
}

/**
 * Map a drag distance (px, from the ball to the finger/cursor) onto a shot
 * power in [0, 100]. A dead zone near the ball keeps a stray tap from becoming
 * a full-power shot, and the mapping saturates at `maxPx`.
 */
export function powerFromDrag(
  distancePx: number,
  { minPx = 16, maxPx = 190 }: { minPx?: number; maxPx?: number } = {},
): number {
  if (!Number.isFinite(distancePx) || distancePx <= minPx) return 0;
  const span = Math.max(1, maxPx - minPx);
  const t = Math.min(1, (distancePx - minPx) / span);
  return clampPower(t * POWER_MAX);
}

/** The point an aim line should reach for a given power (visual only). */
export function aimPreviewLength(power: number): number {
  const p = clampPower(power);
  return 34 + (p / POWER_MAX) * 120;
}

/** Unit direction vector for an angle in degrees. */
export function directionFromAngle(angleDeg: number): Vec2 {
  const rad = ((Number.isFinite(angleDeg) ? angleDeg : 0) * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

/** Arena → screen projection for a course geometry box inside a CSS box. */
export function courseScale(
  geometry: { width?: number; height?: number },
  cssWidth: number,
  cssHeight: number,
): { scale: number; offsetX: number; offsetY: number } {
  const w = geometry?.width || COURSE_WIDTH;
  const h = geometry?.height || COURSE_HEIGHT;
  const scale = Math.min(cssWidth / w, cssHeight / h);
  return {
    scale,
    offsetX: (cssWidth - w * scale) / 2,
    offsetY: (cssHeight - h * scale) / 2,
  };
}

/** Convert a CSS/pointer position into course geometry coordinates. */
export function toCoursePoint(
  pointer: { x: number; y: number },
  render: { scale: number; offsetX: number; offsetY: number },
): Vec2 {
  return {
    x: (pointer.x - render.offsetX) / render.scale,
    y: (pointer.y - render.offsetY) / render.scale,
  };
}

/** The ball radius, re-exported so the renderer and helpers agree. */
export const COURSE_BALL_RADIUS = BALL_RADIUS;

// ── Trajectory sampling ───────────────────────────────────────────────────

/** Cumulative arc length of a polyline; `lengths[i]` is the distance to point i. */
export function pathLengths(path: readonly Vec2[]): number[] {
  const lengths: number[] = [0];
  for (let i = 1; i < path.length; i += 1) {
    lengths.push(lengths[i - 1] + distanceBetween(path[i - 1], path[i]));
  }
  return lengths;
}

export function polylineLength(path: readonly Vec2[]): number {
  if (!path || path.length < 2) return 0;
  return pathLengths(path)[path.length - 1];
}

/**
 * The point at fraction `t` (0..1) of a polyline, walked by arc length so the
 * animation moves at a roughly constant screen speed instead of jumping
 * between unevenly spaced server samples.
 */
export function samplePath(path: readonly Vec2[], t: number): Vec2 {
  if (!path || path.length === 0) return { x: 0, y: 0 };
  if (path.length === 1) return { x: path[0].x, y: path[0].y };
  const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const lengths = pathLengths(path);
  const total = lengths[lengths.length - 1];
  if (total <= 0) return { x: path[path.length - 1].x, y: path[path.length - 1].y };
  const target = clamped * total;
  for (let i = 1; i < lengths.length; i += 1) {
    if (target <= lengths[i]) {
      const segment = Math.max(1e-9, lengths[i] - lengths[i - 1]);
      const local = (target - lengths[i - 1]) / segment;
      return {
        x: path[i - 1].x + (path[i].x - path[i - 1].x) * local,
        y: path[i - 1].y + (path[i].y - path[i - 1].y) * local,
      };
    }
  }
  return { x: path[path.length - 1].x, y: path[path.length - 1].y };
}

/**
 * How long to animate a server trajectory. Proportional to its length so a
 * long roll reads slower than a tap-in, clamped so neither extreme is jarring.
 */
export function animationDurationMs(
  path: readonly Vec2[],
  { min = 380, max = 2400, pxPerMs = 0.9 } = {},
): number {
  const len = polylineLength(path);
  if (len <= 0) return min;
  return Math.round(Math.min(max, Math.max(min, len / pxPerMs)));
}

// ── Scorecard / copy ──────────────────────────────────────────────────────

export type Seat = "player1" | "player2";
export type HoleWinner = Seat | "tie";

/** "You" / "Opponent" — never infers a name the server did not send. */
export function seatLabel(seat: Seat, viewerSeat: Seat | null): string {
  if (!viewerSeat) return seat === "player1" ? "Player 1" : "Player 2";
  return seat === viewerSeat ? "You" : "Opponent";
}

export function holeResultLabel(winner: HoleWinner, viewerSeat: Seat | null): string {
  if (winner === "tie") return "Hole halved";
  return `${seatLabel(winner, viewerSeat)} won the hole`;
}

/** Total strokes each seat has taken across the whole match. */
export function totalStrokes(holeScores: { player1: number; player2: number }[]): {
  player1: number;
  player2: number;
} {
  const out = { player1: 0, player2: 0 };
  for (const score of holeScores ?? []) {
    out.player1 += Number(score?.player1) || 0;
    out.player2 += Number(score?.player2) || 0;
  }
  return out;
}

export const DIFFICULTY_LABELS: Record<HoleDifficulty, string> = {
  easy: "Easy",
  "easy-medium": "Easy / Medium",
  medium: "Medium",
  "medium-hard": "Medium / Hard",
  hard: "Hard",
};

/** A short, human description of where a hole sits in the ramp. */
export function difficultyLabel(hole: Hole | null | undefined): string {
  if (!hole?.difficulty) return "Medium";
  return DIFFICULTY_LABELS[hole.difficulty] ?? "Medium";
}

/** "Best of 5 — first to 3 hole wins". */
export function matchFormatLabel(holeCount: number, holesToWin: number): string {
  return `Best of ${holeCount} — first to ${holesToWin}`;
}

/**
 * Dots a seat has earned towards the win total, e.g. 2 wins of 3 → ["won","won","open"].
 * Rendered as the scoreboard pips; derived purely from the server's count.
 */
export function winPips(wins: number, holesToWin: number): boolean[] {
  const total = Math.max(0, Math.floor(holesToWin));
  const won = Math.max(0, Math.min(total, Math.floor(wins) || 0));
  return Array.from({ length: total }, (_, i) => i < won);
}

/** The outcome of the current hole as three short columns for the overlay. */
export function holeScoreLine(
  holeNumber: number,
  score: { player1: number; player2: number } | null,
  winner: HoleWinner | null,
  viewerSeat: Seat | null,
): { hole: number; player1: number; player2: number; winner: HoleWinner | null; label: string } {
  const safe = score ?? { player1: 0, player2: 0 };
  return {
    hole: holeNumber,
    player1: Number(safe.player1) || 0,
    player2: Number(safe.player2) || 0,
    winner: winner ?? null,
    label: winner ? holeResultLabel(winner, viewerSeat) : "In progress",
  };
}
