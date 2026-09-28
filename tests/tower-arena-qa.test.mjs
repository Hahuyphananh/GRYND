/**
 * Tower Arena — comprehensive QA + balancing pass (1v1).
 *
 *   • determinism — identical state + identical placement ⇒ identical result
 *   • match completion — the dropper is eliminated, the survivor takes 1st
 *   • payout correctness — payouts sum EXACTLY to the prize pool, never
 *     exceed it, house fee correct
 *   • client-cannot-fabricate — the engine never consults client-supplied
 *     winner/payout/tower cells; it recomputes cells & stability server-side
 *   • balance/duration — measured match lengths land near the target bands,
 *     and EVERY strategy (even maximally safe play) is bounded by the height
 *     ceiling + the limited shared pool.
 *
 * Matches are driven with the engine's OWN placement policy
 * (`safeFallbackIntent`), which is also what the timeout/AI paths use: it only
 * ever asks for a shape the pool actually holds, so a driven match can never
 * stall on an unavailable block.
 *
 * The DB-backed guards (FOR UPDATE row locks, conditional active→finished
 * update, escrow-once) are verified by inspection in the store; the pure
 * engine/resolver/payout invariants those guards protect are tested here.
 *
 * Tower Arena is strictly 1v1: there is one seat count to cover, the board is
 * eight columns wide, and the ceiling (not a void) is what ends a match.
 *
 * Run:  node --import tsx --test tests/tower-arena-qa.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildResourcePool,
  GRID_WIDTH,
  SEATS,
  CEILING_HEIGHT,
} from "../src/lib/tower-arena/engine.ts";
import {
  resolvePlacement,
  safeFallbackIntent,
  MAX_RESERVE_USES,
} from "../src/lib/tower-arena/turnResolver.ts";
import { computePotPrize, payoutsByPlacement } from "../src/lib/tower-arena/payout.ts";

/** The only supported seat count. */
const COUNTS = [SEATS];

function makePlayers(ids) {
  return ids.map((id, i) => ({
    userId: id,
    seat: i + 1,
    status: "active",
    isAi: false,
    reserveUsesRemaining: MAX_RESERVE_USES,
  }));
}

function snapshot(nonce, overrides = {}) {
  return {
    id: `m-${nonce}`,
    status: "active",
    phase: "placement",
    maxPlayers: SEATS,
    resourceCycle: 1,
    turnNumber: 0,
    currentTurnPlayerId: "u0",
    turnDeadline: null,
    resourcePool: buildResourcePool(`${nonce}:cycle:1`),
    towerState: [],
    reserveState: {},
    placements: [],
    ...overrides,
  };
}

function apply(state, players, res) {
  // Mirrors the store: eliminated players immediately persist their assigned
  // placement (the resolver skips taken slots on later eliminations).
  return {
    players: players.map((p) => {
      const e = res.eliminations.find((x) => x.userId === p.userId);
      return e ? { ...p, status: "eliminated", placement: e.placement } : p;
    }),
    state: {
      ...state,
      currentTurnPlayerId: res.nextTurnPlayerId,
      turnDeadline: res.nextDeadlineMs ? new Date(res.nextDeadlineMs).toISOString() : null,
      resourcePool: res.pool,
      towerState: res.towerState,
      reserveState: res.reserveState,
      resourceCycle: res.resourceCycle,
      turnNumber: res.entry.turnNumber,
      placements: [...state.placements, res.entry],
    },
  };
}

/**
 * Drive a 1v1 match to completion using the engine's own safe policy. The
 * deciding breach is a ceiling breach by the seat that could not fit another
 * block on the board.
 */
function driveToCompletion(nonce, maxTurns = 500) {
  let state = snapshot(nonce);
  let players = makePlayers(["u0", "u1"]);
  const eliminations = [];
  let finished = false;
  let doomedEntry = null;

  for (let i = 0; i < maxTurns; i += 1) {
    const actor = state.currentTurnPlayerId;
    const p = players.find((x) => x.userId === actor);
    assert.ok(p && p.status === "active", "current holder is an active participant");

    const r = resolvePlacement(state, players, safeFallbackIntent(state), actor);
    assert.ok("resolved" in r, `turn ${i + 1} resolves (the policy only asks for available shapes)`);
    for (const e of r.resolved.eliminations) {
      eliminations.push({ userId: e.userId, placement: e.placement });
    }
    if (r.resolved.collapsed) doomedEntry = r.resolved.entry;
    ({ players, state } = apply(state, players, r.resolved));
    if (r.resolved.finished) {
      finished = true;
      break;
    }
  }
  assert.equal(finished, true, "match reaches completion");
  const survivor = players.find((p) => p.status === "active");
  return {
    eliminations,
    survivor,
    placements: state.placements,
    doomedEntry,
    turns: state.placements.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Determinism
// ═══════════════════════════════════════════════════════════════════════

test("same state + same placement always produces an identical result (no randomness)", () => {
  for (const n of COUNTS) {
    const state = snapshot(`det-${n}`);
    const plist = makePlayers(["u0", "u1"]);
    const intent = { shape: "I", positionX: 2, rotation: 0, actionType: "PLACE" };

    const a = resolvePlacement(state, plist, intent, "u0");
    const b = resolvePlacement(state, plist, intent, "u0");
    assert.ok("resolved" in a && "resolved" in b, `n=${n} both resolve`);
    assert.deepEqual(a.resolved.towerState, b.resolved.towerState, `n=${n} identical tower`);
    assert.deepEqual(a.resolved.pool, b.resolved.pool, `n=${n} identical pool`);
    assert.equal(a.resolved.collapsed, b.resolved.collapsed, `n=${n} identical breach verdict`);
  }
});

test("two full identical matches produce identical final state (determinism end-to-end)", () => {
  for (const n of COUNTS) {
    const m1 = driveToCompletion(`twice-${n}`);
    const m2 = driveToCompletion(`twice-${n}`);
    assert.deepEqual(
      m1.placements.map((p) => p.blockId),
      m2.placements.map((p) => p.blockId),
      `n=${n} same placements`,
    );
    assert.deepEqual(m1.eliminations, m2.eliminations, `n=${n} same eliminations`);
    assert.equal(m1.survivor.userId, m2.survivor.userId, `n=${n} same survivor`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Client-cannot-fabricate
// ═══════════════════════════════════════════════════════════════════════

test("server recomputes tower cells; client-supplied cells/winner/payout are never trusted", () => {
  const state = snapshot("fab");
  const plist = makePlayers(["u0", "u1"]);

  // Client passes an arbitrary identity + a bogus `cells`/`winner`/`payout`.
  const intent = {
    shape: "square",
    positionX: 2,
    rotation: 0,
    actionType: "PLACE",
    cells: [{ x: 99, depth: 99, z: 99 }], // would-be fabricated tower cells
    winner: "u1",
    payout: 999999,
  };
  const r = resolvePlacement(state, plist, intent, "u0");
  assert.ok("resolved" in r);

  // The produced tower cells are derived from the shape/anchor — NOT the
  // client's `cells` (the server never trusts a supplied cells/winner/payout).
  const placedCells = r.resolved.towerState[0].cells;
  assert.notDeepEqual(placedCells, intent.cells, "client cells ignored");
  assert.deepEqual(placedCells[0], { x: 2, depth: 0, z: 1 }, "cells resolved from shape + drop column");

  // The resolver result carries no winner/payout the client could inject: the
  // winner is the sole survivor, and payout comes from the server math.
  assert.equal("winner" in r.resolved, false);
  assert.equal("payout" in r.resolved, false);

  // An out-of-bounds drop (client tries to aim past the aim range) is rejected.
  const oob = resolvePlacement(
    state,
    plist,
    { shape: "square", positionX: 99, rotation: 0, actionType: "PLACE" },
    "u0",
  );
  assert.equal("resolved" in oob, false);
});

// ═══════════════════════════════════════════════════════════════════════
// Match completion — the 1v1 elimination order
// ═══════════════════════════════════════════════════════════════════════

test("the ceiling-breach dropper takes 2nd and the other seat wins the duel", () => {
  for (const n of COUNTS) {
    const { eliminations, survivor } = driveToCompletion(`order-${n}`);
    assert.equal(eliminations.length, 1, `n=${n} exactly one elimination`);
    assert.equal(eliminations[0].placement, 2, `n=${n} the dropper is 2nd`);
    assert.ok(survivor, `n=${n} exactly one survivor (placement 1)`);
    assert.equal(survivor.status, "active");
    assert.notEqual(
      survivor.userId,
      eliminations[0].userId,
      "the survivor did not drop the doomed block",
    );
  }
});

test("the deciding elimination is a ceiling breach: the doomed block sits past the ceiling", () => {
  const { doomedEntry } = driveToCompletion("ceiling-check");
  assert.ok(doomedEntry, "the match ended on a collapse");
  assert.ok(doomedEntry.placedCells.length > 0, "the doomed block resolved cells");
  const zs = doomedEntry.placedCells.map((c) => c.z);
  // With every column already at the ceiling the block can only rest on top
  // of it — it never overlaps the standing stack, and its top crosses the line.
  assert.equal(Math.min(...zs), CEILING_HEIGHT + 1, "the block rests on top of the ceiling");
  assert.ok(Math.max(...zs) > CEILING_HEIGHT, "its top crosses the ceiling → elimination");
});

// ═══════════════════════════════════════════════════════════════════════
// Economy — payouts & house fee
// ═══════════════════════════════════════════════════════════════════════

test("economy: house fee correct; payouts sum exactly to the prize pool, never exceed it", () => {
  for (const n of COUNTS) {
    for (const w of [0, 10, 100, 137, 500]) {
      const cfg = computePotPrize({ wager: w });
      assert.equal(cfg.pot, n * w);
      assert.ok(cfg.houseFee >= 0 && cfg.houseFee <= cfg.pot);
      assert.equal(cfg.prizePool, cfg.pot - cfg.houseFee);

      const pays = payoutsByPlacement({ prizePool: cfg.prizePool });
      assert.equal(pays.length, n);
      assert.equal(pays.reduce((a, b) => a + b, 0), cfg.prizePool, `w=${w} credits == prize`);
      for (const p of pays) assert.ok(p >= 0 && p <= cfg.prizePool, `w=${w} payout in [0, prize]`);
    }
  }
});

test("economy: the 1v1 reference config pays the winner the whole 190 pool", () => {
  const cfg = computePotPrize({ wager: 100 });
  assert.deepEqual(payoutsByPlacement({ prizePool: cfg.prizePool }), [190, 0]);
});

test("final payouts map to placements from an actual completed match", () => {
  const { survivor, eliminations } = driveToCompletion("pay-1v1");
  const cfg = computePotPrize({ wager: 100 });
  const byPlacement = payoutsByPlacement({ prizePool: cfg.prizePool });

  const ranked = [...eliminations, { userId: survivor.userId, placement: 1 }].sort(
    (a, b) => a.placement - b.placement,
  );
  const paid = ranked.map((r) => byPlacement[Math.max(0, r.placement - 1)]);
  assert.equal(paid.length, 2);
  assert.equal(paid[0], cfg.prizePool, "the winner banks the whole pool");
  assert.equal(paid[1], 0, "the runner-up is paid nothing");
  assert.ok(paid[0] >= paid[1], "placement 1 paid >= 2");
  assert.equal(paid.reduce((a, b) => a + b, 0), cfg.prizePool);
});

// ═══════════════════════════════════════════════════════════════════════
// Balance / duration
// ═══════════════════════════════════════════════════════════════════════

// Players get a relaxed turn window (at least a minute); the sim paces
// placements at the real server cadence.
const TP_MS = 60000; // placement window (server)

test("balance: every strategy — even maximally safe play — is bounded by the ceiling", () => {
  // Regression guard for the retired "no ceiling" behaviour: safe play can no
  // longer stack forever. Eight columns × 24 cells is the hard cap, so a
  // match MUST finish within that budget.
  const budget = GRID_WIDTH * CEILING_HEIGHT + 10;
  const { turns, doomedEntry } = driveToCompletion("balance-1v1", budget + 50);
  assert.ok(
    turns <= budget,
    `safe play finished within the ${budget}-placement ceiling budget (got ${turns})`,
  );
  assert.ok(doomedEntry, "the match ended because the board ran out of room");
  // Wall clock stays inside a relaxed 30-minute band (turns × 60s window).
  assert.ok(((turns * TP_MS) / 60000) <= 30, `wall-clock bounded (${((turns * TP_MS) / 60000).toFixed(2)}min)`);
});
