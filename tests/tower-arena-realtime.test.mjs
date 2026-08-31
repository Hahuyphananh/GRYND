/**
 * Tower Arena — realtime / sync contract tests.
 *
 * The realtime layer broadcasts server-authoritative *signals* (lobby +
 * match events) and clients always reconcile by re-fetching the authoritative
 * `get-match` snapshot. Those guarantees rely on the pure transition engine:
 *   • only the current turn-holder's submission advances state
 *   • simultaneous / stale / duplicate submissions never double-consume
 *   • an expired deadline resolves via the deterministic fallback, not an
 *     instant elimination
 *   • an eliminated player can no longer act
 *   • a resource refill happens while clients are connected WITHOUT resetting
 *     the tower
 *   • elimination order → placement, sole survivor = 1st, match completion.
 *
 * Because the DB store + Socket.IO server aren't unit-testable here, these
 * tests drive the pure `turnResolver` through the same authz gates the store
 * enforces (current-turn-only, active-only, expired-deadline → fallback) and
 * assert the contract stays deterministic and idempotent for 2 and 6 "clients".
 *
 * Run:  node --import tsx --test tests/tower-arena-realtime.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildResourcePool } from "../src/lib/tower-arena/engine.ts";
import {
  resolvePlacement,
  safeFallbackIntent,
  MAX_RESERVE_USES,
} from "../src/lib/tower-arena/turnResolver.ts";
import { TOWER_ARENA_EVENTS } from "../src/lib/tower-arena/realtimeRelay.ts";

// ── Helpers ────────────────────────────────────────────────────────────

function makePlayers(ids) {
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

/** A square slammed to the grid edge — deterministically collapses. */
function topple() {
  return { shape: "square", positionX: 0, rotation: 0, actionType: "PLACE" };
}

function snapshot(opts = {}) {
  const maxPlayers = opts.maxPlayers ?? 2;
  const pool = opts.pool ?? buildResourcePool(maxPlayers, `${opts.nonce || "rx"}:cycle:1`);
  return {
    id: "m1",
    status: "active",
    phase: "placement",
    maxPlayers,
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

// Store-style authz gate shared by the tests: only the current ACTIVE turn
// holder's submission may advance state; everyone else's is discarded.
function step(state, plist, intent, actor) {
  if (actor !== state.currentTurnPlayerId) return { rejected: "not your turn" };
  const p = plist.find((x) => x.userId === actor);
  if (!p || p.status !== "active") return { rejected: "not an active participant" };
  const r = resolvePlacement(state, plist, intent, actor);
  if (!("resolved" in r)) return { rejected: r.error };
  return { next: r.resolved };
}

function applyResolved(state, plist, res) {
  const pl = plist.map((p) =>
    res.eliminations.some((e) => e.userId === p.userId)
      ? { ...p, status: "eliminated" }
      : p,
  );
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
 * Drive a match to completion where every current player topples (eliminates
 * themselves) in turn. Asserts the elimination-order → placement contract and
 * that a single survivor (placement 1) finishes the match.
 */
function driveSixClients() {
  const ids = ["u1", "u2", "u3", "u4", "u5", "u6"];
  let state = snapshot({ maxPlayers: 6 });
  let plist = makePlayers(ids);
  const eliminations = [];
  let finished = false;
  let guards = 0;

  for (let i = 0; i < 200; i += 1) {
    const actor = state.currentTurnPlayerId;
    const p = plist.find((x) => x.userId === actor);
    assert.ok(p && p.status === "active", "current holder is an active participant");

    // A non-current client must never advance the match.
    const intruder = plist.find((x) => x.userId !== actor && x.status === "active");
    if (intruder) {
      const g = step(state, plist, stable(), intruder.userId);
      assert.equal(g.rejected, "not your turn");
      guards += 1;
    }

    const res = ok(resolvePlacement(state, plist, topple(), actor));
    for (const e of res.eliminations) eliminations.push({ userId: e.userId, placement: e.placement });
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

// ── Two clients ────────────────────────────────────────────────────────

test("two clients: only the current hold is accepted; the match advances cleanly", () => {
  const state = snapshot({ maxPlayers: 2 });
  const plist = makePlayers(["u1", "u2"]);

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

// ── Six clients ────────────────────────────────────────────────────────

test("six clients: elimination order → placement, sole survivor = 1st, finishes", () => {
  const { eliminations, survivor, guards } = driveSixClients();
  // First toppled gets placement 6 … last gets 2; survivor implicitly 1.
  assert.deepEqual(
    eliminations.map((e) => e.placement),
    [6, 5, 4, 3, 2],
  );
  assert.equal(eliminations.length, 5);
  assert.ok(survivor, "exactly one survivor");
  assert.ok(guards > 0, "non-current clone submissions were discarded");
});

// ── Simultaneous stale requests / duplicate placement ─────────────────

test("simultaneous stale submissions cannot double-consume or double-advance", () => {
  const state = snapshot({ maxPlayers: 2 });
  const plist = makePlayers(["u1", "u2"]);

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
  const pool = buildResourcePool(2, "dup:cycle:1");
  const state = snapshot({ maxPlayers: 2, pool });
  const plist = makePlayers(["u1", "u2"]);
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
  const state = snapshot({ maxPlayers: 2 });
  const plist = makePlayers(["u1", "u2"]);

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
    maxPlayers: 2,
    overrides: { turnDeadline: new Date(Date.now() - 5000).toISOString() },
  });
  const plist = makePlayers(["u1", "u2"]);

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

test("placement after elimination: the eliminated player can no longer act", () => {
  const state = snapshot({ maxPlayers: 3 });
  const plist = makePlayers(["u1", "u2", "u3"]);

  // u1 topples → eliminated (placement 3), match continues with 2 active.
  const r = ok(resolvePlacement(state, plist, topple(), "u1"));
  assert.equal(r.eliminations[0].userId, "u1");
  assert.equal(r.finished, false);
  assert.equal(r.activeRemaining, 2);

  const plAfter = plist.map((p) => (p.userId === "u1" ? { ...p, status: "eliminated" } : p));
  const s1 = { ...state, currentTurnPlayerId: r.nextTurnPlayerId, towerState: r.towerState };

  // In the live match the eliminated player is no longer the current holder,
  // so their submission is discarded as not-their-turn.
  assert.equal(step(s1, plAfter, stable(), "u1").rejected, "not your turn");

  // Even if (defensively) the eliminated player were still tokenized as the
  // current holder, the active-participant gate rejects them.
  assert.equal(
    step({ ...s1, currentTurnPlayerId: "u1" }, plAfter, stable(), "u1").rejected,
    "not an active participant",
  );

  // A remaining active player continues normally.
  assert.equal(step(s1, plAfter, stable(), r.nextTurnPlayerId).rejected, undefined);
});

// ── Resource refill while clients are connected ────────────────────────

test("resource refill happens on pool-emptied while sessions stay connected — tower preserved", () => {
  // A single-square pool so the first placement empties it.
  const pool = [{ id: "one-square", shape: "square" }];
  const state = snapshot({ maxPlayers: 2, pool });
  const plist = makePlayers(["u1", "u2"]);

  const res = ok(resolvePlacement(state, plist, stable(), "u1"));
  assert.equal(res.refilled, true, "emptied pool triggers an immediate refill");
  assert.equal(res.resourceCycle, 2, "a fresh resource cycle begins");
  assert.ok(res.pool.length > 0, "the refill repopulates the shared pool");
  // The tower is NOT reset by a resource refill.
  assert.equal(res.towerState.length, 1, "placed block stays on the tower");
  assert.equal(res.nextPhase, "reserve", "a fresh cycle opens the reserve window");
});

// ── Match completion ───────────────────────────────────────────────────

test("match completion: finished clears turn/deadline and keeps a single winner", () => {
  const state = snapshot({ maxPlayers: 2 });
  const plist = makePlayers(["u1", "u2"]);
  const res = ok(resolvePlacement(state, plist, topple(), "u1"));
  assert.equal(res.finished, true);
  assert.equal(res.nextTurnPlayerId, null);
  assert.equal(res.nextDeadlineMs, null);
  assert.equal(res.eliminations[0].placement, 2); // responsible player last
  // Sole survivor holds placement 1 implicitly.
  assert.equal(res.activeRemaining, 1);
});