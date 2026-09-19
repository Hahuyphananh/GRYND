// ── Time axis for the Precision rocket race ──────────────────────────────
//
// Pure, React-free helpers for the vertical race board's scale. Kept out of
// the component so the maths (which decides where the threshold line and the
// rockets are drawn) can be unit-tested without a DOM.
//
// The board is a vertical TIME axis, crash-game style: 0s at the bottom,
// increasing upward. The axis ceiling is derived from the round's target so
// the dashed target line always sits inside the plot with visible headroom
// above it (a rocket that overshoots the target still has somewhere to fly).

import { MAX_STOP_MS, MAX_TARGET_MS } from "./constants";

/** "Nice" side-axis steps in ms — whole/half seconds, so the labels stay
 *  readable and never turn into decimal clutter. */
export const NICE_AXIS_STEPS_MS = [
  250, 500, 1_000, 2_000, 2_500, 5_000, 10_000, 15_000, 20_000, 30_000,
] as const;

/**
 * Upper bound of the time axis for a round.
 *
 * ~20% of headroom above the target keeps the threshold line off the ceiling;
 * when no target is known yet (the very first arming, where the server keeps
 * the next target private) it falls back to the maximum possible target. The
 * result is clamped to the game's hard maximum stop so the axis can never
 * promise more than a round can ever run.
 */
export function computeAxisMaxMs(targetMs: number | null | undefined): number {
  const known = typeof targetMs === "number" && Number.isFinite(targetMs) && targetMs > 0;
  const base = known ? (targetMs as number) : MAX_TARGET_MS;
  const headroom = Math.ceil((base * 1.2) / 500) * 500;
  return Math.min(Math.max(headroom, 3_000), MAX_STOP_MS);
}

/** Tick values (ms), ascending, always including 0 and the axis maximum. */
export function computeTicks(maxMs: number): number[] {
  if (!Number.isFinite(maxMs) || maxMs <= 0) return [0];
  const rough = maxMs / 5;
  const step =
    NICE_AXIS_STEPS_MS.find((s) => s >= rough) ??
    NICE_AXIS_STEPS_MS[NICE_AXIS_STEPS_MS.length - 1];
  const ticks: number[] = [];
  for (let v = 0; v <= maxMs + 0.5; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] !== maxMs) ticks.push(maxMs);
  return ticks;
}

/** Seconds label for a tick: whole seconds stay clean ("4s"), sub-second ticks
 *  keep one decimal ("0.5s") so the printed value is faithful. */
export function formatSecondsLabel(ms: number): string {
  const s = ms / 1000;
  return `${s % 1 === 0 ? s.toFixed(0) : s.toFixed(1)}s`;
}

/** Position on the axis as a 0–100 percentage, clamped to the track. */
export function axisPercent(ms: number, maxMs: number): number {
  if (!Number.isFinite(ms) || !Number.isFinite(maxMs) || maxMs <= 0) return 0;
  return Math.max(0, Math.min(100, (ms / maxMs) * 100));
}
