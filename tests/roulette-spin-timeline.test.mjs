// Roulette PvP — the spin timeline.
//
// The wheel has to LOOK physical (accelerate, cruise, bleed off, drop the ball
// into a pocket, settle) while still landing on exactly the pocket the server
// picked. These tests pin both halves of that contract:
//
//   • the motion — the wheel never stops before the end, the ball keeps moving
//     angularly the whole way (the old code froze it at 78 %), stays out on the
//     running track through the fast phase, then spirals in;
//   • the destination — `wheelRestAngle` always parks the server's pocket under
//     the fixed pointer, for every pocket, every seed and any starting angle;
//   • the safety net — reduced motion shows the final position and nothing
//     else, and a cancelled/restarted spin still starts where the wheel is.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BALL_POCKET_RADIUS,
  BALL_TRACK_RADIUS,
  REDUCED_MOTION_DURATION_MS,
  createSpinPlan,
  sampleSpinFrame,
} from "../src/lib/roulette-pvp/spinTimeline.ts";

const TWO_PI = Math.PI * 2;
const SEGMENT = TWO_PI / 37;
const POINTER = -Math.PI / 2;
const norm = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;
/** Smallest absolute difference between two angles (radians), 0 … π. */
const angleGap = (a, b) =>
  Math.abs(((((a - b + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI);
const planFor = (finalIndex, extra = {}) =>
  createSpinPlan({
    finalIndex,
    segmentAngle: SEGMENT,
    pointerAngle: POINTER,
    ...extra,
  });

// ── The destination: the server's pocket, every time ───────────────────────

test("the wheel comes to rest with the server's pocket under the pointer", () => {
  for (let index = 0; index < 37; index += 1) {
    const plan = planFor(index);
    const rest = sampleSpinFrame(plan, plan.durationMs);
    const pocketCentre = index * SEGMENT + SEGMENT / 2;
    assert.ok(
      angleGap(rest.wheelAngle + pocketCentre, POINTER) < 1e-9,
      `pocket ${index} did not land under the pointer`,
    );
  }
});

test("the destination is independent of the display angle the spin starts from", () => {
  // A wheel that has been spun a few rounds is at an arbitrary, large angle.
  for (const startAngle of [0, 0.7, 12.34, -55.1, 1000.25]) {
    const plan = planFor(17, { startAngle });
    const rest = sampleSpinFrame(plan, plan.durationMs);
    const pocketCentre = 17 * SEGMENT + SEGMENT / 2;
    assert.equal(plan.wheelStartAngle, startAngle);
    assert.ok(angleGap(rest.wheelAngle + pocketCentre, POINTER) < 1e-9);
    assert.ok(plan.wheelDelta > 0, "the wheel must only ever turn forwards");
  }
});

test("the ball always settles on the pointer, whatever angle it launched from", () => {
  for (const ballStartAngle of [null, 0, 1.1, -3.9, 40.5]) {
    const plan = planFor(23, { ballStartAngle });
    const rest = sampleSpinFrame(plan, plan.durationMs);
    assert.ok(
      angleGap(rest.ballAngle, POINTER) < 1e-9,
      `ball rest ${rest.ballAngle} is not the pointer`,
    );
    assert.equal(rest.ballDist, BALL_POCKET_RADIUS);
    assert.ok(plan.ballDelta < 0, "the ball counter-rotates");
    assert.ok(
      Math.abs(plan.ballDelta) >= TWO_PI * 9,
      "the ball must travel whole counter-rotations, not a token arc",
    );
  }
});

// ── The motion ─────────────────────────────────────────────────────────────

test("the spin runs through acceleration, cruise, deceleration, approach, settle", () => {
  const plan = planFor(5);
  const phases = [];
  for (let i = 0; i <= 200; i += 1) {
    const { phase } = sampleSpinFrame(plan, (plan.durationMs * i) / 200);
    if (phases[phases.length - 1] !== phase) phases.push(phase);
  }
  assert.deepEqual(phases, [
    "accelerate",
    "cruise",
    "decelerate",
    "approach",
    "settle",
  ]);
});

test("the wheel accelerates from rest and is still moving at the end of the approach", () => {
  const plan = planFor(9);
  const at = (p) => sampleSpinFrame(plan, plan.durationMs * p).wheelAngle;

  // A standing start: the first 2 % of the spin covers far less ground than the
  // 2 % in the middle of the cruise (the old curve peaked on frame 1).
  const launch = at(0.02) - at(0);
  const cruise = at(0.5) - at(0.48);
  assert.ok(launch < cruise * 0.2, `launch ${launch} vs cruise ${cruise}`);

  // ...and no crawl: the last stretch before the settle still turns the wheel.
  const tail = at(0.96) - at(0.95);
  assert.ok(tail > 0.01, `the final approach barely moved (${tail} rad per 1 %)`);
});

test("the ball keeps moving angularly right through the spin (never freezes at 78 %)", () => {
  const plan = planFor(31);
  const ballAt = (p) => sampleSpinFrame(plan, plan.durationMs * p).ballAngle;

  for (const p of [0.7, 0.78, 0.8, 0.85, 0.9, 0.95, 0.96]) {
    const moved = Math.abs(ballAt(p + 0.01) - ballAt(p));
    assert.ok(moved > 0.02, `the ball stalled at ${p * 100} % (moved ${moved} rad)`);
  }
  // The old implementation reached zero angular velocity exactly at 78 % while
  // the wheel carried on, which is the discontinuity this pins.
  const wheelAt = (p) => sampleSpinFrame(plan, plan.durationMs * p).wheelAngle;
  assert.ok(Math.abs(wheelAt(0.79) - wheelAt(0.78)) > 0.01);
});

test("the ball runs the outer track, then drops into the pocket", () => {
  const plan = planFor(12);
  const dist = (p) => sampleSpinFrame(plan, plan.durationMs * p).ballDist;

  // Launches from wherever it was resting (no 30 px pop outwards), rides the
  // track through the fast phase, and is in the pocket by the settle.
  assert.equal(dist(0), BALL_POCKET_RADIUS);
  assert.equal(dist(0.5), BALL_TRACK_RADIUS);
  assert.equal(dist(0.6), BALL_TRACK_RADIUS);
  assert.equal(dist(1), BALL_POCKET_RADIUS);

  const midDrop = dist(0.85);
  assert.ok(
    midDrop > BALL_POCKET_RADIUS && midDrop < BALL_TRACK_RADIUS,
    `expected the ball mid-drop, got ${midDrop}`,
  );

  // Monotone out, then monotone in — no floating back and forth — and the
  // settle dips the ball a couple of px deeper before it comes to rest.
  assert.ok(dist(0.99) < BALL_POCKET_RADIUS, "the settle should sink the ball");
  let previous = dist(0);
  for (let i = 1; i <= 60; i += 1) {
    const r = dist(i / 100);
    assert.ok(r >= previous - 1e-9, `ball radius wobbled at ${i}%`);
    previous = r;
  }
  // (The descent runs up to the settle, where the dip reverses as the ball
  // comes to rest, so this loop stops before it.)
  previous = dist(0.64);
  for (let i = 65; i <= 96; i += 1) {
    const r = dist(i / 100);
    assert.ok(r <= previous + 1e-9, `ball radius climbed mid-drop at ${i}%`);
    previous = r;
  }
});

test("the settle beat is short, and it rocks backwards onto the pocket", () => {
  const plan = planFor(3);
  const settleMs = plan.settleFraction * plan.durationMs;
  assert.ok(settleMs > 80 && settleMs < 200, `settle beat was ${settleMs} ms`);

  // The wheel is still creeping forwards right up to the apex of the beat...
  const approach = sampleSpinFrame(plan, plan.durationMs * 0.95).wheelAngle;
  const apex = sampleSpinFrame(
    plan,
    plan.durationMs * (1 - plan.settleFraction),
  ).wheelAngle;
  assert.ok(apex > approach, "the wheel stopped early — that is the old crawl");

  // ...overshoots by the settle's whole amount, then rocks back onto the pocket.
  const rest = sampleSpinFrame(plan, plan.durationMs).wheelAngle;
  assert.ok(rest < apex, "the wheel should overshoot and rock back");
  assert.ok(Math.abs(apex - rest - plan.wheelOvershoot) < 1e-12);
  assert.ok(apex - rest > 0.005 && apex - rest < 0.05, "a nudge, not a bounce");
});

test("the wheel is monotone through the main phase (no reversing before the settle)", () => {
  const plan = planFor(28, { startAngle: 3.3 });
  let previous = -Infinity;
  for (let i = 0; i <= 96; i += 1) {
    const angle = sampleSpinFrame(plan, (plan.durationMs * i) / 100).wheelAngle;
    assert.ok(angle >= previous, `the wheel turned back at ${i}%`);
    previous = angle;
  }
});

// ── Determinism, variation and continuity ──────────────────────────────────

test("a plan is deterministic: the same inputs give the same frames", () => {
  const input = { finalIndex: 14, startAngle: 2.2, seed: "3-14" };
  const a = planFor(14, input);
  const b = planFor(14, input);
  assert.equal(a.durationMs, b.durationMs);
  assert.equal(a.wheelDelta, b.wheelDelta);
  assert.equal(a.ballDelta, b.ballDelta);
  for (let i = 0; i <= 40; i += 1) {
    const t = (a.durationMs * i) / 40;
    assert.deepEqual(sampleSpinFrame(a, t), sampleSpinFrame(b, t));
  }
});

test("every round is shaped differently, but all stay in the same ballpark", () => {
  const durations = new Set();
  const turns = new Set();
  for (let round = 0; round < 12; round += 1) {
    const plan = planFor(7, { seed: `${round}-7` });
    assert.ok(plan.durationMs >= 4050 && plan.durationMs <= 4650);
    durations.add(Math.round(plan.durationMs));
    turns.add(`${plan.wheelTurns}/${plan.ballTurns}`);
  }
  assert.ok(durations.size > 1, "the spin duration should vary round to round");
  assert.ok(turns.size > 1, "the rotation counts should vary round to round");
});

test("a new spin starts from the angle the last one ended on", () => {
  const first = planFor(21, { seed: "0-21" });
  const firstRest = sampleSpinFrame(first, first.durationMs);

  const second = planFor(30, {
    seed: "1-30",
    startAngle: firstRest.wheelAngle,
    ballStartAngle: firstRest.ballAngle,
  });
  const opening = sampleSpinFrame(second, 0);

  // Frame 0 of round 2 is exactly where round 1 parked: no snap back to 0.
  // (The ball's launch angle is normalised, so compare modulo a full turn.)
  assert.equal(opening.wheelAngle, firstRest.wheelAngle);
  assert.ok(angleGap(opening.ballAngle, firstRest.ballAngle) < 1e-9);
  assert.equal(opening.ballDist, BALL_POCKET_RADIUS);

  // ...and the new spin still lands on ITS own server pocket.
  const secondRest = sampleSpinFrame(second, second.durationMs);
  const pocketCentre = 30 * SEGMENT + SEGMENT / 2;
  assert.ok(angleGap(secondRest.wheelAngle + pocketCentre, POINTER) < 1e-9);
});

test("sampling past the end is clamped to the resting frame", () => {
  const plan = planFor(2);
  const rest = sampleSpinFrame(plan, plan.durationMs);
  assert.deepEqual(sampleSpinFrame(plan, plan.durationMs * 4), rest);
  assert.equal(rest.finished, true);
  assert.equal(rest.progress, 1);
});

// ── Reduced motion ─────────────────────────────────────────────────────────

test("reduced motion paints the final position immediately and nothing else", () => {
  const plan = planFor(19, { reducedMotion: true, seed: "0-19" });
  assert.equal(plan.durationMs, REDUCED_MOTION_DURATION_MS);

  // Same resting pose the full spin would end on, from t = 0 — no animation,
  // but still the server's pocket under the pointer.
  const pocketCentre = 19 * SEGMENT + SEGMENT / 2;
  for (const elapsed of [0, 10, 100, 219]) {
    const frame = sampleSpinFrame(plan, elapsed);
    assert.equal(frame.phase, "reduced");
    assert.equal(frame.progress, 1);
    assert.equal(frame.finished, false, "the caller needs one beat before resolving");
    assert.ok(angleGap(frame.wheelAngle + pocketCentre, POINTER) < 1e-9);
    assert.ok(angleGap(frame.ballAngle, POINTER) < 1e-9);
    assert.equal(frame.ballDist, BALL_POCKET_RADIUS);
  }
  assert.equal(sampleSpinFrame(plan, plan.durationMs).finished, true);
});
