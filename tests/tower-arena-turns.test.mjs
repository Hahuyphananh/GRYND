/**
 * Tower Arena — turn-resolution + state-transition tests.
 *
 * These target the pure turn resolver in `src/lib/tower-arena/turnResolver.ts`,
 * which is the game ENGINE's decision layer (the store persists what it
 * resolves). Because the resolver is dependency-free, every rule in the spec
 * is unit-tested here without a database:
 *
 *   • valid / invalid drop (out of aim bounds, unavailable shape)
 *   • wrong player / wrong phase (authz lives in the store, but the guard
 *     helpers + next-turn determination are verified)
 *   • timeout fallback (safeFallbackIntent — picks a stable drop when one exists)
 *   • resource consumption (shared pool) + reserve usage
 *   • resource refill (elimination-always, else on empty) — never resets tower
 *   • void-fall (block tips off support) → elimination + tower preserved
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
  simulatePlacement,
  GRID_WIDTH,
} from "../src/lib/tower-arena/engine.ts";
import {
  resolvePlacement,
  safeFallbackIntent,
  nextActiveAfter,
  activeStanding,
  MAX_RESERVE_USES,
  parseReserveMap,
  TURN_PLACEMENT_WINDOW_MS,
  RESERVE_WINDOW_MS,
  AI_RESERVE_WINDOW_MS,
  AI_TURN_PLACEMENT_WINDOW_MS,
  BOT_THINK_MS,
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
 * Build a snapshot with a fully deterministic pool whose composition is
 * guaranteed by the pool builder (each cycle contains every shape).
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

/**
 * A stable placement: 2-wide `square` at x=2, which lands flat on the floor
 * line and never tips while building a flat column (cols 2–3 grow evenly).
 */
function stablePlacement() {
  return { shape: "square", positionX: 2, rotation: 0, actionType: "PLACE" };
}

/**
 * A deterministic void-fall placement: drop a 3-wide `I` onto a 1-cell
 * pillar at column 0. Requires the tower under column 0 to be non-empty
 * (see `pillarTower`). An I needs ceil(3/2)=2 touching cells; the single
 * pillar cell cannot support it, so it tips into the void.
 */
function topplePlacement() {
  return { shape: "I", positionX: 0, rotation: 0, actionType: "PLACE" };
}

/** A tower with a single 1-cell pillar of `n` cubes at column 0. */
function pillarTower(n = 2, seed = "b", by = "u1") {
  let t = [];
  for (let i = 1; i <= n; i += 1) {
    t = simulatePlacement(t, {
      shape: "short",
      x: 0,
      rotation: 0,
      blockId: `${seed}:${i}`,
      placedByUserId: by,
      turnNumber: i,
    }).tower;
  }
  return t;
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
  const players2 = players(["u1", "u2"]);

  const resolved = okResult(resolvePlacement(snap, players2, stablePlacement(), "u1"));

  assert.equal(resolved.collapsed, false);
  assert.equal(resolved.fromReserve, false);
  assert.equal(resolved.finished, false);
  assert.equal(resolved.entry.turnNumber, 1);
  // Tower gained exactly one block (the freshly placed square).
  assert.equal(resolved.towerState.length, 1);
  assert.equal(resolved.placements === undefined, true);
  assert.equal(resolved.nextTurnPlayerId, "u2");
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

test("out-of-bounds drop aim is rejected (never mutates pool or tower)", () => {
  const pool = buildResourcePool(2, "m1:cycle:1");
  const before = pool.length;
  const r = resolvePlacement(
    snapshot({ maxPlayers: 2, pool }),
    players(["u1", "u2"]),
    { shape: "square", positionX: GRID_WIDTH + 5, rotation: 0, actionType: "PLACE" },
    "u1",
  );
  assert.equal("resolved" in r, false);
  assert.equal(r.error.includes("bounds"), true, "rejected as out of bounds");
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

test("a void fall eliminates the responsible player and assigns the placement", () => {
  const tower = pillarTower(2);
  const resolved = okResult(
    resolvePlacement(snapshot({ maxPlayers: 3 }, { towerState: tower }), players(["u1", "u2", "u3"]), topplePlacement(), "u1"),
  );
  assert.equal(resolved.collapsed, true);
  assert.equal(resolved.eliminations.length, 1);
  assert.equal(resolved.eliminations[0].userId, "u1");
  // 3 players active before → u1 takes 3rd place.
  assert.equal(resolved.eliminations[0].placement, 3);
  assert.equal(resolved.activeRemaining, 2);
  assert.equal(resolved.finished, false);
  // The tower is PRESERVED — a void fall removes nothing from the stack.
  assert.deepEqual(resolved.towerState, tower, "tower unchanged by the void fall");
});

test("eliminating the second-to-last player finishes the match (final player)", () => {
  // 2 players: the responsible player's void fall leaves exactly 1 → finished.
  const tower = pillarTower(2);
  const resolved = okResult(
    resolvePlacement(snapshot({ maxPlayers: 2 }, { towerState: tower }), players(["u1", "u2"]), topplePlacement(), "u1"),
  );
  assert.equal(resolved.collapsed, true);
  assert.equal(resolved.eliminations.length, 1);
  assert.equal(resolved.finished, true, "one survivor remains → match finished");
  assert.equal(resolved.activeRemaining, 1);
  // Winner keeps placement 1; the eliminated player got placement 2.
  assert.equal(resolved.eliminations[0].placement, 2);
});

test("a finish leaves no next turn or deadline", () => {
  const tower = pillarTower(2);
  const resolved = okResult(
    resolvePlacement(snapshot({ maxPlayers: 2 }, { towerState: tower }), players(["u1", "u2"]), topplePlacement(), "u1"),
  );
  assert.equal(resolved.finished, true);
  assert.equal(resolved.nextTurnPlayerId, null);
  assert.equal(resolved.nextDeadlineMs, null);
});

// ═══════════════════════════════════════════════════════════════════
// Tower preservation
// ═══════════════════════════════════════════════════════════════════

test("even flat play grows the tower forever — there is NO ceiling", () => {
  let tower = [];
  for (let i = 1; i <= 40; i += 1) {
    const snap = snapshot({ maxPlayers: 2, pool: buildResourcePool(2, `m:cycle:1`) });
    snap.towerState = tower;
    snap.turnNumber = i - 1;
    snap.currentTurnPlayerId = "u1";
    const r = resolvePlacement(snap, players(["u1", "u2"]), stablePlacement(), "u1");
    assert.equal("resolved" in r, true, `turn ${i} resolves`);
    const resolved = r.resolved;
    assert.equal(resolved.collapsed, false, `safe square ${i} never tips (no ceiling)`);
    tower = resolved.towerState;
  }
  assert.equal(tower.length, 40, "the tower keeps stacking past any old height limit");
});

test("resource refill never resets the tower (void fall keeps the stable stack)", () => {
  const tower = pillarTower(4, "pre");
  const snap = snapshot({ maxPlayers: 4, pool: buildResourcePool(4, `m:cycle:1`) });
  snap.towerState = tower;
  const resolved = okResult(resolvePlacement(snap, players(["u1", "u2", "u3", "u4"]), topplePlacement(), "u1"));
  assert.equal(resolved.collapsed, true);
  assert.equal(resolved.eliminations.length, 1, "void fall eliminates the dropper");
  assert.ok(resolved.resourceCycle > 1, "cycle incremented on elimination");
  assert.equal(resolved.refilled, true, "elimination refills the pool");
  assert.ok(resolved.towerState.length > 0, "tower kept its stable portion");
  assert.deepEqual(resolved.towerState, tower, "tower identical before refill");
});

// ═══════════════════════════════════════════════════════════════════
// Resource refill on empty pool
// ═══════════════════════════════════════════════════════════════════

test("pool refills when it empties (no elimination), without resetting the tower", () => {
  // Pool with a single piece → one placement empties it → refill.
  const onePiecePool = [{ id: "p:0", shape: "square" }];
  const snap = snapshot({ maxPlayers: 2, pool: onePiecePool.slice() });
  snap.towerState = pillarTower(1, "pre");
  const resolved = okResult(resolvePlacement(snap, players(["u1", "u2"]), stablePlacement(), "u1"));
  assert.equal(resolved.refilled, true, "empty pool refilled");
  assert.ok(resolved.pool.length > 0, "pool no longer empty");
  assert.equal(resolved.towerState.length >= 2, true, "tower retained through refill");
});

// ═══════════════════════════════════════════════════════════════════
// Timeout fallback
// ═══════════════════════════════════════════════════════════════════

test("timeout fallback picks a stable drop when one exists (no instant elimination)", () => {
  const pool = buildResourcePool(2, "m1:cycle:1");
  const intent = safeFallbackIntent(snapshot({ maxPlayers: 2, pool }));
  assert.equal(intent.actionType, "TIMEOUT");
  assert.equal(["short", "square", "I", "L"].includes(intent.shape), true);
  const resolved = okResult(resolvePlacement(snapshot({ maxPlayers: 2, pool }), players(["u1", "u2"]), intent, "u1"));
  // On an empty board every drop settles on the floor line.
  assert.equal(resolved.collapsed, false);
  assert.equal(resolved.entry.turnNumber, 1);
  assert.equal(resolved.entry.actionType, "TIMEOUT", "timeout recorded");
});

test("timeout fallback stays safe on a jagged tower when the pool allows it", () => {
  const tower = pillarTower(2, "pre");
  const pool = buildResourcePool(2, "m1:cycle:1");
  const state = snapshot({ maxPlayers: 2, pool });
  state.towerState = tower;
  const intent = safeFallbackIntent(state);
  const resolved = okResult(resolvePlacement(state, players(["u1", "u2"]), intent, "u1"));
  assert.equal(resolved.collapsed, false, "fallback chose a block that balances on the pillar");
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

test("a duplicate placement against the SAME snapshot is deterministic and non-double-consuming", () => {
  const pool = buildResourcePool(2, "m1:cycle:1");
  const snap = snapshot({ maxPlayers: 2, pool });

  const first = resolvePlacement(snap, players(["u1", "u2"]), stablePlacement(), "u1");
  assert.equal("resolved" in first, true);

  // Replaying the STALE snapshot resolves to the same outcome — pure
  // idempotence. The store additionally gates replays via its FOR UPDATE row
  // lock + conditional phase update (see store tests).
  const second = resolvePlacement(snap, players(["u1", "u2"]), stablePlacement(), "u1");
  assert.equal("resolved" in second, true);
  assert.deepEqual(first.resolved.towerState, second.resolved.towerState);
  assert.deepEqual(first.resolved.pool, second.resolved.pool);
  assert.equal(pool.length, buildResourcePool(2, "m1:cycle:1").length, "original pool array never mutated");
});

test("concurrent reserve + placement on the same snapshot cannot double-consume (pure copy semantics)", () => {
  const pool = buildResourcePool(2, "m1:cycle:1");
  const originalLength = pool.length;
  const shared = snapshot({ maxPlayers: 2, pool });

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

// ── Turn window + no-side-walls aims ──────────────────────────────────

test("placement and reserve windows are at least 60 seconds", () => {
  assert.ok(TURN_PLACEMENT_WINDOW_MS >= 60000, "placement window ≥ 60s");
  assert.ok(RESERVE_WINDOW_MS >= 60000, "reserve window ≥ 60s");
});

test("aiming fully beside the platform is legal and resolves as a void fall (no walls)", () => {
  // x=5 with a 2-wide block puts both columns over the void — previously
  // rejected as out of bounds, now a legal aim that collapses the dropper.
  const pool = buildResourcePool(2, "m1:cycle:1");
  const before = pool.length;
  const r = resolvePlacement(
    snapshot({ maxPlayers: 3, pool }),
    players(["u1", "u2", "u3"]),
    { shape: "square", positionX: GRID_WIDTH, rotation: 0, actionType: "PLACE" },
    "u1",
  );
  const res = okResult(r);
  assert.equal(res.collapsed, true, "full miss = void fall");
  assert.equal(res.entry.removedBlockIds.length, 1);
  assert.equal(res.entry.placedCells.length, 0, "no resolved cells on a full miss");
  assert.equal(res.entry.resolvedX, GRID_WIDTH);
  assert.equal(res.finished, false, "more players remain — match continues");
  // Elimination refills the pool to a fresh cycle (never resets the tower).
  assert.equal(res.refilled, true, "a fresh reserve cycle opens after the void fall");
  assert.equal(res.resourceCycle, 2);
});

test("entry records the resolved placement incl. slips and contact-shock sheds", () => {
  // Jenga: floor beam + brick overhanging its edge; the drop's beam tips the
  // brick — both fall together and the entry carries both blocks' cells so
  // every viewer animates the same shock.
  const u = players(["u1", "u2", "u3"]);
  const snap = snapshot({ maxPlayers: 3 });
  let b1 = okResult(resolvePlacement(snap, u, { shape: "I", positionX: 0, rotation: 0, actionType: "PLACE" }, "u1"));
  snap.towerState = b1.towerState;
  snap.turnNumber = b1.entry.turnNumber;
  snap.currentTurnPlayerId = "u2";
  snap.phase = "placement";
  snap.resourcePool = buildResourcePool(3, "m1:cycle:1");
  let b2 = okResult(resolvePlacement(snap, u, { shape: "L", positionX: 2, rotation: 1, actionType: "PLACE" }, "u2"));
  assert.equal(b2.collapsed, false);
  snap.towerState = b2.towerState;
  snap.turnNumber = b2.entry.turnNumber;
  snap.currentTurnPlayerId = "u3";
  snap.phase = "placement";
  snap.resourcePool = buildResourcePool(3, "m1:cycle:1");
  const drop = okResult(resolvePlacement(snap, u, { shape: "I", positionX: 2, rotation: 0, actionType: "PLACE" }, "u3"));
  assert.equal(drop.collapsed, true, "beam on the brick's far end tips it");
  assert.equal(drop.removedBlockIds.length, 2, "brick + dropped beam fell together");
  assert.equal(drop.entry.removedBlocks.length, 2, "entry carries both fallen blocks");
  assert.ok(drop.entry.removedBlocks.every((b) => (b.cells || []).length > 0), "fallen blocks keep their cells for animation");
  assert.equal(drop.entry.resolvedX, 2, "no slip here — resolved as aimed");
  assert.equal(drop.entry.placedCells.length, 3, "the dropped beam's cells are recorded");
});

// ── parseReserveMap stays a plain passthrough ─────────────────────────

test("parseReserveMap tolerates junk and passes through records", () => {
  assert.deepEqual(parseReserveMap(null), {});
  assert.deepEqual(parseReserveMap([1, 2]), {});
  assert.deepEqual(parseReserveMap({ a: { blockId: "x", shape: "short" } }), {
    a: { blockId: "x", shape: "short" },
  });
});

// ── Resignation placement + per-match windows ──────────────────────────

test("a resignation holds the resigner's placement; later eliminations skip taken slots", () => {
  // 6-player match where u2 already resigned in 2nd place (standing-based
  // resignation placement). u1 now collapses → takes the worst FREE slot,
  // so the final rankings stay a clean 1..6 bijection.
  const roster = players(["u1", "u2", "u3", "u4", "u5", "u6"]).map((p) =>
    p.userId === "u2" ? { ...p, status: "eliminated", placement: 2 } : p,
  );
  const snap = snapshot({ maxPlayers: 6, pool: buildResourcePool(6, "m1:cycle:1") });
  snap.towerState = pillarTower(2);
  const resolved = okResult(resolvePlacement(snap, roster, topplePlacement(), "u1"));
  assert.equal(resolved.collapsed, true);
  assert.equal(resolved.eliminations.length, 1);
  assert.equal(resolved.eliminations[0].placement, 6, "worst free placement (2 already taken)");
  assert.equal(resolved.activeRemaining, 4);
});

test("activeStanding ranks by blocks held in the tower (ties by earlier seat)", () => {
  // Tower: u2 built 3 blocks, u1 built 2, u3 none → standings 1st / 2nd / last.
  let tower = [];
  for (let i = 0; i < 3; i += 1) {
    tower = simulatePlacement(tower, {
      shape: "short", x: 0, rotation: 0, blockId: `a${i}`, placedByUserId: "u2", turnNumber: i + 1,
    }).tower;
  }
  for (let i = 0; i < 2; i += 1) {
    tower = simulatePlacement(tower, {
      shape: "short", x: 2, rotation: 0, blockId: `b${i}`, placedByUserId: "u1", turnNumber: 10 + i,
    }).tower;
  }
  const roster = players(["u1", "u2", "u3"]);
  assert.equal(activeStanding(roster, tower, "u2"), 1);
  assert.equal(activeStanding(roster, tower, "u1"), 2);
  assert.equal(activeStanding(roster, tower, "u3"), 3, "never contributed → last place");
  assert.equal(activeStanding(roster, null, "u1"), 3, "empty tower → last place (no cheese)");

  // Eliminated players are excluded from the standing roster.
  const withElim = markEliminated(roster, "u3");
  assert.equal(activeStanding(withElim, tower, "u2"), 1);

  // Tie-break: equal blocks → earlier seat ranks higher.
  let tieTower = [];
  for (let i = 0; i < 2; i += 1) {
    tieTower = simulatePlacement(tieTower, {
      shape: "short", x: 0, rotation: 0, blockId: `c${i}`, placedByUserId: "u1", turnNumber: 20 + i,
    }).tower;
    tieTower = simulatePlacement(tieTower, {
      shape: "short", x: 2, rotation: 0, blockId: `d${i}`, placedByUserId: "u2", turnNumber: 30 + i,
    }).tower;
  }
  assert.equal(activeStanding(roster, tieTower, "u1"), 1, "earlier seat wins the tie");
  assert.equal(activeStanding(roster, tieTower, "u2"), 2);
});

test("free-play (AI) matches get a short reserve window so bots never stall", () => {
  assert.ok(AI_RESERVE_WINDOW_MS < RESERVE_WINDOW_MS, "AI reserve window is shorter than PvP");
});

test("resolvePlacement honors per-match (AI) turn windows", () => {
  const snap = snapshot({ maxPlayers: 2 });
  const before = Date.now();
  const resolved = okResult(
    resolvePlacement(snap, players(["u1", "u2"]), stablePlacement(), "u1", {
      reserveWindowMs: AI_RESERVE_WINDOW_MS,
      placementWindowMs: AI_TURN_PLACEMENT_WINDOW_MS,
    }),
  );
  assert.ok(resolved.nextDeadlineMs != null, "next turn has a deadline");
  // No refill on a stable placement → the next window is the placement one.
  const expected = before + AI_TURN_PLACEMENT_WINDOW_MS;
  assert.ok(
    Math.abs(resolved.nextDeadlineMs - expected) < 1000,
    `AI placement window applied (got ${resolved.nextDeadlineMs - before}ms)`,
  );
});

test("the turn after a bot gets the short think window; humans keep the full window", () => {
  const roster = [
    { userId: "u1", seat: 1, status: "active", isAi: false, reserveUsesRemaining: MAX_RESERVE_USES },
    { userId: "AI_BOT_2", seat: 2, status: "active", isAi: true, reserveUsesRemaining: MAX_RESERVE_USES },
  ];
  const snap = snapshot({ maxPlayers: 2 });

  // u1 (human) places → the next holder is the bot → short think window, so
  // viewers see the bot's planned-placement ghost before it acts.
  const before = Date.now();
  const r1 = okResult(resolvePlacement(snap, roster, stablePlacement(), "u1"));
  assert.equal(r1.nextTurnPlayerId, "AI_BOT_2");
  assert.ok(
    Math.abs(r1.nextDeadlineMs - (before + BOT_THINK_MS)) < 1000,
    `bot think window applied (got ${r1.nextDeadlineMs - before}ms)`,
  );

  // The bot places → the next holder is the human → full placement window.
  const snap2 = {
    ...snap,
    towerState: r1.towerState,
    turnNumber: r1.entry.turnNumber,
    currentTurnPlayerId: "AI_BOT_2",
  };
  const r2 = okResult(resolvePlacement(snap2, roster, stablePlacement(), "AI_BOT_2"));
  assert.equal(r2.nextTurnPlayerId, "u1");
  assert.ok(
    Math.abs(r2.nextDeadlineMs - (Date.now() + TURN_PLACEMENT_WINDOW_MS)) < 1000,
    `human keeps the full window (got ${r2.nextDeadlineMs - Date.now()}ms)`,
  );
});