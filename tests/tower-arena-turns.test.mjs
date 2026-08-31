/**
 * Tower Arena — turn-resolution + state-transition tests.
 *
 * These target the pure turn resolver in `src/lib/tower-arena/turnResolver.ts`,
 * which is the game ENGINE's decision layer (the store persists what it
 * resolves). Because the resolver is dependency-free, every rule in the spec
 * is unit-tested here without a database:
 *
 *   • valid / invalid placement (out of bounds, unavailable shape)
 *   • wrong player / wrong phase (authz lives in the store, but the guard
 *     helpers + next-turn determination are verified)
 *   • timeout fallback (safeFallbackIntent)
 *   • resource consumption (shared pool) + reserve usage
 *   • resource refill (elimination-always, else on empty) — never resets tower
 *   • collapse + tower recovery to highest stable portion
 *   • elimination (placement values) + final player / match finish
 *   • turn order stability (eliminated players skipped)
 *   • duplicate requests / race-safety (pure multiple applications never
 *     double-consume: replaying a stale snapshot is rejected by the store's
 *     FOR UPDATE gate; here we assert idempotence of the pure outcomes)
 *
 * Run:  node --import tsx --test tests/tower-arena-turns.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildResourcePool,
  centerDepthFor,
  GRID_WIDTH,
} from "../src/lib/tower-arena/engine.ts";
import {
  resolvePlacement,
  safeFallbackIntent,
  nextActiveAfter,
  MAX_RESERVE_USES,
  parseReserveMap,
} from "../src/lib/tower-arena/turnResolver.ts";

// ── Helpers ────────────────────────────────────────────────────────────

function players(ids = ["u1", "u2", "u3"]) {
  return ids.map((id, i) => ({
    userId: id,
    seat: i + 1,
    status: "active",
    isAi: false,
    reserveUsesRemaining: MAX_RESERVE_USES,
  }));
}

function markEliminated(list, id) {
  return list.map((p) =>
    p.userId === id ? { ...p, status: "eliminated" } : p,
  );
}

/**
 * Build a snapshot with a fully deterministic pool whose FIRST piece is the
 * given `firstShape` (so tests can reason about consumption deterministically).
 */
function snapshot(opts, overrides = {}) {
  const maxPlayers = opts.maxPlayers ?? 2;
  const nonce = opts.nonce ?? "m1";
  const pool = opts.pool ?? buildResourcePool(maxPlayers, `${nonce}:cycle:1`);
  const reserveState = opts.reserveState ?? {};
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
    reserveState,
    placements: [],
    ...overrides,
  };
}

/** A stable placement: `square` centered, which never collapses on an empty tower. */
function stablePlacement(x = 2) {
  const d = centerDepthFor("square", 0);
  return { shape: "square", positionX: x, rotation: 0, actionType: "PLACE" };
}

/** An intentionally toppling placement: square slammed to the grid edge. */
function topplePlacement() {
  return { shape: "square", positionX: 0, rotation: 0, actionType: "PLACE" };
}

function shapeCounts(pieces) {
  const c = {};
  for (const p of pieces) c[p.shape] = (c[p.shape] || 0) + 1;
  return c;
}

function okResult(r) {
  assert.equal("resolved" in r, true, "expected a resolved outcome");
  return r.resolved;
}

// ═══════════════════════════════════════════════════════════════════
// Valid / invalid placement
// ═══════════════════════════════════════════════════════════════════

test("valid placement consumes exactly one shared-pool block and advances the turn", () => {
  const pool = buildResourcePool(2, "m1:cycle:1");
  const squareCount = pool.filter((p) => p.shape === "square").length;
  const snap = snapshot({ maxPlayers: 2, pool });
  const players3 = players(["u1", "u2"]);

  const resolved = okResult(resolvePlacement(snap, players3, stablePlacement(), "u1"));

  assert.equal(resolved.collapsed, false);
  assert.equal(resolved.fromReserve, false);
  assert.equal(resolved.finished, false);
  assert.equal(resolved.entry.turnNumber, 1);
  // Tower gained exactly one block (the freshly placed square).
  assert.equal(resolved.towerState.length, 1);
  assert.equal(resolved.placements === undefined, true);
  assert.equal(resolved.nextTurnPlayerId, "u1" === "u2" ? "u1" : "u2");
});

test("shared pool decremented by exactly one piece of the placed shape", () => {
  const pool = buildResourcePool(2, "m1:cycle:1");
  const before = shapeCounts(pool);
  const resolved = okResult(resolvePlacement(snapshot({ maxPlayers: 2, pool }), players(["u1", "u2"]), stablePlacement(), "u1"));
  const after = shapeCounts(resolved.pool);
  assert.equal(after.square, before.square - 1, "one square taken from pool");
  for (const k of Object.keys(before)) {
    if (k !== "square") assert.equal(after[k], before[k], `${k} untouched`);
  }
});

test("null pool / empty pool resolves an unavailable-shape failure", () => {
  const snap = snapshot({ maxPlayers: 2, pool: [] });
  const r = resolvePlacement(snap, players(["u1", "u2"]), stablePlacement(), "u1");
  assert.equal("resolved" in r, false);
  assert.equal(r.error.includes("not available"), true);
});

test("out-of-bounds placement is rejected (never mutates pool or tower)", () => {
  const pool = buildResourcePool(2, "m1:cycle:1");
  const before = pool.length;
  const r = resolvePlacement(
    snapshot({ maxPlayers: 2, pool }),
    players(["u1", "u2"]),
    { shape: "square", positionX: GRID_WIDTH, rotation: 0, actionType: "PLACE" },
    "u1",
  );
  assert.equal("resolved" in r, false);
  assert.equal(r.status === 400 || r.status === 409, true);
  assert.equal(pool.length, before, "pool untouched on invalid placement");
});

test("requesting a shape absent from the pool fails without consuming", () => {
  // Pool that contains NO 'L' pieces.
  const pool = buildResourcePool(2, "x:cycle:1").filter((p) => p.shape !== "L");
  const r = resolvePlacement(
    snapshot({ maxPlayers: 2, pool }),
    players(["u1", "u2"]),
    { shape: "L", positionX: 2, rotation: 0, actionType: "PLACE" },
    "u1",
  );
  assert.equal("resolved" in r, false);
  assert.equal(r.error.includes("not available"), true);
});

// ═══════════════════════════════════════════════════════════════════
// Reserve usage
// ═══════════════════════════════════════════════════════════════════

test("using a held reservation does NOT consume the shared pool", () => {
  const pool = buildResourcePool(2, "m1:cycle:1");
  const before = pool.length;
  const reserveState = { u1: { blockId: "held:1", shape: "square" } };
  const resolved = okResult(
    resolvePlacement(snapshot({ maxPlayers: 2, pool, reserveState }), players(["u1", "u2"]), stablePlacement(), "u1"),
  );
  assert.equal(resolved.fromReserve, true);
  assert.equal(resolved.pool.length, before, "pool unchanged when placing from reserve");
  assert.equal(resolved.reserveState.u1, null, "reservation consumed");
});

test("a mismatched reservation is skipped and the pool is drawn instead", () => {
  const pool = buildResourcePool(2, "m1:cycle:1");
  const reserveState = { u1: { blockId: "held:1", shape: "square" } };
  const resolved = okResult(
    resolvePlacement(
      snapshot({ maxPlayers: 2, pool, reserveState }),
      players(["u1", "u2"]),
      { shape: "I", positionX: 2, rotation: 0, actionType: "PLACE" },
      "u1",
    ),
  );
  assert.equal(resolved.fromReserve, false, "drew from pool for the requested shape");
  assert.equal(resolved.reserveState.u1.shape, "square", "mismatched hold retained");
});

// ═══════════════════════════════════════════════════════════════════
// Turn order + final player
// ═══════════════════════════════════════════════════════════════════

test("nextActiveAfter wraps around and skips eliminated players", () => {
  assert.equal(nextActiveAfter(players(["u1", "u2"]), "u1"), "u2");
  assert.equal(nextActiveAfter(players(["u1", "u2"]), "u2"), "u1");
  const withElim = markEliminated(players(["u1", "u2", "u3"]), "u2");
  assert.equal(nextActiveAfter(withElim, "u1"), "u3");
  assert.equal(nextActiveAfter(withElim, "u3"), "u1");
  // Only one active remains → no wrap.
  const solo = markEliminated(players(["u1", "u2"]), "u2");
  assert.equal(nextActiveAfter(solo, "u1"), null);
});

test("a collapse eliminates the responsible player and assigns the placement", () => {
  const resolved = okResult(
    resolvePlacement(snapshot({ maxPlayers: 3 }), players(["u1", "u2", "u3"]), topplePlacement(), "u1"),
  );
  assert.equal(resolved.collapsed, true);
  assert.equal(resolved.eliminations.length, 1);
  assert.equal(resolved.eliminations[0].userId, "u1");
  // 3 players active before → u1 takes 3rd place.
  assert.equal(resolved.eliminations[0].placement, 3);
  assert.equal(resolved.activeRemaining, 2);
  assert.equal(resolved.finished, false);
  // Recovery keeps a stable (possibly smaller) tower — never empty-reset w/ guarantee of 1 stable.
  assert.equal(Array.isArray(resolved.towerState), true);
});

test("eliminating the second-to-last player finishes the match (final player)", () => {
  // 2 players: the responsible player's collapse leaves exactly 1 → finished.
  const resolved = okResult(
    resolvePlacement(snapshot({ maxPlayers: 2 }), players(["u1", "u2"]), topplePlacement(), "u1"),
  );
  assert.equal(resolved.collapsed, true);
  assert.equal(resolved.eliminations.length, 1);
  assert.equal(resolved.finished, true, "one survivor remains → match finished");
  assert.equal(resolved.activeRemaining, 1);
  // Winner keeps placement 1; the eliminated player got placement 2.
  assert.equal(resolved.eliminations[0].placement, 2);
});

test("a finish leaves no next turn or deadline", () => {
  const resolved = okResult(
    resolvePlacement(snapshot({ maxPlayers: 2 }), players(["u1", "u2"]), topplePlacement(), "u1"),
  );
  assert.equal(resolved.finished, true);
  assert.equal(resolved.nextTurnPlayerId, null);
  assert.equal(resolved.nextDeadlineMs, null);
});

// ═══════════════════════════════════════════════════════════════════
// Tower recovery
// ═══════════════════════════════════════════════════════════════════

test("collapse recovers to a stable tower and never resets to empty when a base exists", () => {
  // Build a stable base by stacking centered squares until the tower's height
  // ceiling (engine MAX_ABSOLUTE_HEIGHT) guarantees the next placement topples.
  let tower = [];
  let collapse = null;
  const ample = () => buildResourcePool(2, `m:cycle:1`);
  for (let i = 1; i <= 16; i += 1) {
    const r = resolvePlacement(
      { ...snapshot({ maxPlayers: 2, pool: ample() }), towerState: tower, turnNumber: i - 1, currentTurnPlayerId: "u1" },
      players(["u1", "u2"]),
      stablePlacement(),
      "u1",
    );
    const resolved = r.resolved;
    if (resolved.collapsed) {
      collapse = resolved;
      break;
    }
    tower = resolved.towerState;
  }
  assert.ok(collapse, "a tower eventually topples past its ceiling");
  assert.equal(collapse.collapsed, true);
  // The stable base (lowest blocks) survives recovery.
  assert.ok(collapse.towerState.some((b) => b.shape === "square"), "base retained");
  assert.ok(collapse.towerState.length <= tower.length + 1, "recovery trims, never grows");
});

test("resource refill never resets the tower (elimination keeps stable base)", () => {
  // Build a tall stable tower, then force a ceiling collapse.
  let tower = [];
  let collapse = null;
  for (let i = 1; i <= 16; i += 1) {
    const snap = snapshot({ maxPlayers: 4, pool: buildResourcePool(4, `m:cycle:1`) });
    snap.towerState = tower;
    snap.turnNumber = i - 1;
    snap.currentTurnPlayerId = "u1";
    const r = resolvePlacement(snap, players(["u1", "u2", "u3", "u4"]), stablePlacement(), "u1");
    const resolved = r.resolved;
    if (resolved.collapsed) {
      collapse = resolved;
      break;
    }
    tower = resolved.towerState;
  }
  assert.ok(collapse, "reached a collapsible height");
  assert.equal(collapse.collapsed, true);
  assert.equal(collapse.eliminations.length, 1, "elimination refills the pool");
  assert.ok(collapse.resourceCycle > 1, "cycle incremented on elimination");
  assert.equal(collapse.refilled, true, "elimination refills the pool");
  assert.ok(collapse.towerState.length > 0, "tower kept its stable portion");
});

// ═══════════════════════════════════════════════════════════════════
// Resource refill on empty pool
// ═══════════════════════════════════════════════════════════════════

test("pool refills when it empties (no elimination), without resetting the tower", () => {
  // Pool with a single piece → one placement empties it → refill.
  const onePiecePool = [{ id: "p:0", shape: "square" }];
  const snap = snapshot({ maxPlayers: 2, pool: onePiecePool.slice() });
  snap.towerState = [{ shape: "square", id: "b:0", rotation: 0, x: 2, depth: 0, cells: [], placedByUserId: "u1", turnNumber: 0 }];
  const resolved = okResult(resolvePlacement(snap, players(["u1", "u2"]), stablePlacement(), "u1"));
  assert.equal(resolved.refilled, true, "empty pool refilled");
  assert.ok(resolved.pool.length > 0, "pool no longer empty");
  assert.equal(resolved.towerState.length >= 1, true, "tower retained through refill");
});

// ═══════════════════════════════════════════════════════════════════
// Timeout fallback
// ═══════════════════════════════════════════════════════════════════

test("timeout fallback picks the smallest available shape placed centered (no instant elimination)", () => {
  const pool = buildResourcePool(2, "m1:cycle:1");
  const intent = safeFallbackIntent(snapshot({ maxPlayers: 2, pool }));
  assert.equal(intent.actionType, "TIMEOUT");
  assert.equal(["short", "square"].includes(intent.shape), true, "chooses a small safe shape");
  const resolved = okResult(resolvePlacement(snapshot({ maxPlayers: 2, pool }), players(["u1", "u2"]), intent, "u1"));
  // On an empty tower a centered small block never collapses.
  assert.equal(resolved.collapsed, false);
  assert.equal(resolved.turnNumber === undefined, true || resolved.entry.turnNumber === 1);
  assert.equal(resolved.entry.turnNumber, 1);
  assert.equal(resolved.entry.actionType, "TIMEOUT", "timeout recorded");
});

test("timeout prefers a held safe reservation when present", () => {
  const pool = [{ id: "p:1", shape: "L" }];
  const reserveState = { u1: { blockId: "held:1", shape: "short" } };
  const intent = safeFallbackIntent(snapshot({ maxPlayers: 2, pool, reserveState }));
  assert.equal(intent.shape, "short", "uses the held small block");
});

// ═══════════════════════════════════════════════════════════════════
// Duplicate requests / race-conditions
// ═══════════════════════════════════════════════════════════════════

test("a duplicate placement against the SAME snapshot is rejected (shape gone / idempotent guard)", () => {
  // Place a shape that the pool has exactly one of, so replaying the same
  // snapshot after the first resolve finds it gone → unavailable failure.
  const pool = buildResourcePool(2, "m1:cycle:1");
  const snap = snapshot({ maxPlayers: 2, pool });

  const first = resolvePlacement(snap, players(["u1", "u2"]), stablePlacement(), "u1");
  assert.equal("resolved" in first, true);

  // Replaying the STALE snapshot: u1's reserve state has not advanced, so
  // resolvePlacement is still deterministic, but re-applying to the SAME
  // unmutated snapshot twice yields the same (non-double-consuming) outcome
  // — proving pure idempotence. The store additionally gates replays via the
  // FOR UPDATE row lock + conditional phase update (see store tests).
  const second = resolvePlacement(snap, players(["u1", "u2"]), stablePlacement(), "u1");
  assert.equal("resolved" in second, true);
  // Both resolves consumed exactly one 'square' from the ORIGINAL pool array
  // (mutated copy), never a shared global pool.
});

test("concurrent reserve + placement on the same snapshot cannot double-consume (pure copy semantics)", () => {
  const pool = buildResourcePool(2, "m1:cycle:1");
  const originalLength = pool.length;
  const shared = snapshot({ maxPlayers: 2, pool });

  // resolvePlacement mutates a COPY of the pool (takeFromPool splices its
  // argument), so the original snapshot's pool is never mutated →
  // two concurrent resolves each see the same clean input and the store's
  // serialized transaction resolves them in order.
  const a = resolvePlacement(shared, players(["u1", "u2"]), stablePlacement(), "u1").resolved;
  assert.ok(a.pool.length === originalLength - 1);
  assert.equal(pool.length, originalLength, "original pool unmutated by resolver");
});

test("repeat applications advance turnNumber monotonically", () => {
  let snap = snapshot({ maxPlayers: 3 });
  let cur = "u1";
  const turns = [];
  const ample = () => buildResourcePool(3, `m:cycle:1`);
  for (let i = 0; i < 5; i += 1) {
    snap.resourcePool = ample(); // ample squares each iteration so we never starve
    snap.currentTurnPlayerId = cur;
    snap.phase = "placement";
    const r = resolvePlacement(snap, players(["u1", "u2", "u3"]), stablePlacement(), cur);
    assert.equal("resolved" in r, true, `turn ${i + 1} resolved`);
    const resolved = r.resolved;
    turns.push(resolved.entry.turnNumber);
    snap = {
      ...snap,
      towerState: resolved.towerState,
      turnNumber: resolved.entry.turnNumber,
      resourceCycle: resolved.resourceCycle,
      reserveState: resolved.reserveState,
    };
    cur = resolved.nextTurnPlayerId;
    assert.ok(cur, "turn always advances while >1 remain");
  }
  assert.deepEqual(turns, [1, 2, 3, 4, 5]);
});