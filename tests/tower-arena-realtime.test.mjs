/**
 * Tower Arena — realtime / sync contract tests (1v1).
 *
 * The realtime layer broadcasts server-authoritative *signals* (lobby +
 * match events) and clients always reconcile by re-fetching the authoritative
 * `get-match` snapshot. Those guarantees rely on the pure transition engine:
 *   • only the current turn-holder's submission advances state
 *   • simultaneous / stale / duplicate submissions never double-consume
 *   • an expired deadline resolves via the deterministic fallback, not an
 *     instant elimination
 *   • the eliminated seat can no longer act
 *   • a resource refill happens while clients are connected WITHOUT resetting
 *     the tower
 *   • ceiling breach → placement, sole survivor = 1st, match completion.
 *
 * Because the DB store + Socket.IO server aren't unit-testable here, these
 * tests drive the pure `turnResolver` through the same authz gates the store
 * enforces (current-turn-only, active-only, expired-deadline → fallback) and
 * assert the contract stays deterministic and idempotent.
 *
 * Tower Arena is strictly 1v1, so the "N clients" sweeps are gone: there are
 * exactly two seats, and the ceiling ends the duel.
 *
 * Run:  node --import tsx --test tests/tower-arena-realtime.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildResourcePool,
  simulatePlacement,
  CEILING_HEIGHT,
  SEATS,
} from "../src/lib/tower-arena/engine.ts";
import {
  resolvePlacement,
  safeFallbackIntent,
  isReadyGateMet,
  MAX_RESERVE_USES,
} from "../src/lib/tower-arena/turnResolver.ts";
import { TOWER_ARENA_EVENTS } from "../src/lib/tower-arena/realtimeRelay.ts";

// ── Helpers ────────────────────────────────────────────────────────────

function makePlayers(ids = ["u1", "u2"]) {
  return ids.map((id, i) => ({
    userId: id,
    seat: i + 1,
    status: "active",
    isAi: false,
    reserveUsesRemaining: MAX_RESERVE_USES,
  }));
}

/** A square centered — stable on an empty/grounded tower. */
function stable() {
  return { shape: "square", positionX: 2, rotation: 0, actionType: "PLACE" };
}

/** A tower with a single 1-cell pillar of `n` cubes at column 0. */
function pillarTower(n = 2, x = 0) {
  let t = [];
  for (let i = 1; i <= n; i += 1) {
    t = simulatePlacement(t, {
      shape: "short",
      x,
      rotation: 0,
      blockId: `pre:${i}`,
      placedByUserId: "u1",
      turnNumber: i,
    }).tower;
  }
  return t;
}

/** A tower whose column `x` already sits at the ceiling (the next drop breaches). */
function ceilingTower(x = 2) {
  return pillarTower(CEILING_HEIGHT, x);
}

function snapshot(opts = {}) {
  const nonce = opts.nonce || "rx";
  const pool = opts.pool ?? buildResourcePool(`${nonce}:cycle:1`);
  return {
    id: "m1",
    status: "active",
    phase: "placement",
    maxPlayers: SEATS,
    resourceCycle: 1,
    turnNumber: 0,
    currentTurnPlayerId: "u1",
    turnDeadline: null,
    resourcePool: pool,
    towerState: [],
    reserveState: {},
    placements: [],
    ...opts.overrides,
  };
}

function ok(r) {
  assert.equal("resolved" in r, true, "expected a resolved outcome");
  return r.resolved;
}

// Store-style authz gate shared by the tests: the match must still be in
// placement, and only the current ACTIVE turn holder's submission may advance
// state; everyone else's is discarded.
function step(state, plist, intent, actor) {
  if (state.status !== "active" || state.phase !== "placement") {
    return { rejected: "match is not active" };
  }
  if (actor !== state.currentTurnPlayerId) return { rejected: "not your turn" };
  const p = plist.find((x) => x.userId === actor);
  if (!p || p.status !== "active") return { rejected: "not an active participant" };
  const r = resolvePlacement(state, plist, intent, actor);
  if (!("resolved" in r)) return { rejected: r.error };
  return { next: r.resolved };
}

function applyResolved(state, plist, res) {
  // Mirrors the store: eliminated players immediately persist their assigned
  // placement.
  const pl = plist.map((p) => {
    const e = res.eliminations.find((x) => x.userId === p.userId);
    return e ? { ...p, status: "eliminated", placement: e.placement } : p;
  });
  return {
    players: pl,
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
 * Drive a 1v1 match to completion with the engine's own safe policy (which
 * only ever asks for a shape the pool holds). Asserts that a non-current
 * client can never advance the match, and that the loser takes 2nd.
 */
function driveTwoClients(maxTurns = 500) {
  let state = snapshot();
  let plist = makePlayers();
  const eliminations = [];
  let finished = false;
  let guards = 0;

  for (let i = 0; i < maxTurns; i += 1) {
    const actor = state.currentTurnPlayerId;
    const p = plist.find((x) => x.userId === actor);
    assert.ok(p && p.status === "active", "current holder is an active participant");

    // The other seat must never advance the match.
    const intruder = plist.find((x) => x.userId !== actor && x.status === "active");
    if (intruder) {
      const g = step(state, plist, stable(), intruder.userId);
      assert.equal(g.rejected, "not your turn");
      guards += 1;
    }

    const res = ok(resolvePlacement(state, plist, safeFallbackIntent(state), actor));
    for (const e of res.eliminations) {
      eliminations.push({ userId: e.userId, placement: e.placement });
    }
    ({ players: plist, state } = applyResolved(state, plist, res));
    if (res.finished) {
      finished = true;
      break;
    }
  }

  assert.equal(finished, true, "match reaches completion");
  return { eliminations, survivor: plist.find((p) => p.status === "active"), guards };
}

// ── Event taxonomy ─────────────────────────────────────────────────────

test("realtime event names are defined and cover the spec's events", () => {
  const expected = [
    "tower_arena_state",
    "tower_arena_turn_started",
    "tower_arena_resource_update",
    "tower_arena_reserve_phase",
    "tower_arena_block_placed",
    "tower_arena_collapse",
    "tower_arena_player_eliminated",
    "tower_arena_resource_refill",
    "tower_arena_match_finished",
  ];
  const eventValues = Object.values(TOWER_ARENA_EVENTS);
  for (const name of expected) {
    assert.ok(eventValues.includes(name), `event defined: ${name}`);
  }
});

// ── Ready gate (pre-game) ─────────────────────────────────────────────

test("ready gate: both humans must ready up; the AI seat is always ready", () => {
  const human = (ready) => ({
    userId: "u1",
    seat: 1,
    status: "active",
    isAi: false,
    reserveUsesRemaining: MAX_RESERVE_USES,
    ready,
  });
  const bot = {
    userId: "AI_BOT_2",
    seat: 2,
    status: "active",
    isAi: true,
    reserveUsesRemaining: MAX_RESERVE_USES,
    ready: true,
  };

  // Both humans ready → gate met.
  assert.equal(isReadyGateMet([human(true), human(true)]), true);
  // One human not ready → gate not met.
  assert.equal(isReadyGateMet([human(true), human(false)]), false);
  assert.equal(isReadyGateMet([human(false), human(false)]), false);
  // Empty roster is never "all ready".
  assert.equal(isReadyGateMet([]), false);
  // The bot counts as ready without a click (human-vs-bot free play).
  assert.equal(isReadyGateMet([human(true), bot]), true);
  assert.equal(isReadyGateMet([human(false), bot]), false);
  // Eliminated players do not participate in the gate.
  assert.equal(
    isReadyGateMet([{ ...human(false), status: "eliminated" }, human(true), bot]),
    true,
  );
});

// ── Two clients ────────────────────────────────────────────────────────

test("two clients: only the current holder is accepted; the match advances cleanly", () => {
  const state = snapshot();
  const plist = makePlayers();

  // u2 tries while it is u1's turn → discarded.
  assert.equal(step(state, plist, stable(), "u2").rejected, "not your turn");

  // u1 (current holder) places a stable block → advances to u2.
  const a = step(state, plist, stable(), "u1");
  assert.equal("next" in a, true);
  assert.equal(a.next.nextTurnPlayerId, "u2");
  assert.equal(a.next.collapsed, false);
  const s1 = applyResolved(state, plist, a.next).state;
  assert.equal(s1.currentTurnPlayerId, "u2");

  // u1's identical submission against the STALE snapshot is rejected.
  assert.equal(step(s1, plist, stable(), "u1").rejected, "not your turn");
  // u2 (the live current holder) may now act.
  assert.equal(step(s1, plist, stable(), "u2").rejected, undefined);
});

test("a full 1v1 match: the breach dropper is 2nd, the other seat survives, intruders never advance it", () => {
  const { eliminations, survivor, guards } = driveTwoClients();
  assert.equal(eliminations.length, 1, "exactly one elimination ends the duel");
  assert.equal(eliminations[0].placement, 2, "the dropper takes 2nd");
  assert.ok(survivor, "exactly one survivor (placement 1)");
  assert.equal(survivor.status, "active");
  assert.notEqual(survivor.userId, eliminations[0].userId);
  assert.ok(guards > 0, "non-current seat submissions were discarded");
});

// ── Simultaneous stale requests / duplicate placement ─────────────────

test("simultaneous stale submissions cannot double-consume or double-advance", () => {
  const state = snapshot();
  const plist = makePlayers();

  // Two racing clients: u1 (current) and u2 (intruder) both submit from the
  // same snapshot. Only u1 is accepted; u2's is discarded.
  const accepted = step(state, plist, stable(), "u1");
  const intruder = step(state, plist, stable(), "u2");
  assert.equal("next" in accepted, true);
  assert.equal(intruder.rejected, "not your turn");

  // Applying the accepted move advances the turn exactly once.
  const s1 = applyResolved(state, plist, accepted.next).state;
  assert.equal(s1.currentTurnPlayerId, "u2");
  assert.equal(s1.turnNumber, 1);
  assert.equal(s1.placements.length, 1);

  // Re-submitting u1's stale intent against the advanced snapshot is rejected.
  assert.equal(step(s1, plist, stable(), "u1").rejected, "not your turn");
});

test("duplicate / stale submissions never double-consume or double-advance", () => {
  const pool = buildResourcePool("dup:cycle:1");
  const state = snapshot({ pool });
  const plist = makePlayers();
  const originalLength = pool.length;

  // First submission consumes from a COPY — the original snapshot pool is
  // never mutated, so no shared pool can be double-consumed by a racing resolve.
  const first = ok(resolvePlacement(state, plist, stable(), "u1"));
  assert.equal(pool.length, originalLength, "original pool untouched by resolve");

  // The committed state (store row) advanced the turn to u2. A replayed
  // duplicate by u1 is now rejected by the turn gate — the store's idempotent
  // guard analog — and can neither re-consume nor re-advance.
  const s1 = applyResolved(state, plist, first).state;
  const dup = step(s1, plist, stable(), "u1");
  assert.equal(dup.rejected, "not your turn");
  assert.equal(s1.turnNumber, 1);
  assert.equal(s1.placements.length, 1);
});

// ── Reconnect reconciliation ───────────────────────────────────────────

test("reconnect: reconnected client reconciles to authoritative state, never stale", () => {
  const state = snapshot();
  const plist = makePlayers();

  // Server processed u1's move: authoritative state now on u2.
  const a = step(state, plist, stable(), "u1");
  const authoritative = applyResolved(state, plist, a.next).state;

  // A client that held the stale snapshot submits for u1 after reconnecting.
  // The authoritative gate rejects it (u2 is the current holder).
  assert.equal(step(authoritative, plist, stable(), "u1").rejected, "not your turn");
  // The authoritative snapshot reflects the correct next turn + a placed block.
  assert.equal(authoritative.currentTurnPlayerId, "u2");
  assert.equal(authoritative.towerState.length, 1);
});

// ── Placement after timer expiry ───────────────────────────────────────

test("placement after timer expiry uses deterministic fallback, not instant elimination", () => {
  const state = snapshot({
    overrides: { turnDeadline: new Date(Date.now() - 5000).toISOString() },
  });
  const plist = makePlayers();

  // The human's PLACE is no longer accepted once the window has expired
  // (store gate: turn expired → safe fallback settles it first). We model the
  // expiry gate explicitly.
  const humanLate = (() => {
    if (state.turnDeadline && new Date(state.turnDeadline).getTime() <= Date.now()) {
      return { rejected: "turn expired" };
    }
    return step(state, plist, stable(), "u1");
  })();
  assert.equal(humanLate.rejected, "turn expired");

  // Server applies the deterministic safe fallback on the current player's
  // behalf — smallest safe shape, centered, no rotation — and advances.
  const fallback = safeFallbackIntent(state);
  const res = ok(resolvePlacement(state, plist, fallback, "u1"));
  assert.equal(res.collapsed, false, "fallback is the safe small block, never insta-eliminate");
  assert.equal(res.nextTurnPlayerId, "u2");
  assert.equal(res.entry.turnNumber, 1);
});

// ── Placement after elimination ────────────────────────────────────────

test("after the breach the losing seat can no longer act (the duel is over)", () => {
  const state = snapshot({ overrides: { towerState: ceilingTower(2) } });
  const plist = makePlayers();

  // u1's block crosses the ceiling → eliminated (placement 2) → match over.
  const r = ok(
    resolvePlacement(
      state,
      plist,
      { shape: "short", positionX: 2, rotation: 0, actionType: "PLACE" },
      "u1",
    ),
  );
  assert.equal(r.eliminations[0].userId, "u1");
  assert.equal(r.eliminations[0].placement, 2);
  assert.equal(r.finished, true);
  assert.equal(r.activeRemaining, 1);
  assert.equal(r.nextTurnPlayerId, null, "no turn is handed over");

  const plAfter = plist.map((p) =>
    p.userId === "u1" ? { ...p, status: "eliminated", placement: 2 } : p,
  );
  // The store flips the row to finished as part of the finishing placement.
  const s1 = {
    ...state,
    status: "finished",
    phase: "finished",
    currentTurnPlayerId: r.nextTurnPlayerId,
    towerState: r.towerState,
  };

  // No seat may act once the match is finished — every submission is rejected,
  // including one aimed at the losing seat.
  assert.equal(
    step({ ...s1, currentTurnPlayerId: "u1" }, plAfter, stable(), "u1").rejected,
    "match is not active",
  );
  assert.equal(
    step({ ...s1, currentTurnPlayerId: "u2" }, plAfter, stable(), "u2").rejected,
    "match is not active",
  );
  // And with the row still nominally active, the eliminated seat is gated too.
  assert.equal(
    step({ ...state, currentTurnPlayerId: "u1" }, plAfter, stable(), "u1").rejected,
    "not an active participant",
  );
});

// ── Resource refill while clients are connected ────────────────────────

test("resource refill happens on pool-emptied while sessions stay connected — tower preserved", () => {
  // A single-square pool so the first placement empties it.
  const pool = [{ id: "one-square", shape: "square" }];
  const state = snapshot({ pool });
  const plist = makePlayers();

  const res = ok(resolvePlacement(state, plist, stable(), "u1"));
  assert.equal(res.refilled, true, "emptied pool triggers an immediate refill");
  assert.equal(res.resourceCycle, 2, "a fresh resource cycle begins");
  assert.ok(res.pool.length > 0, "the refill repopulates the shared pool");
  // The tower is NOT reset by a resource refill.
  assert.equal(res.towerState.length, 1, "placed block stays on the tower");
  assert.equal(res.nextPhase, "placement", "play continues in the placement phase");
});

// ── Match completion ───────────────────────────────────────────────────

test("match completion: finished clears turn/deadline and keeps a single winner", () => {
  const state = snapshot({ overrides: { towerState: ceilingTower(2) } });
  const plist = makePlayers();
  const res = ok(
    resolvePlacement(
      state,
      plist,
      { shape: "short", positionX: 2, rotation: 0, actionType: "PLACE" },
      "u1",
    ),
  );
  assert.equal(res.finished, true);
  assert.equal(res.nextTurnPlayerId, null);
  assert.equal(res.nextDeadlineMs, null);
  assert.equal(res.eliminations[0].placement, 2); // responsible player last
  // Sole survivor holds placement 1 implicitly.
  assert.equal(res.activeRemaining, 1);
  // The tower is trimmed to a coherent stack (first elimination keeps the
  // bottom half), never left with floating cells.
  assert.ok(res.towerState.length > 0 && res.towerState.length < CEILING_HEIGHT);
});
