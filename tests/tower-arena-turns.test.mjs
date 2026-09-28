/**
 * Tower Arena — turn-resolution + state-transition tests.
 *
 * These target the pure turn resolver in `src/lib/tower-arena/turnResolver.ts`,
 * which is the game ENGINE's decision layer (the store persists what it
 * resolves). Because the resolver is dependency-free, every rule in the spec
 * is unit-tested here without a database:
 *
 *   • valid / invalid drop (out of aim bounds, unavailable shape)
 *   • turn alternation between the two seats
 *   • timeout fallback (safeFallbackIntent — picks a stable drop when one exists)
 *   • resource consumption from the shared pool
 *   • resource refill (elimination-always, else on empty) — never resets tower
 *   • ceiling breach → elimination + placement + match finish in 1v1
 *   • turn order stability
 *   • duplicate requests / race-safety (pure outcomes are idempotent)
 *
 * The shared-table tests (3–6 seats, reserves, the old slip/contact-shock
 * physics, and the "no ceiling" stack) went with the multiplayer mode: Tower
 * Arena is strictly 1v1, and a placement either rests on the stack or crosses
 * the ceiling. Out-of-board aims are rejected up front, so a "void fall" is
 * not a reachable state.
 *
 * Run:  node --import tsx --test tests/tower-arena-turns.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildResourcePool,
  simulatePlacement,
  GRID_WIDTH,
  SEATS,
  CEILING_HEIGHT,
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

/** The two seats of a 1v1 match. */
function players(ids = ["u1", "u2"]) {
  return ids.map((id, i) => ({
    userId: id,
    seat: i + 1,
    status: "active",
    isAi: false,
    reserveUsesRemaining: MAX_RESERVE_USES,
  }));
}

/** A snapshot with a fully deterministic pool. */
function snapshot(opts = {}, overrides = {}) {
  const nonce = opts.nonce ?? "m1";
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
    ...overrides,
  };
}

/**
 * A stable placement: 2-wide `square` at x=2, which lands flat on the floor
 * line (columns 2–3) and keeps building a flat column.
 */
function stablePlacement() {
  return { shape: "square", positionX: 2, rotation: 0, actionType: "PLACE" };
}

/** A tower with a single column of `n` cubes at column `x`. */
function pillarTower(n = 2, x = 0, seed = "b", by = "u1") {
  let t = [];
  for (let i = 1; i <= n; i += 1) {
    t = simulatePlacement(t, {
      shape: "short",
      x,
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

test("valid placement consumes one shared-pool block and hands the turn to the other seat", () => {
  const pool = buildResourcePool("m1:cycle:1");
  const resolved = okResult(
    resolvePlacement(snapshot({ pool }), players(), stablePlacement(), "u1"),
  );

  assert.equal(resolved.collapsed, false);
  assert.equal(resolved.fromReserve, false);
  assert.equal(resolved.finished, false);
  assert.equal(resolved.entry.turnNumber, 1);
  // Tower gained exactly one block (the freshly placed square).
  assert.equal(resolved.towerState.length, 1);
  assert.equal(resolved.placements === undefined, true);
  // 1v1: the turn goes straight back to the other seat.
  assert.equal(resolved.nextTurnPlayerId, "u2");
  assert.equal(resolved.activeRemaining, SEATS);
});

test("shared pool decremented by exactly one piece of the placed shape", () => {
  const pool = buildResourcePool("m1:cycle:1");
  const before = shapeCounts(pool);
  const resolved = okResult(
    resolvePlacement(snapshot({ pool }), players(), stablePlacement(), "u1"),
  );
  const after = shapeCounts(resolved.pool);
  assert.equal(after.square, before.square - 1, "one square taken from pool");
  for (const k of Object.keys(before)) {
    if (k !== "square") assert.equal(after[k], before[k], `${k} untouched`);
  }
});

test("empty pool resolves an unavailable-shape failure", () => {
  const r = resolvePlacement(snapshot({ pool: [] }), players(), stablePlacement(), "u1");
  assert.equal("resolved" in r, false);
  assert.equal(r.error.includes("not available"), true);
});

test("out-of-bounds drop aim is rejected (never mutates pool or tower)", () => {
  const pool = buildResourcePool("m1:cycle:1");
  const before = pool.length;
  const r = resolvePlacement(
    snapshot({ pool }),
    players(),
    { shape: "square", positionX: GRID_WIDTH + 5, rotation: 0, actionType: "PLACE" },
    "u1",
  );
  assert.equal("resolved" in r, false);
  assert.equal(r.error.includes("bounds"), true, "rejected as out of bounds");
  assert.equal(pool.length, before, "pool untouched on invalid placement");
});

test("an aim that runs off the board edge is rejected, not resolved as a void fall", () => {
  // The engine has no side walls, but the aim itself must be a legal drop
  // column: x = GRID_WIDTH puts a 2-wide block's right cell past the last
  // column, so the placement is refused before anything is simulated.
  const pool = buildResourcePool("m1:cycle:1");
  const r = resolvePlacement(
    snapshot({ pool }),
    players(),
    { shape: "square", positionX: GRID_WIDTH, rotation: 0, actionType: "PLACE" },
    "u1",
  );
  assert.equal("resolved" in r, false);
  assert.equal(r.error.includes("bounds"), true);
});

test("requesting a shape absent from the pool fails without consuming", () => {
  // Pool that contains NO 'L' pieces.
  const pool = buildResourcePool("x:cycle:1").filter((p) => p.shape !== "L");
  const r = resolvePlacement(
    snapshot({ pool }),
    players(),
    { shape: "L", positionX: 2, rotation: 0, actionType: "PLACE" },
    "u1",
  );
  assert.equal("resolved" in r, false);
  assert.equal(r.error.includes("not available"), true);
});

// ═══════════════════════════════════════════════════════════════════
// Turn order + final player
// ═══════════════════════════════════════════════════════════════════

test("nextActiveAfter alternates between the two seats and returns null when only one remains", () => {
  assert.equal(nextActiveAfter(players(), "u1"), "u2");
  assert.equal(nextActiveAfter(players(), "u2"), "u1");
  // Only one active remains → no wrap.
  const solo = [{ ...players()[0] }, { ...players()[1], status: "eliminated" }];
  assert.equal(nextActiveAfter(solo, "u1"), null);
  // An unknown actor has no successor.
  assert.equal(nextActiveAfter(players(), "ghost"), null);
});

test("a ceiling breach eliminates the dropper as 2nd and finishes the 1v1 match", () => {
  // A column already at the ceiling: the next cube crosses it.
  const tower = pillarTower(CEILING_HEIGHT, 2, "pre");
  const resolved = okResult(
    resolvePlacement(
      snapshot({}, { towerState: tower }),
      players(),
      { shape: "short", positionX: 2, rotation: 0, actionType: "PLACE" },
      "u1",
    ),
  );
  assert.equal(resolved.collapsed, true);
  assert.equal(resolved.eliminations.length, 1);
  assert.equal(resolved.eliminations[0].userId, "u1");
  // 1v1: the dropper takes the only losing placement.
  assert.equal(resolved.eliminations[0].placement, 2);
  assert.equal(resolved.activeRemaining, 1);
  assert.equal(resolved.finished, true, "one survivor remains → finished");
});

test("a finish leaves no next turn or deadline", () => {
  const tower = pillarTower(CEILING_HEIGHT, 2, "pre");
  const resolved = okResult(
    resolvePlacement(
      snapshot({}, { towerState: tower }),
      players(),
      { shape: "short", positionX: 2, rotation: 0, actionType: "PLACE" },
      "u1",
    ),
  );
  assert.equal(resolved.finished, true);
  assert.equal(resolved.nextTurnPlayerId, null);
  assert.equal(resolved.nextDeadlineMs, null);
});

test("a ceiling breach trims the tower and records the entry", () => {
  const tower = pillarTower(CEILING_HEIGHT, 0, "pre");
  const resolved = okResult(
    resolvePlacement(
      snapshot({}, { towerState: tower }),
      players(),
      { shape: "short", positionX: 0, rotation: 0, actionType: "PLACE" },
      "u1",
    ),
  );
  assert.equal(resolved.collapsed, true);
  // The doomed block is reported (alongside the trimmed upper half).
  assert.equal(
    resolved.entry.removedBlockIds.includes(resolved.entry.blockId),
    true,
    "the doomed block is in removedBlockIds",
  );
  // Its resolved cells are recorded so every viewer animates the same drop.
  assert.equal(resolved.entry.placedCells.length, 1);
  assert.equal(resolved.entry.resolvedX, 0, "resolved as aimed (the engine has no slip)");
  // First elimination keeps the bottom half, rebased to the floor.
  assert.ok(resolved.towerState.length > 0 && resolved.towerState.length < CEILING_HEIGHT);
  assert.equal(Math.min(...resolved.towerState.flatMap((b) => b.cells.map((c) => c.z))), 1);
});

// ═══════════════════════════════════════════════════════════════════
// Tower growth / preservation
// ═══════════════════════════════════════════════════════════════════

test("stable play grows the tower to the 24-cell ceiling, and the next block ends it", () => {
  let tower = [];
  // 24 cubes in one column reach exactly the ceiling line and are stable.
  for (let i = 1; i <= CEILING_HEIGHT; i += 1) {
    const snap = snapshot({});
    snap.towerState = tower;
    snap.turnNumber = i - 1;
    const r = resolvePlacement(snap, players(), {
      shape: "short",
      positionX: 2,
      rotation: 0,
      actionType: "PLACE",
    }, i % 2 === 0 ? "u2" : "u1");
    assert.equal("resolved" in r, true, `turn ${i} resolves`);
    assert.equal(r.resolved.collapsed, false, `cube ${i} stays under the ceiling`);
    tower = r.resolved.towerState;
  }
  assert.equal(tower.length, CEILING_HEIGHT);

  // The 25th crosses the ceiling and ends the duel.
  const snap = snapshot({});
  snap.towerState = tower;
  snap.turnNumber = CEILING_HEIGHT;
  const doomed = okResult(
    resolvePlacement(
      snap,
      players(),
      { shape: "short", positionX: 2, rotation: 0, actionType: "PLACE" },
      "u1",
    ),
  );
  assert.equal(doomed.collapsed, true);
  assert.equal(doomed.finished, true);
});

test("resource refill never resets the tower", () => {
  const tower = pillarTower(2, 0, "pre");
  const snap = snapshot({});
  snap.towerState = tower;
  const resolved = okResult(
    resolvePlacement(
      snap,
      players(),
      { shape: "square", positionX: 3, rotation: 0, actionType: "PLACE" },
      "u1",
    ),
  );
  assert.equal(resolved.collapsed, false);
  assert.equal(resolved.refilled, false, "pool intact after one draw");
  assert.equal(resolved.towerState.length, tower.length + 1, "the pillar survives the placement");
  assert.ok(resolved.towerState.some((b) => b.id === "b:1"), "original blocks retained");
});

// ═══════════════════════════════════════════════════════════════════
// Resource refill on empty pool
// ═══════════════════════════════════════════════════════════════════

test("pool refills when it empties (no elimination), without resetting the tower", () => {
  // Pool with a single piece → one placement empties it → refill.
  const onePiecePool = [{ id: "p:0", shape: "square" }];
  const snap = snapshot({ pool: onePiecePool.slice() });
  snap.towerState = pillarTower(1, 0, "pre");
  const resolved = okResult(
    resolvePlacement(snap, players(), { shape: "square", positionX: 3, rotation: 0, actionType: "PLACE" }, "u1"),
  );
  assert.equal(resolved.refilled, true, "empty pool refilled");
  assert.ok(resolved.pool.length > 0, "pool no longer empty");
  assert.equal(resolved.towerState.length, 2, "tower retained through refill");
});

// ═══════════════════════════════════════════════════════════════════
// Timeout fallback
// ═══════════════════════════════════════════════════════════════════

test("timeout fallback picks a stable drop when one exists (no instant elimination)", () => {
  const pool = buildResourcePool("m1:cycle:1");
  const intent = safeFallbackIntent(snapshot({ pool }));
  assert.equal(intent.actionType, "TIMEOUT");
  assert.equal(["short", "square", "I", "L"].includes(intent.shape), true);
  const resolved = okResult(resolvePlacement(snapshot({ pool }), players(), intent, "u1"));
  // On an empty board every drop settles on the floor line.
  assert.equal(resolved.collapsed, false);
  assert.equal(resolved.entry.turnNumber, 1);
  assert.equal(resolved.entry.actionType, "TIMEOUT", "timeout recorded");
});

test("timeout fallback stays safe on a jagged tower when the pool allows it", () => {
  const tower = pillarTower(2, 0, "pre");
  const pool = buildResourcePool("m1:cycle:1");
  const state = snapshot({ pool });
  state.towerState = tower;
  const intent = safeFallbackIntent(state);
  const resolved = okResult(resolvePlacement(state, players(), intent, "u1"));
  assert.equal(resolved.collapsed, false, "fallback chose a block that balances on the pillar");
});

// ═══════════════════════════════════════════════════════════════════
// Duplicate requests / race-conditions
// ═══════════════════════════════════════════════════════════════════

test("a duplicate placement against the SAME snapshot is deterministic and non-double-consuming", () => {
  const pool = buildResourcePool("m1:cycle:1");
  const snap = snapshot({ pool });

  const first = resolvePlacement(snap, players(), stablePlacement(), "u1");
  assert.equal("resolved" in first, true);

  // Replaying the STALE snapshot resolves to the same outcome — pure
  // idempotence. The store additionally gates replays via its FOR UPDATE row
  // lock + conditional phase update (see store tests).
  const second = resolvePlacement(snap, players(), stablePlacement(), "u1");
  assert.equal("resolved" in second, true);
  assert.deepEqual(first.resolved.towerState, second.resolved.towerState);
  assert.deepEqual(first.resolved.pool, second.resolved.pool);
  assert.equal(pool.length, buildResourcePool("m1:cycle:1").length, "original pool array never mutated");
});

test("the resolver never mutates the caller's snapshot", () => {
  const pool = buildResourcePool("m1:cycle:1");
  const originalLength = pool.length;
  const shared = snapshot({ pool });

  const a = resolvePlacement(shared, players(), stablePlacement(), "u1").resolved;
  assert.ok(a.pool.length === originalLength - 1);
  assert.equal(pool.length, originalLength, "original pool unmutated by resolver");
  assert.deepEqual(shared.towerState, [], "original tower unmutated");
});

test("repeat applications advance turnNumber monotonically and alternate seats", () => {
  let snap = snapshot({});
  let cur = "u1";
  const turns = [];
  const seats = [];
  for (let i = 0; i < 5; i += 1) {
    snap.resourcePool = buildResourcePool(`m:cycle:${i}`); // ample pieces each iteration
    snap.currentTurnPlayerId = cur;
    snap.phase = "placement";
    const r = resolvePlacement(snap, players(), stablePlacement(), cur);
    assert.equal("resolved" in r, true, `turn ${i + 1} resolved`);
    const resolved = r.resolved;
    turns.push(resolved.entry.turnNumber);
    seats.push(resolved.entry.seat);
    snap = {
      ...snap,
      towerState: resolved.towerState,
      turnNumber: resolved.entry.turnNumber,
      resourceCycle: resolved.resourceCycle,
    };
    cur = resolved.nextTurnPlayerId;
    assert.ok(cur, "turn always alternates while both seats are active");
  }
  assert.deepEqual(turns, [1, 2, 3, 4, 5]);
  assert.deepEqual(seats, [1, 2, 1, 2, 1]);
});

// ── Turn window + aim bounds ──────────────────────────────────────────

test("placement and reserve windows are at least 60 seconds", () => {
  assert.ok(TURN_PLACEMENT_WINDOW_MS >= 60000, "placement window ≥ 60s");
  assert.ok(RESERVE_WINDOW_MS >= 60000, "reserve window ≥ 60s");
});

test("free-play (AI) matches get a short reserve window so bots never stall", () => {
  assert.ok(AI_RESERVE_WINDOW_MS < RESERVE_WINDOW_MS, "AI reserve window is shorter than PvP");
  assert.ok(BOT_THINK_MS < TURN_PLACEMENT_WINDOW_MS, "bots think for a beat, not a whole turn");
});

// ── parseReserveMap stays a plain passthrough ─────────────────────────

test("parseReserveMap tolerates junk and passes through records", () => {
  assert.deepEqual(parseReserveMap(null), {});
  assert.deepEqual(parseReserveMap([1, 2]), {});
  assert.deepEqual(parseReserveMap({ a: { blockId: "x", shape: "short" } }), {
    a: { blockId: "x", shape: "short" },
  });
});

// ── Standing + per-match windows ──────────────────────────────────────

test("activeStanding ranks by blocks held in the tower (ties by earlier seat)", () => {
  // Tower: u2 built 3 blocks, u1 built 2 → u2 1st, u1 2nd.
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
  const roster = players();
  assert.equal(activeStanding(roster, tower, "u2"), 1);
  assert.equal(activeStanding(roster, tower, "u1"), 2);
  assert.equal(activeStanding(roster, null, "u1"), 2, "empty tower → last place (no cheese)");

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

test("resolvePlacement honors per-match (AI) turn windows", () => {
  const snap = snapshot({});
  const before = Date.now();
  const resolved = okResult(
    resolvePlacement(snap, players(), stablePlacement(), "u1", {
      reserveWindowMs: AI_RESERVE_WINDOW_MS,
      placementWindowMs: AI_TURN_PLACEMENT_WINDOW_MS,
    }),
  );
  assert.ok(resolved.nextDeadlineMs != null, "next turn has a deadline");
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
  const snap = snapshot({});

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
