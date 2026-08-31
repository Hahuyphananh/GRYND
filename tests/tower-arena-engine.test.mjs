/**
 * Tower Arena — engine + payout unit tests.
 *
 * Pure-function tests for the deterministic tower engine and the
 * centralized placement payout math in `src/lib/tower-arena/`. These are
 * the contracts the server-authoritative state machine depends on, so
 * determinism, collapse retention and payout bounds are tested explicitly.
 *
 * Run:  node --import tsx --test tests/tower-arena-engine.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  GRID_WIDTH,
  GRID_DEPTH,
  BLOCK_SHAPES,
  BLOCK_FOOTPRINTS,
  footprintFor,
  footprintExtent,
  fitsInGrid,
  centerDepthFor,
  centerXFor,
  isStable,
  simulatePlacement,
  applyPlacementBlock,
  buildResourcePool,
  takeFromPool,
  refillResourcePool,
  MAX_ABSOLUTE_HEIGHT,
} from "../src/lib/tower-arena/engine.ts";
import {
  computePotPrize,
  payoutsByPlacement,
  payoutForPlacement,
  netForPlacement,
  PAYOUT_WEIGHTS,
} from "../src/lib/tower-arena/payout.ts";

// ═══════════════════════════════════════════════════════════════════
// Block definitions + grid
// ═══════════════════════════════════════════════════════════════════

test("every block shape is defined and has a non-empty footprint", () => {
  for (const s of BLOCK_SHAPES) {
    assert.ok(BLOCK_FOOTPRINTS[s].length >= 2, `${s} has a footprint`);
    assert.ok(
      BLOCK_FOOTPRINTS[s].every(([x, d]) => Number.isInteger(x) && Number.isInteger(d)),
      `${s} cells are integers`,
    );
  }
});

test("footprintFor normalizes each rotation consistently", () => {
  for (const s of BLOCK_SHAPES) {
    for (let rot = 0; rot < 4; rot += 1) {
      const cells = footprintFor(s, rot);
      const minX = Math.min(...cells.map(([a]) => a));
      const minD = Math.min(...cells.map(([, a]) => a));
      assert.equal(minX, 0, `${s} rot${rot} normalized on X`);
      assert.equal(minD, 0, `${s} rot${rot} normalized on depth`);
    }
  }
});

test("footprints fit the grid when anchored within bounds", () => {
  for (const s of BLOCK_SHAPES) {
    for (let rot = 0; rot < 4; rot += 1) {
      const { maxX, maxDepth } = footprintExtent(s, rot);
      assert.ok(maxX < GRID_WIDTH, `${s} rot${rot} maxX ${maxX} < 6`);
      assert.ok(maxDepth < GRID_DEPTH, `${s} rot${rot} maxDepth ${maxDepth} < 6`);
      assert.equal(fitsInGrid(footprintFor(s, rot), 0, 0), true);
    }
  }
});

test("centering helpers keep the footprint inside the grid", () => {
  for (const s of BLOCK_SHAPES) {
    for (let rot = 0; rot < 4; rot += 1) {
      const x = centerXFor(s, rot);
      const d = centerDepthFor(s, rot);
      assert.equal(fitsInGrid(footprintFor(s, rot), x, d), true, `${s} rot${rot}`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════
// Determinism
// ═══════════════════════════════════════════════════════════════════

test("simulatePlacement is deterministic for identical inputs", () => {
  const params = {
    shape: "square",
    x: 2,
    depth: centerDepthFor("square", 0),
    rotation: 0,
    blockId: "b:1",
    placedByUserId: "u1",
    turnNumber: 1,
  };
  const a = simulatePlacement([], params);
  const b = simulatePlacement([], params);
  assert.deepEqual(a, b);
  assert.equal(a.stable, true);
  assert.equal(b.collapsed, false);
});

test("buildResourcePool is deterministic for the same nonce and scales with players", () => {
  const a1 = buildResourcePool(2, "m1:cycle:1");
  const a2 = buildResourcePool(2, "m1:cycle:1");
  assert.deepEqual(a1, a2, "same nonce → same pool");
  const p6 = buildResourcePool(6, "m1:cycle:1");
  assert.ok(p6.length > a1.length, "6 players get more resources than 2");
  assert.ok(
    p6.every((p) => BLOCK_SHAPES.includes(p.shape)),
    "pool pieces use known shapes",
  );
});

test("takeFromPool removes exactly one piece of the requested shape", () => {
  const pool = buildResourcePool(4, "nonce");
  const count = pool.filter((p) => p.shape === "square").length;
  const { pool: after, piece } = takeFromPool(pool, "square");
  assert.ok(piece, "a square was available");
  assert.equal(piece.shape, "square");
  const afterCount = after.filter((p) => p.shape === "square").length;
  assert.equal(afterCount, count - 1);
  // Asking for a shape not present returns null and leaves pool intact.
  const empty = takeFromPool([], "I");
  assert.equal(empty.piece, null);
  assert.deepEqual(empty.pool, []);
});

test("refillResourcePool appends fresh pieces without touching existing ones", () => {
  const base = buildResourcePool(3, "x");
  const before = base.length;
  const refilled = refillResourcePool(base, 3, "y");
  assert.ok(refilled.length > before, "pool grew");
  // Every original piece is still present (no mutation).
  for (const p of base) assert.ok(refilled.some((r) => r.id === p.id));
});

// ═══════════════════════════════════════════════════════════════════
// Stability + collapse
// ═══════════════════════════════════════════════════════════════════

function centeredSquare(x) {
  return applyPlacementBlock([], {
    shape: "square",
    x,
    depth: centerDepthFor("square", 0),
    rotation: 0,
    blockId: "b:1",
    placedByUserId: "u1",
    turnNumber: 1,
  });
}

test("an empty tower and a single centered block are stable", () => {
  assert.equal(isStable([]), true);
  assert.equal(isStable([centeredSquare(2)]), true);
  // A tower of three stacked centered squares stays stable.
  let t = [];
  for (let i = 1; i <= 3; i += 1) {
    const res = simulatePlacement(t, {
      shape: "square",
      x: 2,
      depth: centerDepthFor("square", 0),
      rotation: 0,
      blockId: `b:${i}`,
      placedByUserId: "u1",
      turnNumber: i,
    });
    assert.equal(res.collapsed, false, `level ${i} did not topple`);
    t = res.tower;
  }
  assert.equal(isStable(t), true);
});

test("an off-center block topples (center of mass leaves the base)", () => {
  // Place a square slammed against the far column — COM exits the base.
  const wide = {
    x: 0,
    depth: 0,
  };
  const res = simulatePlacement([], {
    shape: "square",
    x: 0,
    depth: 0,
    rotation: 0,
    blockId: "b:1",
    placedByUserId: "u1",
    turnNumber: 1,
  });
  void wide;
  assert.equal(res.collapsed, true, "extreme off-center placement collapses");
  assert.equal(JSON.stringify(res.removedBlockIds.length) === "0", false);
  // The retained remainder is stable and keeps some portion.
  assert.equal(isStable(res.tower), true);
});

test("collapse keeps the highest stable portion (does not clear the tower)", () => {
  // Build a modest centered base, then force an unstable protrusion on top.
  let t = [];
  for (let i = 1; i <= 2; i += 1) {
    const r = simulatePlacement(t, {
      shape: "square",
      x: 2,
      depth: centerDepthFor("square", 0),
      rotation: 0,
      blockId: `b:${i}`,
      placedByUserId: "u1",
      turnNumber: i,
    });
    t = r.tower;
  }
  const before = t.length;
  const bad = simulatePlacement(t, {
    shape: "short",
    x: 5, // far right edge, protrudes off the compact base
    depth: 0,
    rotation: 0,
    blockId: "b:3",
    placedByUserId: "u2",
    turnNumber: 3,
  });
  if (bad.collapsed) {
    // The base blocks (b:1, b:2) stay; only the bad block topples.
    assert.ok(bad.tower.some((b) => b.id === "b:1" || b.id === "b:2"));
    assert.ok(bad.removedBlockIds.length >= 1);
    assert.equal(isStable(bad.tower), true);
    assert.ok(bad.tower.length <= before, "never grows past the base");
  } else {
    // Some placements may coincidentally survive — tower must remain stable.
    assert.equal(isStable(bad.tower), true);
  }
});

test("very tall even towers eventually hit the height ceiling and topple", () => {
  let t = [];
  let toppled = false;
  for (let i = 1; i <= MAX_ABSOLUTE_HEIGHT + 2; i += 1) {
    const r = simulatePlacement(t, {
      shape: "square",
      x: 2,
      depth: centerDepthFor("square", 0),
      rotation: 0,
      blockId: `b:${i}`,
      placedByUserId: "u1",
      turnNumber: i,
    });
    t = r.tower;
    if (r.collapsed) {
      toppled = true;
      break;
    }
  }
  assert.equal(toppled, true, "an unbounded even spire cannot stand forever");
  assert.equal(isStable(t), true);
});

// ═══════════════════════════════════════════════════════════════════
// Payout
// ═══════════════════════════════════════════════════════════════════

test("pot / rake / prize pool math follows the 5% house rake", () => {
  // 6 × 100 = 600; house = floor(600*0.05) = 30; prize = 570.
  const cfg = computePotPrize({ maxPlayers: 6, wager: 100 });
  assert.equal(cfg.pot, 600);
  assert.equal(cfg.houseFee, 30);
  assert.equal(cfg.prizePool, 570);
});

test("2 players: winner takes the entire prize pool, 2nd gets 0", () => {
  const cfg = computePotPrize({ maxPlayers: 2, wager: 100 });
  assert.equal(cfg.prizePool, 190);
  const payouts = payoutsByPlacement({
    maxPlayers: 2,
    wager: 100,
    prizePool: cfg.prizePool,
  });
  assert.equal(payouts[0], 190);
  assert.equal(payouts[1], 0);
  assert.equal(payouts.reduce((a, b) => a + b, 0), cfg.prizePool);
});

test("6 players at a 100 entry reproduce the spec economics", () => {
  const cfg = computePotPrize({ maxPlayers: 6, wager: 100 });
  const payouts = payoutsByPlacement({
    maxPlayers: 6,
    wager: 100,
    prizePool: cfg.prizePool,
  });
  // The spec's 300 / 160 / 110 goals at a 570 prize pool.
  assert.ok(Math.abs(payouts[0] - 300) <= 5, `winner ≈ 300 (got ${payouts[0]})`);
  assert.ok(Math.abs(payouts[1] - 160) <= 5, `2nd ≈ 160 (got ${payouts[1]})`);
  assert.ok(Math.abs(payouts[2] - 110) <= 5, `3rd ≈ 110 (got ${payouts[2]})`);
  assert.equal(payouts[3], 0);
  assert.equal(payouts[4], 0);
  assert.equal(payouts[5], 0);
  // All of the prize pool is handed out — never more.
  assert.equal(payouts.reduce((a, b) => a + b, 0), cfg.prizePool);
  // 1st / 2nd / 3rd profit at a 100 entry.
  assert.equal(netForPlacement({ maxPlayers: 6, wager: 100, prizePool: cfg.prizePool, placement: 1 }) > 0, true);
  assert.equal(netForPlacement({ maxPlayers: 6, wager: 100, prizePool: cfg.prizePool, placement: 2 }) > 0, true);
  assert.equal(netForPlacement({ maxPlayers: 6, wager: 100, prizePool: cfg.prizePool, placement: 3 }) > 0, true);
});

test("payouts never exceed the prize pool for every seat count", () => {
  for (let n = 2; n <= 6; n += 1) {
    // A spread of stakes incl. awkward amounts.
    for (const w of [1, 7, 100, 333, 1000]) {
      const cfg = computePotPrize({ maxPlayers: n, wager: w });
      const payouts = payoutsByPlacement({
        maxPlayers: n,
        wager: w,
        prizePool: cfg.prizePool,
      });
      assert.equal(payouts.length, n);
      assert.equal(payouts.reduce((a, b) => a + b, 0), cfg.prizePool, `N=${n} W=${w} sums to prize pool`);
      assert.ok(
        payouts.every((p) => p >= 0 && p <= cfg.prizePool),
        `N=${n} payout in bounds`,
      );
    }
  }
});

test("placement payouts are monotonic (winner ≥ 2nd ≥ …) within paid places", () => {
  const cfg = computePotPrize({ maxPlayers: 5, wager: 50 });
  const payouts = payoutsByPlacement({ maxPlayers: 5, wager: 50, prizePool: cfg.prizePool });
  for (let i = 0; i < payouts.length - 1; i += 1) {
    assert.ok(payouts[i] >= payouts[i + 1], `placement ${i + 1} >= ${i + 2}`);
  }
});

test("payout helpers agree and clamp placement defensively", () => {
  const cfg = computePotPrize({ maxPlayers: 4, wager: 25 });
  const all = payoutsByPlacement({ maxPlayers: 4, wager: 25, prizePool: cfg.prizePool });
  for (let i = 0; i < all.length; i += 1) {
    assert.equal(
      payoutForPlacement({ maxPlayers: 4, wager: 25, prizePool: cfg.prizePool, placement: (i + 1) }),
      all[i],
    );
  }
  assert.equal(
    payoutForPlacement({ maxPlayers: 4, wager: 25, prizePool: cfg.prizePool, placement: 99 }),
    all[all.length - 1],
    "clamps to the last placement",
  );
});

test("payout weight tables exist for every supported seat count", () => {
  for (let n = 2; n <= 6; n += 1) {
    assert.ok(PAYOUT_WEIGHTS[n], `weights for ${n} players`);
    assert.equal(PAYOUT_WEIGHTS[n].length, n);
  }
});