/**
 * mini-golf-ai.test.mjs
 *
 * The Mini Golf practice bot (src/lib/mini-golf/ai.ts):
 *   * it always returns a LEGAL shot (finite angle in [0,360), power in [0,100])
 *   * it is DETERMINISTIC — the same position always yields the same shot
 *   * it actually HOLES OUT: playing both seats with the bot finishes every
 *     generated hole within a sane stroke budget, so a practice match can never
 *     stall (both balls must hole out before a hole completes)
 *
 * Run:  node --import tsx --test tests/mini-golf-ai.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { chooseAiShot, powerToStopAt, normalizeAngle } from "../src/lib/mini-golf/ai.ts";
import { applyShot, createInitialState, holeFor } from "../src/lib/mini-golf/rules.ts";
import { simulateShot } from "../src/lib/mini-golf/physics.ts";
import { HOLE_COUNT, POWER_MAX, POWER_MIN } from "../src/lib/mini-golf/constants.ts";

/** Play one seat's shot with the bot and return the applied result. */
function aiStep(state, seat) {
  const hole = holeFor(state);
  const from = state.balls[seat];
  const shot = chooseAiShot({ hole, from: { x: from.x, y: from.y } });
  const shotResult = simulateShot({ hole, from, shot });
  return { shot, applied: applyShot({ state, seat, angle: shot.angle, power: shot.power, shotResult }) };
}

test("the bot always returns a legal shot", () => {
  for (const seed of [1, 2, 3, 777, 424242]) {
    const state = createInitialState({ seed });
    for (let hole = 1; hole <= HOLE_COUNT; hole += 1) {
      const h = state.holes[hole - 1];
      const from = h.geometry.tee;
      const shot = chooseAiShot({ hole: h, from });
      assert.ok(Number.isFinite(shot.angle), `seed ${seed} hole ${hole}: angle finite`);
      assert.ok(shot.angle >= 0 && shot.angle < 360, `seed ${seed} hole ${hole}: angle in range`);
      assert.ok(Number.isFinite(shot.power), `seed ${seed} hole ${hole}: power finite`);
      assert.ok(
        shot.power >= POWER_MIN && shot.power <= POWER_MAX,
        `seed ${seed} hole ${hole}: power in range (${shot.power})`,
      );
    }
  }
});

test("the bot is deterministic — same position, same shot", () => {
  for (const seed of [5, 61, 909]) {
    const hole = createInitialState({ seed }).holes[2];
    const from = { x: 123, y: 234 };
    const a = chooseAiShot({ hole, from });
    const b = chooseAiShot({ hole, from });
    assert.deepEqual(a, b);
  }
});

test("normalizeAngle / powerToStopAt behave at the bounds", () => {
  assert.equal(normalizeAngle(0), 0);
  assert.equal(normalizeAngle(-90), 270);
  assert.equal(normalizeAngle(450), 90);
  assert.ok(powerToStopAt(0) >= POWER_MIN);
  assert.equal(powerToStopAt(100000), POWER_MAX);
});

test("an all-bot match holes out every hole within a sane stroke budget", () => {
  // Both seats are played by the bot, across many seeds, so the convergence of
  // the search is exercised on every generated course. A hole needs BOTH balls
  // holed out, so a bot that can't finish would stall the match forever.
  const SEEDS = Array.from({ length: 16 }, (_, i) => (i + 1) * 37);
  let worstHoleStrokes = 0;

  for (const seed of SEEDS) {
    let state = createInitialState({ seed });
    let guard = 0;

    while (state.phase !== "finished" && guard < 400) {
      guard += 1;
      const seat = state.currentTurn;
      const { applied } = aiStep(state, seat);
      if (applied.holeCompleted) {
        const idx = state.currentHole - 1;
        const score = applied.state.holeScores[idx];
        worstHoleStrokes = Math.max(worstHoleStrokes, score.player1, score.player2);
      }
      state = applied.state;
    }

    assert.equal(state.phase, "finished", `seed ${seed} must finish (guard=${guard})`);
  }

  // Each hole should resolve comfortably inside a small budget; a regression in
  // the bot (or the physics) shows up here long before a player notices.
  assert.ok(
    worstHoleStrokes <= 12,
    `the bot must never need more than 12 strokes on a hole (worst was ${worstHoleStrokes})`,
  );
});

// ── Practice mode is unrated and server-driven ─────────────────────────────

const read = (p) => fs.readFileSync(p, "utf8");
const STORE = read("src/lib/mini-golf/serverStore.ts");

test("practice matches are marked isAi and use the namespaced bot identity", () => {
  assert.match(STORE, /export async function createAiMatch/);
  assert.match(STORE, /player2Id: MINI_GOLF_AI_PLAYER_ID/);
  assert.match(STORE, /isAi: true/);
  // A practice lobby is never offered to real matchmaking.
  assert.match(STORE, /export async function listOpenMatches/);
  assert.match(STORE, /isNull\(miniGolfMatches\.player2Id\)/);
});

test("practice matches can never settle a rating or trophy", () => {
  // The shared settler short-circuits on isAi; advanceAiTurns never calls it.
  assert.match(STORE, /if \(match\.isAi\) return;/);
  assert.match(STORE, /NO settleMatch \/ mirrorQueueTransition here/);
});

test("the bot's turn is advanced by the human's own read (server-driven)", () => {
  const route = read("src/app/api/mini-golf/match/[matchId]/route.ts");
  assert.match(route, /advanceAiTurns\(\{ userId, matchId \}\)/);
  assert.match(route, /if \(match\.isAi\)/);
  // Only the human seat may advance the bot.
  assert.match(STORE, /match\.player1Id !== userId/);
  // One read resolves a bounded number of bot strokes.
  assert.match(STORE, /MAX_AI_SHOTS_PER_ADVANCE/);
});

test("a create-ai route exists and the DTO exposes isAi for labelling", () => {
  const route = read("src/app/api/mini-golf/create-ai/route.ts");
  assert.match(route, /createAiMatch/);
  assert.match(route, /requireAgeVerifiedUser/);
  assert.match(STORE, /isAi: Boolean\(match\.isAi\)/);
});

test("the lobby offers a practice button that starts an unrated match", () => {
  const lobby = read("src/app/casino/mini-golf/PageClient.tsx");
  assert.match(lobby, /\/api\/mini-golf\/create-ai/);
  assert.match(lobby, /data-testid="mini-golf-practice"/);
});
