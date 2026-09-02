/**
 * Tower Arena — engine + payout unit tests.
 *
 * Pure-function tests for the deterministic 2D line-tower engine and the
 * centralized placement payout math in `src/lib/tower-arena/`. These are
 * the contracts the server-authoritative state machine depends on, so
 * determinism, drop physics (support / balance / void, no height ceiling)
 * and payout bounds are tested explicitly.
 *
 * Run:  node --import tsx --test tests/tower-arena-engine.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  GRID_WIDTH,
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

test("every block shape is a solid rectangle of integer cells (none too big)", () => {
  for (const s of BLOCK_SHAPES) {
    const { w, h } = BLOCK_DIMS[s];
    assert.ok(w >= 1 && h >= 1, `${s} is at least 1×1`);
    assert.ok(w <= GRID_WIDTH, `${s} width ${w} fits the line`);
    // Blocks stay small: the widest spans just over half the floor.
    assert.ok(w <= GRID_WIDTH - 1, `${s} leaves room on the floor (w=${w})`);
    assert.equal(blockCells(s, 0).length, w * h, `${s} has w*h cells`);
    assert.ok(
      blockCells(s, 0).every(([x, z]) => Number.isInteger(x) && Number.isInteger(z)),
      `${s} cells are integers`,
    );
    assert.equal(BLOCK_FOOTPRINTS[s].length, w * h, `${s} legacy footprint agrees`);
  }
  // Block variety: widths differ (wide = risky, narrow = safe).
  assert.ok(new Set(BLOCK_SHAPES.map((s) => BLOCK_DIMS[s].w)).size >= 3, "width variety");
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
});

test("aim range has NO side walls — every aim is legal, incl. fully into the void", () => {
  for (const s of BLOCK_SHAPES) {
    for (let rot = 0; rot < 4; rot += 1) {
      const w = blockWidth(s, rot);
      const { minX, maxX } = dropRangeFor(s, rot);
      // The block may be aimed anywhere across the stage — left and right
      // of the platform — so a mis-aim can drop it straight into the void.
      assert.equal(minX, -(w), `${s} may aim fully left of the platform`);
      assert.equal(maxX, GRID_WIDTH, `${s} may aim fully right of the platform`);
      for (let x = minX; x <= maxX; x += 1) {
        assert.equal(dropInBounds(s, rot, x), true, `${s} rot${rot} x=${x} legal`);
      }
      // Only absurd aims outside the whole stage are rejected.
      assert.equal(dropInBounds(s, rot, minX - 1), false, `${s} beyond-stage-left rejected`);
      assert.equal(dropInBounds(s, rot, maxX + 1), false, `${s} beyond-stage-right rejected`);
    }
  }
});

// ── Slippery landing + contact/shock ────────────────────────────────────

test("a beam aimed half-off the floor slips one cell into a stable seat", () => {
  // 3-wide I at x=-2 touches only column 0 (1 support < 2) — too thin, but
  // the floor edge is right there: it slips +1 onto columns 0-1 and lands.
  const res = simulatePlacement([], {
    shape: "I",
    x: -2,
    rotation: 0,
    blockId: "b:1",
    placedByUserId: "u1",
    turnNumber: 1,
  });
  assert.equal(res.collapsed, false, "slippery beam finds a stable seat");
  assert.equal(res.slid, true, "it slipped sideways");
  assert.equal(res.finalX, -1, "it slipped one column toward the floor");
  assert.equal(res.placedBlock.x, -1);
  assert.equal(isStable(res.tower), true);
});

test("slips stay at the landing height — a beam on a 1-cell pillar tips off, not to the floor", () => {
  // Pillar at col 0 (2 cubes). The beam lands ON the pillar top spanning
  // -1..1 at z=3; slipping sideways at z=3 finds no support, so it tips
  // into the void (never slides DOWN beside the pillar onto the floor).
  const t = buildTower([
    ["short", 0],
    ["short", 0],
  ]);
  const res = simulatePlacement(t, {
    shape: "I",
    x: 0,
    rotation: 0,
    blockId: "b:3",
    placedByUserId: "u2",
    turnNumber: 3,
  });
  assert.equal(res.collapsed, true, "beam tips off the skinny pillar");
  assert.equal(res.slid, false, "no same-height seat exists");
  assert.deepEqual(res.tower, t, "landing fall leaves the tower untouched");
});

test("a full-miss drop beside the platform falls into the void (legal aim, no walls)", () => {
  // x=5 with a 2-wide block → columns 5 and 6 over the void: nothing to
  // land on, no slip can save it (there is no floor to slip toward the
  // block is beside the platform, not on an edge).
  const block = applyPlacementBlock([], {
    shape: "square",
    x: GRID_WIDTH,
    rotation: 0,
    blockId: "b:1",
    placedByUserId: "u1",
    turnNumber: 1,
  });
  assert.equal(block.cells.length, 0, "no in-bounds cells resolved");
  assert.equal(wouldFall(block, []), true, "miss = fall into the void");
  const res = simulatePlacement([], {
    shape: "square",
    x: GRID_WIDTH,
    rotation: 0,
    blockId: "b:1",
    placedByUserId: "u1",
    turnNumber: 1,
  });
  assert.equal(res.collapsed, true, "full miss resolves as a void fall");
  assert.equal(res.placedBlock.cells.length, 0);
  assert.deepEqual(res.tower, [], "tower unchanged, no reset");
});

test("contact + shock: a beam dropped on a Jenga brick's far end tips the brick — both fall", () => {
  // Floor beam at cols 0-2, then a flat L brick set at cols 2-3 — it
  // overhangs the beam's right edge by one cell (classic Jenga, legal).
  // Dropping a 3-wide beam onto the brick's FAR end (cols 2-4) shifts the
  // brick's load centroid past its support → the brick + the new beam tip
  // into the void together. The tower continues with the floor beam.
  let t = buildTower([["I", 0]]); // floor beam, cols 0-2
  const brick = simulatePlacement(t, { shape: "L", x: 2, rotation: 1, blockId: "b:2", placedByUserId: "u1", turnNumber: 2 });
  assert.equal(brick.collapsed, false, "the Jenga brick balances on the beam edge");
  t = brick.tower;
  const drop = simulatePlacement(t, { shape: "I", x: 2, rotation: 0, blockId: "b:3", placedByUserId: "u2", turnNumber: 3 });
  assert.equal(drop.collapsed, true, "the brick tips under the new block's weight");
  assert.ok(drop.removedBlockIds.includes("b:2"), "the shocked brick fell");
  assert.ok(drop.removedBlockIds.includes("b:3"), "the dropper's block fell with it");
  assert.equal(drop.tower.length, 1, "the tower continues with the stable floor beam");
  assert.equal(isStable(drop.tower), true);
});

test("a stack leaning off the platform can take down the ENTIRE tower — game continues on the empty floor", () => {
  // Two beams stacked progressively off the right edge (the second and third
  // overhang the platform); dropping the third pushes the whole column's
  // load past the floor edge → everything falls, leaving an empty floor.
  let t = buildTower([["I", 3]]); // cols 3-5, overhanging one cell right
  const b2 = simulatePlacement(t, { shape: "I", x: 4, rotation: 0, blockId: "b:2", placedByUserId: "u1", turnNumber: 2 });
  assert.equal(b2.collapsed, false, "second beam balances on the first");
  t = b2.tower;
  const wipe = simulatePlacement(t, { shape: "I", x: 4, rotation: 0, blockId: "b:3", placedByUserId: "u2", turnNumber: 3 });
  assert.equal(wipe.collapsed, true, "the leaning stack sheds");
  assert.equal(wipe.removedBlockIds.length, 3, "every block — incl. the base — fell");
  assert.equal(wipe.tower.length, 0, "the entire tower fell into the void");
  assert.equal(isStable(wipe.tower), true, "an empty floor is stable");
});

test("the safe-drop search avoids contact-shock sheds (not just own balance)", () => {
  // Jenga setup: a beam dropped on the brick's far end is individually
  // balanced but sheds the brick — findSafeDrop must refuse it.
  let t = buildTower([["I", 0]]);
  const brick = simulatePlacement(t, { shape: "L", x: 2, rotation: 1, blockId: "b:2", placedByUserId: "u1", turnNumber: 2 });
  t = brick.tower;
  // A beam at the brick's far end would not keep; verify directly.
  const bad = simulatePlacement(t, { shape: "I", x: 2, rotation: 0, blockId: "probe", placedByUserId: "", turnNumber: 0 });
  assert.equal(bad.collapsed, true, "the edge beam is unsafe");
  const safe = findSafeDrop(t, ["I", "L", "short", "square", "T"]);
  assert.ok(safe, "a safe drop still exists");
  const out = simulatePlacement(t, {
    shape: safe.shape,
    x: safe.x,
    rotation: safe.rotation,
    blockId: "probe",
    placedByUserId: "",
    turnNumber: 0,
  });
  assert.equal(out.collapsed, false, `chosen ${safe.shape}@${safe.x} does not shed the tower`);
});

test("centering helpers keep the block fully on the floor line", () => {
  for (const s of BLOCK_SHAPES) {
    for (let rot = 0; rot < 4; rot += 1) {
      const x = centerXFor(s, rot);
      assert.equal(centerDepthFor(s, rot), 0);
      assert.equal(fitsInGrid(blockCells(s, rot), x, 0), true, `${s} rot${rot}`);
      const { maxX } = footprintExtent(s, rot);
      assert.ok(maxX < GRID_WIDTH, `${s} rot${rot} maxX ${maxX} < 6`);
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
// Drop physics — support, balance, void (no height ceiling)
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
  // A single square at the very edge still rests fully on the floor line.
  const square = simulatePlacement([], {
    shape: "square",
    x: 0,
    rotation: 0,
    blockId: "b:1",
    placedByUserId: "u1",
    turnNumber: 1,
  });
  assert.equal(square.collapsed, false, "on the floor line nothing tips");
  assert.equal(isStable(square.tower), true);
});

test("stacked centered blocks grow a stable tower", () => {
  let t = [];
  for (let i = 1; i <= 5; i += 1) {
    const res = simulatePlacement(t, {
      shape: "square",
      x: 2,
      rotation: 0,
      blockId: `b:${i}`,
      placedByUserId: "u1",
      turnNumber: i,
    });
    assert.equal(res.collapsed, false, `level ${i} did not tip`);
    t = res.tower;
  }
  assert.equal(isStable(t), true);
});

test("a short 1×1 cube balances on a single pillar", () => {
  const t = buildTower([
    ["short", 2],
    ["short", 2],
    ["short", 2],
  ]);
  const res = simulatePlacement(t, {
    shape: "short",
    x: 2,
    rotation: 0,
    blockId: "b:4",
    placedByUserId: "u1",
    turnNumber: 4,
  });
  assert.equal(res.collapsed, false, "a unit cube always settles on the column below");
});

test("a narrow 2-wide brick balanced on a single pillar cell stays (one-cell overhang)", () => {
  // Pillar at col 2 only → a square landing there touches just col 2, its
  // center-of-mass still sits within the overhang allowance.
  const t = buildTower([
    ["short", 2],
    ["short", 2],
    ["short", 2],
  ]);
  const res = simulatePlacement(t, {
    shape: "square",
    x: 1,
    rotation: 0,
    blockId: "b:4",
    placedByUserId: "u1",
    turnNumber: 4,
  });
  assert.equal(res.collapsed, false, "2-wide block peching on a 1-cell pillar balances");
});

test("a wide block on a narrow pillar tips into the void (support too narrow)", () => {
  // 3-wide I dropped so its only support is a 1-cell pillar: needs ceil(3/2)=2.
  const t = buildTower([
    ["short", 0],
    ["short", 0],
  ]);
  const res = simulatePlacement(t, {
    shape: "I",
    x: 0,
    rotation: 0,
    blockId: "b:3",
    placedByUserId: "u2",
    turnNumber: 3,
  });
  assert.equal(res.collapsed, true, "3-wide block cannot balance on one pillar cell");
  assert.equal(res.removedBlockIds.join(","), "b:3", "the fallen block is reported");
  // The tower is UNCHANGED — nothing is trimmed, nothing is reset.
  assert.equal(res.tower.length, t.length, "tower unchanged by a void fall");
  assert.deepEqual(res.tower, t, "same blocks, same order");
  assert.equal(isStable(res.tower), true);
});

test("a 3-wide beam balanced on a 2-cell support stays", () => {
  const t = buildTower([
    ["short", 1],
    ["short", 2],
  ]);
  const res = simulatePlacement(t, {
    shape: "I",
    x: 0,
    rotation: 0,
    blockId: "b:3",
    placedByUserId: "u2",
    turnNumber: 3,
  });
  assert.equal(res.collapsed, false, "beam across two equal pillars balances");
});

test("a miss entirely into the void is flagged (no in-bounds column under the block)", () => {
  // x=5 with a 2-wide block → columns 5 and 6: col 6 is over the void, so
  // resolving at x=5 would still overlap; use an aim fully off the floor for
  // the engine-level miss check.
  const block = applyPlacementBlock([], {
    shape: "square",
    x: GRID_WIDTH, // fully right of the platform
    rotation: 0,
    blockId: "b:1",
    placedByUserId: "u1",
    turnNumber: 1,
  });
  assert.equal(block.cells.length, 0, "no in-bounds cells resolved");
  assert.equal(wouldFall(block, []), true, "miss = fall into the void");
});

test("there is NO height ceiling — an even tower can grow indefinitely", () => {
  // Regression: a perfect even spire must NEVER topple on its own; the only
  // way out is a risky drop, not an invisible height limit.
  let t = [];
  for (let i = 1; i <= 40; i += 1) {
    const res = simulatePlacement(t, {
      shape: "square",
      x: 2,
      rotation: 0,
      blockId: `b:${i}`,
      placedByUserId: "u1",
      turnNumber: i,
    });
    assert.equal(res.collapsed, false, `stacked square ${i} settles (no ceiling)`);
    t = res.tower;
  }
  assert.equal(t.length, 40, "the tower keeps growing past any old ceiling");
  assert.equal(isStable(t), true);
});

test("findSafeDrop returns a stable placement when one exists", () => {
  const t = buildTower([
    ["short", 0],
    ["short", 0],
  ]);
  const safe = findSafeDrop(t, ["I", "T", "short"]);
  assert.ok(safe, "a safe drop exists on this tower");
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

test("rotation transposes a flat beam into a tall spire (still no ceiling)", () => {
  // A rotated I = 1×3 spire: single-column support is enough (min width 1),
  // and nothing caps how high it can reach.
  let t = [];
  for (let i = 1; i <= 6; i += 1) {
    const r = simulatePlacement(t, {
      shape: "I",
      x: 2,
      rotation: 1,
      blockId: `b:${i}`,
      placedByUserId: "u1",
      turnNumber: i,
    });
    assert.equal(r.collapsed, false, `spire section ${i} settles`);
    t = r.tower;
  }
  // 6 sections × 3 cells = 18 tall, stable.
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