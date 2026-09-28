/**
 * Mini Golf — practice-bot difficulty tiers.
 *
 * The bot gained `easy | normal | hard` (the shared `src/lib/aiDifficulty.ts`
 * scale). Two things must hold or the feature is cosmetic:
 *
 *   1. `hard` is EXACTLY the bot that shipped before tiers existed — a caller
 *      that passes no difficulty must get byte-identical shots. Anything else
 *      would silently change every existing practice match.
 *   2. A weaker tier actually plays worse (more strokes) while still finishing
 *      every hole, in every tier, within a sane budget — the bot can never
 *      stall a match, because a hole needs BOTH balls holed out.
 *
 * Run:  node --import tsx --test tests/mini-golf-ai-difficulty.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  DEFAULT_MINI_GOLF_AI_DIFFICULTY,
  MINI_GOLF_AI_TIERS,
  chooseAiShot,
} from "../src/lib/mini-golf/ai.ts";
import {
  applyShot,
  createInitialState,
  holeFor,
} from "../src/lib/mini-golf/rules.ts";
import { simulateShot } from "../src/lib/mini-golf/physics.ts";
import { HOLE_COUNT, POWER_MAX, POWER_MIN } from "../src/lib/mini-golf/constants.ts";

const TIERS = ["easy", "normal", "hard"];
const read = (p) => fs.readFileSync(p, "utf8");

/** Play one seat's shot with the bot at `difficulty`. */
function aiStep(state, seat, difficulty) {
  const hole = holeFor(state);
  const from = state.balls[seat];
  const shot = chooseAiShot({ hole, from: { x: from.x, y: from.y }, difficulty });
  const shotResult = simulateShot({ hole, from, shot });
  return applyShot({ state, seat, angle: shot.angle, power: shot.power, shotResult });
}

/** Play a whole match (both seats) at one tier; return the aggregate stats. */
function playMatch(seed, difficulty) {
  let state = createInitialState({ seed });
  let guard = 0;
  let worstHole = 0;
  while (state.phase !== "finished" && guard < 800) {
    guard += 1;
    const seat = state.currentTurn;
    const applied = aiStep(state, seat, difficulty);
    if (applied.holeCompleted) {
      const score = applied.state.holeScores[state.currentHole - 1];
      worstHole = Math.max(worstHole, score.player1, score.player2);
    }
    state = applied.state;
  }
  assert.equal(state.phase, "finished", `seed ${seed}/${difficulty} must finish (guard ${guard})`);
  const strokes = state.holeScores.reduce((n, s) => n + s.player1 + s.player2, 0);
  return { strokes, worstHole };
}

// ── hard === the original bot ─────────────────────────────────────────────

test("hard is byte-identical to the pre-tier bot (no difficulty means hard)", () => {
  assert.equal(DEFAULT_MINI_GOLF_AI_DIFFICULTY, "hard");
  for (const seed of [3, 19, 88, 720, 4242]) {
    const state = createInitialState({ seed });
    for (let hole = 1; hole <= HOLE_COUNT; hole += 1) {
      const h = state.holes[hole - 1];
      const from = { x: 90 + hole * 13, y: 180 + hole * 17 };
      assert.deepEqual(
        chooseAiShot({ hole: h, from }),
        chooseAiShot({ hole: h, from, difficulty: "hard" }),
        `seed ${seed} hole ${hole}: an unspecified tier must equal hard`,
      );
    }
  }
});

// ── legality ──────────────────────────────────────────────────────────────

test("every tier proposes a legal shot that actually moves the ball", () => {
  for (const seed of [1, 2, 3, 777, 424242]) {
    const state = createInitialState({ seed });
    for (let hole = 1; hole <= HOLE_COUNT; hole += 1) {
      const h = state.holes[hole - 1];
      for (const tier of TIERS) {
        const shot = chooseAiShot({ hole: h, from: h.geometry.tee, difficulty: tier });
        assert.ok(
          Number.isFinite(shot.angle) && shot.angle >= 0 && shot.angle < 360,
          `${tier}: angle ${shot.angle}`,
        );
        assert.ok(
          shot.power >= POWER_MIN && shot.power <= POWER_MAX,
          `${tier}: power ${shot.power}`,
        );
        assert.ok(shot.power > 0, `${tier}: must actually move the ball`);
      }
    }
  }
});

// ── ordering: weaker tiers take more strokes ──────────────────────────────

test("the tiers are ordered — hard beats normal beats easy, and all of them finish", () => {
  const seeds = Array.from({ length: 14 }, (_, i) => (i + 1) * 53);
  const totals = { easy: 0, normal: 0, hard: 0 };
  const worst = { easy: 0, normal: 0, hard: 0 };

  for (const seed of seeds) {
    for (const tier of TIERS) {
      const { strokes, worstHole } = playMatch(seed, tier);
      totals[tier] += strokes;
      worst[tier] = Math.max(worst[tier], worstHole);
    }
  }

  assert.ok(totals.hard < totals.normal, `hard (${totals.hard}) must beat normal (${totals.normal})`);
  assert.ok(totals.normal < totals.easy, `normal (${totals.normal}) must beat easy (${totals.easy})`);

  // A weaker tier is still a golf bot: it must never need an absurd number of
  // strokes, or the match would feel broken rather than merely easy.
  for (const tier of TIERS) {
    assert.ok(worst[tier] <= 20, `${tier} must never need more than 20 strokes on a hole (worst ${worst[tier]})`);
  }
});

test("the tier table itself is ordered, so a pick is never a no-op", () => {
  assert.ok(MINI_GOLF_AI_TIERS.easy.offsets.length < MINI_GOLF_AI_TIERS.hard.offsets.length);
  assert.ok(MINI_GOLF_AI_TIERS.easy.powerCount <= MINI_GOLF_AI_TIERS.normal.powerCount);
  assert.ok(MINI_GOLF_AI_TIERS.normal.powerCount <= MINI_GOLF_AI_TIERS.hard.powerCount);
  assert.ok(MINI_GOLF_AI_TIERS.easy.aimErrorDeg > MINI_GOLF_AI_TIERS.normal.aimErrorDeg);
  assert.ok(MINI_GOLF_AI_TIERS.normal.aimErrorDeg > MINI_GOLF_AI_TIERS.hard.aimErrorDeg);
  assert.equal(MINI_GOLF_AI_TIERS.hard.aimErrorDeg, 0);
  assert.equal(MINI_GOLF_AI_TIERS.hard.powerError, 0);
});

// ── persistence + wiring ──────────────────────────────────────────────────

test("the chosen tier is stored on the match and reaches the bot", () => {
  assert.match(read("src/db/schema.ts"), /aiDifficulty: varchar\("ai_difficulty", \{ length: 16 \}\)/);

  const migration = read("src/db/migrations/0182_mini_golf_ai_difficulty.sql");
  assert.match(migration, /ALTER TABLE "mini_golf_matches"\s+ADD COLUMN IF NOT EXISTS "ai_difficulty"/);

  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
  assert.ok(
    journal.entries.some((e) => e.tag === "0182_mini_golf_ai_difficulty"),
    "the migration must be in the drizzle journal or it never runs",
  );

  const store = read("src/lib/mini-golf/serverStore.ts");
  assert.match(store, /difficulty: aiDifficultyForMatch\(current\)/);
  assert.match(store, /aiDifficulty,/);

  const route = read("src/app/api/mini-golf/create-ai/route.ts");
  assert.match(route, /body\?\.difficulty/);

  const lobby = read("src/app/casino/mini-golf/PageClient.tsx");
  assert.match(lobby, /AiDifficultyPicker/);
  assert.match(lobby, /difficulty: aiDifficulty/);
  // Mini Golf's pre-tier bot was strong, so its lobby defaults to hard.
  assert.match(lobby, /readStoredAiDifficulty\("mini-golf", "hard"\)/);
});

test("the tier is legible while the match runs and after it settles", () => {
  const matchPage = read("src/app/casino/mini-golf/[matchId]/PageClient.tsx");
  // Header badge (data-difficulty), sidebar row and result-screen summary.
  assert.match(matchPage, /data-testid="practice-badge"/);
  assert.match(matchPage, /label="Bot difficulty"/);
  assert.match(matchPage, /AI_DIFFICULTY_LABELS\[botDifficulty\]/);
});

test("the match view recaps the bot's batched turn from the shot log", () => {
  const matchPage = read("src/app/casino/mini-golf/[matchId]/PageClient.tsx");
  // The bot's whole run resolves in one poll, so the summary is derived from
  // the authoritative `shots` history and only shown once the turn comes back.
  assert.match(matchPage, /data-testid="bot-turn-summary"/);
  assert.match(matchPage, /lastBotTurnRecap\(/);
  assert.match(matchPage, /match\.lastShot\?\.seat !== opponentSeat/);
});
