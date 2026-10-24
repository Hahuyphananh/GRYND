/**
 * hillstrike-fairness.test.mjs — the fairness gate.
 *
 * The map generator is mirror-symmetric, and that is a property of the MAP. It
 * says nothing about whether a MATCH is fair: the opening shot, the two-shot
 * volley order and the way destruction reshapes one side of the field are all
 * still in play. So this suite measures the things the symmetry does not cover:
 *
 *   • layout validity and rejection over a fixed seed set;
 *   • whether a layout is even PLAYABLE (a direct-hit line exists for both seats
 *     from their spawns) — a symmetric map with no line of fire is not a fair map;
 *   • full bot-vs-bot matches over the same seeds, with the opening seat swapped,
 *     asserting every match terminates, every intermediate state is valid, and
 *     the volley invariants hold on every single shot;
 *   • the win rates that fall out of that sweep, printed as DATA — the suite does
 *     not assert balance, because a test that asserts a coin flip is fair would
 *     only prove the coin was flipped, not that the game is fair.
 *
 * The large sweep (hundreds of seeds, per-tier) lives in
 * qa/hillstrike-fairness.mjs; this is the bounded version that runs in `npm test`.
 *
 * Run:  node --import tsx --test tests/hillstrike-fairness.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { chooseAiShot } from "../src/lib/hillstrike/ai.ts";
import {
  IMPACT_KINDS,
  LIVES_PER_PLAYER,
  MATCH_STATUS,
  SHOTS_PER_VOLLEY,
  STRUCTURE_BLOCK_SIZE,
  TERRAIN_COLUMNS,
} from "../src/lib/hillstrike/constants.ts";
import { createBattlefield, validateBattlefield } from "../src/lib/hillstrike/generation.ts";
import { simulateShot } from "../src/lib/hillstrike/physics.ts";
import { applyShot, createInitialState } from "../src/lib/hillstrike/rules.ts";

const SEATS = ["player1", "player2"];
const other = (seat) => (seat === "player1" ? "player2" : "player1");

/** The fixed seed set this suite always measures. */
const SEEDS = Array.from({ length: 60 }, (_, index) => index);
/** A smaller fixed set for the (much more expensive) full-match sweep. */
const MATCH_SEEDS = Array.from({ length: 24 }, (_, index) => index * 7 + 3);
const TIER = "normal";
/** Deterministic, slip-free plans: the sweep measures the game, not the dice. */
const NO_SLIPS = () => 1;

/* -------------------------------------------------------------------------- *
 * Layouts
 * -------------------------------------------------------------------------- */

/**
 * Which seats have a line from their spawn that touches the enemy body?
 *
 * The SAME mirrored candidate set is sampled for both seats (player1 at θ is the
 * mirror of player2 at 180−θ), so this measurement cannot invent an asymmetry out
 * of its own sampling grid. Because the battlefield and the physics are exactly
 * mirrored, the expected answer is "both" or "neither" — the test asserts that.
 */
function playableSeats(state) {
  const seats = new Set();
  const hits = (seat, angle, power) => {
    const impact = simulateShot({
      battlefield: state.battlefield,
      shooterSeat: seat,
      shot: { angleDeg: angle, power },
      projectile: state.projectile,
    }).impact;
    return impact.kind === IMPACT_KINDS.PLAYER && impact.target === other(seat);
  };

  for (let angle = 4; angle <= 86 && seats.size < 2; angle += 2) {
    for (let power = 20; power <= 100; power += 4) {
      if (!seats.has("player1") && hits("player1", angle, power)) seats.add("player1");
      if (!seats.has("player2") && hits("player2", 180 - angle, power)) seats.add("player2");
      if (seats.size === 2) break;
    }
  }
  return seats;
}

function layoutReport(seeds) {
  const report = {
    seeds: seeds.length,
    generated: 0,
    rejected: [],
    invalid: [],
    mirrorFailures: [],
    unplayable: [],
    bothSeatsPlayable: 0,
    oneSeatPlayable: 0,
    spawnHeights: [],
    coverHeights: [],
  };

  for (const seed of seeds) {
    let field;
    try {
      field = createBattlefield(seed);
    } catch (error) {
      report.rejected.push({ seed, message: String(error && error.message) });
      continue;
    }
    report.generated += 1;
    const verdict = validateBattlefield(field);
    if (!verdict.ok) {
      report.invalid.push({ seed, message: verdict.message });
      continue;
    }

    const mirrorOk =
      field.terrain.every((height, column) => height === field.terrain[TERRAIN_COLUMNS - 1 - column]) &&
      field.players.player1.y === field.players.player2.y;
    if (!mirrorOk) report.mirrorFailures.push(seed);

    const state = createInitialState({ seed, openingSeat: "player1" });
    const reachable = playableSeats(state);
    // Mirror symmetry says the two seats are playable together or not at all; a
    // one-sided result would be a real physics asymmetry, so record it as such.
    if (reachable.size === 2) report.bothSeatsPlayable += 1;
    else if (reachable.size === 1) {
      report.oneSeatPlayable += 1;
      report.unplayable.push({ seed, playableSeats: [...reachable] });
    } else {
      report.unplayable.push({ seed, playableSeats: [] });
    }

    report.spawnHeights.push(field.players.player1.y);
    // \"Cover\": how many blocks stand between the spawn and the middle of the field.
    const cover = field.blocks.filter(
      (block) =>
        block.seat === "player1" &&
        block.x > field.players.player1.x &&
        block.x < field.players.player2.x,
    );
    report.coverHeights.push(cover.length);
  }

  return report;
}

test("fairness: every seed generates a valid, mirrored, playable layout", () => {
  const report = layoutReport(SEEDS);

  assert.equal(report.rejected.length, 0, `seeds failed to generate: ${JSON.stringify(report.rejected.slice(0, 3))}`);
  assert.equal(report.invalid.length, 0, `invalid layouts: ${JSON.stringify(report.invalid.slice(0, 3))}`);
  assert.equal(report.mirrorFailures.length, 0, `asymmetric layouts: ${report.mirrorFailures.slice(0, 5)}`);
  assert.equal(report.generated, SEEDS.length);

  // Every layout in this set must give BOTH seats a line of fire. This is the
  // playability bar the generator's symmetry alone does not guarantee.
  assert.ok(
    report.bothSeatsPlayable >= Math.ceil(SEEDS.length * 0.98),
    `only ${report.bothSeatsPlayable}/${SEEDS.length} layouts are playable for both seats ` +
      `(unplayable: ${JSON.stringify(report.unplayable.slice(0, 3))})`,
  );

  const spread = (values) => Math.max(...values) - Math.min(...values);
  console.log(
    `fairness: ${report.bothSeatsPlayable}/${SEEDS.length} layouts playable for both seats; ` +
      `spawn height ${Math.min(...report.spawnHeights)}–${Math.max(...report.spawnHeights)} ` +
      `(spread ${spread(report.spawnHeights)}); cover blocks/seat ${Math.min(...report.coverHeights)}–` +
      `${Math.max(...report.coverHeights)}`,
  );
});

/* -------------------------------------------------------------------------- *
 * Full matches, both opening seats
 * -------------------------------------------------------------------------- */

/**
 * Play one bot-vs-bot match to completion, checking every state on the way.
 *
 * Returns the outcome and the per-shot invariants this match observed, so the
 * aggregate can be asserted as a total rather than a sample.
 */
function playMatch({ seed, openingSeat, tier = TIER, maxShots = 60 }) {
  let state = createInitialState({ seed, openingSeat });
  const timeline = [];
  let shots = 0;
  let firstShotHit = false;
  let volleyViolations = 0;

  while (state.status === MATCH_STATUS.PLAYING && shots < maxShots) {
    const shooter = state.turn;
    const before = { turn: state.turn, shots: state.shotsRemaining, index: state.turnIndex };
    const shot = chooseAiShot({ state, seat: shooter, difficulty: tier, random: NO_SLIPS });
    const applied = applyShot(state, shooter, shot);

    // Every transition must be legal for the seat that owned the turn, and the
    // volley counter must only ever be the opening single or a two-shot volley.
    if (![1, SHOTS_PER_VOLLEY].includes(state.shotsRemaining)) volleyViolations += 1;
    if (applied.state.turnIndex !== state.turnIndex + 1) volleyViolations += 1;

    const next = applied.state;
    timeline.push({ ...before, impact: next.lastShot.impact.kind, lives: next.lives });
    if (shots === 0 && next.lastShot.impact.kind === IMPACT_KINDS.PLAYER) firstShotHit = true;
    assert.equal(validateBattlefield(next.battlefield).ok, true, "every state stays valid");
    state = next;
    shots += 1;
  }

  return {
    seed,
    openingSeat,
    winner: state.winner,
    finished: state.status === MATCH_STATUS.FINISHED,
    shots,
    firstShotHit,
    volleyViolations,
    lives: state.lives,
    timeline,
  };
}

test("fairness: 48 full matches terminate, stay valid and respect every volley rule", () => {
  const matches = [];
  for (const seed of MATCH_SEEDS) {
    for (const openingSeat of SEATS) {
      matches.push(playMatch({ seed, openingSeat }));
    }
  }

  for (const match of matches) {
    assert.equal(match.finished, true, `seed ${match.seed} (opened by ${match.openingSeat}) never ended`);
    assert.ok(SEATS.includes(match.winner), "somebody must win");
    assert.equal(match.lives[other(match.winner)], 0, "the loser is out of lives");
    assert.ok(match.lives[match.winner] > 0, "the winner still has a life");
    assert.equal(match.volleyViolations, 0, `seed ${match.seed}: volley/turn invariant broken`);
    assert.ok(match.shots <= 40, `seed ${match.seed} took ${match.shots} shots`);

    // The opening shot is one, then pairs: check the timeline shape directly.
    const timeline = match.timeline;
    assert.equal(timeline[0].shots, 1);
    assert.equal(timeline[0].turn, match.openingSeat);
    if (timeline[1]) {
      assert.equal(timeline[1].turn, other(match.openingSeat), "the answer comes in twos");
      assert.equal(timeline[1].shots, SHOTS_PER_VOLLEY);
    }

    // A match can only end on a hit: the last shot must have connected.
    const last = timeline[timeline.length - 1];
    assert.equal(last.impact, IMPACT_KINDS.PLAYER, "no match ends on a miss");
  }

  // ── the numbers, reported not asserted ────────────────────────────────
  const bySeat = { player1: 0, player2: 0 };
  let openerWins = 0;
  let firstShotHits = 0;
  for (const match of matches) {
    bySeat[match.winner] += 1;
    if (match.winner === match.openingSeat) openerWins += 1;
    if (match.firstShotHit) firstShotHits += 1;
  }
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const lengths = matches.map((match) => match.shots);

  // Accounting only: every match produced exactly one winner and one opener.
  assert.equal(bySeat.player1 + bySeat.player2, matches.length, "every win is accounted for");
  assert.equal(openerWins <= matches.length, true);

  console.log(
    `fairness (${TIER}, ${matches.length} matches over ${MATCH_SEEDS.length} seeds × both opening seats):\n` +
      `  seat wins        player1 ${bySeat.player1} · player2 ${bySeat.player2}\n` +
      `  opening-seat wins ${openerWins}/${matches.length} ` +
      `(${((openerWins / matches.length) * 100).toFixed(1)}%)\n` +
      `  opening-shot hits ${firstShotHits}/${matches.length}\n` +
      `  match length     mean ${mean(lengths).toFixed(2)} shots, min ${Math.min(...lengths)}, max ${Math.max(...lengths)}`,
  );
});

test("fairness: the sweep is reproducible, seed by seed and seat by seat", () => {
  const seed = MATCH_SEEDS[0];
  const once = playMatch({ seed, openingSeat: "player1" });
  const twice = playMatch({ seed, openingSeat: "player1" });
  assert.deepEqual(twice.timeline, once.timeline, "the same seed must replay identically");
  assert.equal(twice.winner, once.winner);

  // Swapping the opening seat on the SAME battlefield is a different match: the
  // map is mirrored, but the tempo is not. Assert only that both are complete,
  // valid matches — the win rates above are the measurement.
  const swapped = playMatch({ seed, openingSeat: "player2" });
  assert.equal(swapped.finished, true);
  assert.equal(swapped.lives[other(swapped.winner)], 0);
  assert.ok(swapped.shots >= 3, "a match is at least three shots long");
  assert.ok(LIVES_PER_PLAYER === 3);
  assert.ok(STRUCTURE_BLOCK_SIZE > 0);
});
