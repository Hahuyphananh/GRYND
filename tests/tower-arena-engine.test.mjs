/**
 * Tower Arena — engine + payout unit tests.
 *
 * Pure-function tests for the deterministic 2D ceiling-tower engine and the
 * centralized placement payout math in `src/lib/tower-arena/`. These are
 * the contracts the server-authoritative state machine depends on, so
 * determinism, drop resolution (blocks settle on the highest support under
 * their footprint), the hard ceiling elimination rule, tower trimming after
 * an elimination, and payout bounds are tested explicitly.
 *
 * Run:  node --import tsx --test tests/tower-arena-engine.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  GRID_WIDTH,
  CEILING_HEIGHT,
  BLOCK_SHAPES,
  BLOCK_DIMS,
  BLOCK_FOOTPRINTS,
  blockCells,
  blockWidth,
  blockHeight,
  footprintFor,
  footprintExtent,
  dropRangeFor,
  dropInBounds,
  fitsInGrid,
  centerDepthFor,
  centerXFor,
  isStable,
  wouldFall,
  simulatePlacement,
  applyPlacementBlock,
  findSafeDrop,
  trimTowerAfterElimination,
  buildResourcePool,
  takeFromPool,
  refillResourcePool,
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

test("the floor and ceiling grew to fit the bigger shapes", () => {
  assert.equal(GRID_WIDTH, 16);
  assert.equal(CEILING_HEIGHT, 24);
  // Every shape (incl. the 4-wide long beam) fits the line and leaves room.
  for (const s of BLOCK_SHAPES) {
    assert.ok(BLOCK_DIMS[s].w <= GRID_WIDTH - 1, `${s} width ${BLOCK_DIMS[s].w} leaves floor room`);
    assert.ok(BLOCK_DIMS[s].h <= CEILING_HEIGHT, `${s} height ${BLOCK_DIMS[s].h} fits under the ceiling`);
  }
});

test("every block shape is a solid rectangle of integer cells", () => {
  for (const s of BLOCK_SHAPES) {
    const { w, h } = BLOCK_DIMS[s];
    assert.ok(w >= 1 && h >= 1, `${s} is at least 1×1`);
    assert.equal(blockCells(s, 0).length, w * h, `${s} has w*h cells`);
    assert.ok(
      blockCells(s, 0).every(([x, z]) => Number.isInteger(x) && Number.isInteger(z)),
      `${s} cells are integers`,
    );
    assert.equal(BLOCK_FOOTPRINTS[s].length, w * h, `${s} legacy footprint agrees`);
  }
  // Variety: at least four distinct widths exist (narrow = safe, wide = risky).
  assert.ok(new Set(BLOCK_SHAPES.map((s) => BLOCK_DIMS[s].w)).size >= 4, "width variety");
  // The two new larger shapes are actually in the shipped pool.
  assert.equal(BLOCK_DIMS.long.w, 4, "long beam spans 4 columns");
  assert.equal(BLOCK_DIMS.big.w * BLOCK_DIMS.big.h, 6, "big block is 3×2");
});

test("rotations flip width/height (0/2 = as-is, 1/3 = transposed)", () => {
  for (const s of BLOCK_SHAPES) {
    const { w, h } = BLOCK_DIMS[s];
    assert.equal(blockWidth(s, 0), w);
    assert.equal(blockWidth(s, 2), w);
    assert.equal(blockWidth(s, 1), h);
    assert.equal(blockWidth(s, 3), h);
    assert.equal(blockHeight(s, 1), w);
    // Cells are normalized to the origin for every rotation.
    for (let rot = 0; rot < 4; rot += 1) {
      const cells = blockCells(s, rot);
      const minX = Math.min(...cells.map(([a]) => a));
      const minZ = Math.min(...cells.map(([, b]) => b));
      assert.equal(minX, 0, `${s} rot${rot} normalized on X`);
      assert.equal(minZ, 0, `${s} rot${rot} normalized on Z`);
      assert.equal(footprintFor(s, rot).length, blockCells(s, rot).length);
    }
  }
  // The vertical long beam is 1 wide and 4 tall.
  assert.equal(blockWidth("long", 1), 1);
  assert.equal(blockHeight("long", 1), 4);
});

test("aim range is clamped to the floor: columns 0 … GRID_WIDTH − width", () => {
  for (const s of BLOCK_SHAPES) {
    for (let rot = 0; rot < 2; rot += 1) {
      const w = blockWidth(s, rot);
      const { minX, maxX } = dropRangeFor(s, rot);
      assert.equal(minX, 0, `${s} may not aim left of the platform`);
      assert.equal(maxX, GRID_WIDTH - w, `${s} rightmost legal aim leaves the block on`);
      for (let x = minX; x <= maxX; x += 1) {
        assert.equal(dropInBounds(s, rot, x), true, `${s} rot${rot} x=${x} legal`);
      }
      assert.equal(dropInBounds(s, rot, minX - 1), false, `${s} beyond-floor-left rejected`);
      assert.equal(dropInBounds(s, rot, maxX + 1), false, `${s} beyond-floor-right rejected`);
      assert.equal(dropInBounds(s, rot, 0.5), false, `${s} non-integer aim rejected`);
    }
  }
});

test("centering helpers keep the block fully on the floor line", () => {
  for (const s of BLOCK_SHAPES) {
    for (let rot = 0; rot < 4; rot += 1) {
      const x = centerXFor(s, rot);
      assert.equal(centerDepthFor(s, rot), 0);
      assert.equal(fitsInGrid(blockCells(s, rot), x, 0), true, `${s} rot${rot}`);
      const { maxX } = footprintExtent(s, rot);
      assert.ok(maxX < GRID_WIDTH, `${s} rot${rot} maxX ${maxX} < ${GRID_WIDTH}`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════
// Drop resolution — settle on the highest support, hard ceiling
// ═══════════════════════════════════════════════════════════════════

/** Build a tower by simulating safe placements onto an empty board. */
function buildTower(placements) {
  let t = [];
  for (let i = 0; i < placements.length; i += 1) {
    const [shape, x, rotation] = placements[i];
    const r = simulatePlacement(t, {
      shape,
      x,
      rotation: rotation ?? 0,
      blockId: `b:${i + 1}`,
      placedByUserId: "u1",
      turnNumber: i + 1,
    });
    assert.equal(r.collapsed, false, `setup placement ${i} stable`);
    t = r.tower;
  }
  return t;
}

test("an empty tower and a floor-level block are stable", () => {
  assert.equal(isStable([]), true);
  const square = simulatePlacement([], {
    shape: "square",
    x: 0,
    rotation: 0,
    blockId: "b:1",
    placedByUserId: "u1",
    turnNumber: 1,
  });
  assert.equal(square.collapsed, false);
  assert.equal(isStable(square.tower), true);
  // The first block rests on the floor line at z=1.
  assert.equal(square.placedBlock.z, 1);
  assert.equal(square.placedBlock.cells.length, 2);
});

test("a block settles on the highest support under its footprint", () => {
  // Pillar of two shorts at col 2; col 0 holds a floor-level cube.
  let t = buildTower([
    ["short", 2],
    ["short", 2],
    ["short", 0],
  ]);
  // A square landing across cols 1-2 must rest on the taller pillar (z=3).
  const res = simulatePlacement(t, {
    shape: "square",
    x: 1,
    rotation: 0,
    blockId: "b:4",
    placedByUserId: "u1",
    turnNumber: 4,
  });
  assert.equal(res.collapsed, false);
  assert.equal(res.placedBlock.z, 3, "sits on the 2-high pillar, not the floor");
  // A cube dropped onto an empty column still lands on the floor (z=1).
  const low = simulatePlacement(t, {
    shape: "short",
    x: 6,
    rotation: 0,
    blockId: "b:5",
    placedByUserId: "u1",
    turnNumber: 5,
  });
  assert.equal(low.placedBlock.z, 1, "empty column → floor level");
  assert.equal(isStable(res.tower), true);
});

test("stacked centered blocks grow a stable tower to the ceiling line", () => {
  let t = [];
  // 24 unit cubes in one column reach exactly the ceiling (z=24) and are fine.
  for (let i = 1; i <= CEILING_HEIGHT; i += 1) {
    const res = simulatePlacement(t, {
      shape: "short",
      x: 2,
      rotation: 0,
      blockId: `b:${i}`,
      placedByUserId: "u1",
      turnNumber: i,
    });
    assert.equal(res.collapsed, false, `cube ${i} settles at/below the ceiling`);
    t = res.tower;
  }
  assert.equal(t.length, CEILING_HEIGHT);
  assert.equal(isStable(t), true);
});

test("a placement whose top crosses the ceiling is a collapse — the tower keeps the rest", () => {
  // Column at x=2 already reaches the ceiling (z=24); one more cube would sit
  // at z=25 → its top crosses the ceiling → the dropper is eliminated.
  let t = [];
  for (let i = 1; i <= CEILING_HEIGHT; i += 1) {
    t = simulatePlacement(t, {
      shape: "short",
      x: 2,
      rotation: 0,
      blockId: `b:${i}`,
      placedByUserId: "u1",
      turnNumber: i,
    }).tower;
  }
  const doomed = simulatePlacement(t, {
    shape: "short",
    x: 2,
    rotation: 0,
    blockId: "b:x",
    placedByUserId: "u2",
    turnNumber: CEILING_HEIGHT + 1,
  });
  assert.equal(doomed.collapsed, true, "crossing the ceiling eliminates the placer");
  assert.equal(doomed.stable, false);
  assert.deepEqual(doomed.removedBlockIds, ["b:x"], "only the doomed block is reported");
  assert.deepEqual(doomed.tower, t, "the standing tower is untouched");
  assert.equal(isStable(doomed.tower), true);
});

test("the same ceiling rule applies to the taller shapes (long beam vertical = 4 tall)", () => {
  // Stack vertical long beams (1×4) in one column: the kth beam tops out at
  // z = 4k. Six fit (top 24 = exactly the ceiling line); the seventh (top
  // 28) crosses it and collapses.
  let t = [];
  for (let i = 1; i <= 6; i += 1) {
    const res = simulatePlacement(t, {
      shape: "long",
      x: 5,
      rotation: 1,
      blockId: `b:${i}`,
      placedByUserId: "u1",
      turnNumber: i,
    });
    assert.equal(res.collapsed, false, `beam ${i} tops at ${4 * i} — at/below the ceiling`);
    t = res.tower;
  }
  const doomed = simulatePlacement(t, {
    shape: "long",
    x: 5,
    rotation: 1,
    blockId: "b:7",
    placedByUserId: "u2",
    turnNumber: 7,
  });
  assert.equal(doomed.collapsed, true, "vertical beam past the ceiling collapses");
  assert.deepEqual(doomed.tower, t, "the standing tower is untouched");
});

test("aiming fully off the floor is rejected up front (out of bounds = no block)", () => {
  const block = applyPlacementBlock([], {
    shape: "square",
    x: GRID_WIDTH - 1, // 2-wide square would spill past column 15
    rotation: 0,
    blockId: "b:1",
    placedByUserId: "u1",
    turnNumber: 1,
  });
  assert.equal(block.cells.length, 0, "no in-bounds cells resolved");
  assert.equal(wouldFall(block, []), true);
  const res = simulatePlacement([], {
    shape: "square",
    x: GRID_WIDTH - 1,
    rotation: 0,
    blockId: "b:1",
    placedByUserId: "u1",
    turnNumber: 1,
  });
  assert.equal(res.collapsed, true, "an impossible aim resolves as a void fall");
  assert.deepEqual(res.tower, [], "tower unchanged");
});

test("overlapping blocks are never stable (duplicate cells are rejected)", () => {
  let t = buildTower([["short", 3]]);
  // Force an overlapping duplicate by hand — isStable must call it out.
  const dup = { ...t[0], id: "b:dup", placedByUserId: "u2", turnNumber: 2, cells: [...t[0].cells] };
  assert.equal(isStable([t[0], dup]), false, "duplicate cell occupancy is unstable");
  assert.equal(isStable(t), true);
});

test("wouldFall flags blocks that are empty, above the ceiling, or overlapping", () => {
  let t = buildTower([
    ["short", 3],
    ["short", 3],
  ]);
  // A block floating above the ceiling.
  const above = {
    ...t[1],
    id: "b:up",
    cells: t[1].cells.map((c) => ({ ...c, z: CEILING_HEIGHT + 2 })),
  };
  assert.equal(wouldFall(above, [t[0]]), true, "above the ceiling falls");
  // A block with no resolved cells falls.
  assert.equal(wouldFall({ ...t[0], id: "b:empty", cells: [] }, []), true, "empty cells fall");
  // A healthy block resting on the base does not fall (compared against the
  // tower WITHOUT itself — overlap with its own cells is not a fall).
  assert.equal(wouldFall(t[1], [t[0]]), false);
  // Cloning it on top of the same cell (overlap) does fall.
  assert.equal(wouldFall(t[1], [t[0], t[1]]), true, "duplicate occupancy falls");
});

// ═══════════════════════════════════════════════════════════════════
// Elimination trimming
// ═══════════════════════════════════════════════════════════════════

test("first elimination keeps the bottom half of the tower and rebases it", () => {
  let t = [];
  for (let i = 1; i <= 10; i += 1) {
    t = simulatePlacement(t, {
      shape: "short",
      x: 0,
      rotation: 0,
      blockId: `b:${i}`,
      placedByUserId: "u1",
      turnNumber: i,
    }).tower;
  }
  const { tower, removedBlockIds } = trimTowerAfterElimination(t, 1);
  assert.equal(removedBlockIds.length, 5, "top half removed");
  assert.equal(tower.length, 5, "bottom half retained");
  assert.equal(Math.min(...tower.map((b) => b.cells[0].z)), 1, "retained cells rebased to the floor");
  assert.equal(isStable(tower), true);
});

test("later eliminations keep the top quarter of the current tower", () => {
  let t = [];
  for (let i = 1; i <= 8; i += 1) {
    t = simulatePlacement(t, {
      shape: "short",
      x: 1,
      rotation: 0,
      blockId: `b:${i}`,
      placedByUserId: "u1",
      turnNumber: i,
    }).tower;
  }
  const { tower, removedBlockIds } = trimTowerAfterElimination(t, 3);
  // Keep z ≥ ceil(8 × 0.75) = 6 → the top three cells survive the trim.
  assert.equal(removedBlockIds.length, 5, "lower five removed");
  assert.equal(tower.length, 3, "top quarter retained");
  assert.equal(Math.min(...tower.map((b) => b.cells[0].z)), 1, "rebased to the floor");
  assert.equal(isStable(tower), true);
});

// ═══════════════════════════════════════════════════════════════════
// Determinism + safe-drop search + resource pools
// ═══════════════════════════════════════════════════════════════════

test("simulatePlacement is deterministic for identical inputs", () => {
  const params = {
    shape: "square",
    x: 2,
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

test("findSafeDrop prefers the smallest available shape, centered", () => {
  const t = buildTower([
    ["short", 0],
    ["short", 0],
  ]);
  const safe = findSafeDrop(t, ["long", "big", "short", "square"]);
  assert.ok(safe, "a safe drop exists");
  assert.equal(safe.shape, "short", "smallest safe shape wins");
  const probe = applyPlacementBlock(t, {
    shape: safe.shape,
    x: safe.x,
    rotation: safe.rotation,
    blockId: "probe",
    placedByUserId: "",
    turnNumber: 0,
  });
  assert.equal(wouldFall(probe, t), false, `chosen ${safe.shape}@${safe.x} is stable`);
});

test("findSafeDrop refuses any shape that would cross the ceiling", () => {
  // Fill the floor to z=23 everywhere — only a 1-cell block still fits
  // (z=24), so with only the 3×2 big block available nothing is safe.
  let t = [];
  for (let layer = 0; layer < 23; layer += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      t = simulatePlacement(t, {
        shape: "short",
        x,
        rotation: 0,
        blockId: `b:${layer}:${x}`,
        placedByUserId: "u1",
        turnNumber: t.length + 1,
      }).tower;
    }
  }
  assert.equal(findSafeDrop(t, ["big"]), null, "big block cannot fit under the ceiling");
  // A short cube still fits at z=24.
  const safe = findSafeDrop(t, ["big", "short"]);
  assert.equal(safe.shape, "short");
  const probe = simulatePlacement(t, {
    shape: "short",
    x: safe.x,
    rotation: 0,
    blockId: "probe",
    placedByUserId: "",
    turnNumber: 0,
  });
  assert.equal(probe.collapsed, false, "ceiling-level short cube is stable");
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
  // The pool includes the newly added large shapes too.
  assert.ok(a1.some((p) => p.shape === "long"), "long beams appear in pools");
  assert.ok(a1.some((p) => p.shape === "big"), "big blocks appear in pools");
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
