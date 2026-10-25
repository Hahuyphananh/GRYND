/**
 * dominoes-layout.test.mjs
 *
 * THE TABLE GEOMETRY — where a played tile actually goes.
 *
 * `src/lib/dominoes/layout.ts` is the only thing that decides it, and it is pure,
 * so this suite can check the shape of a real table directly:
 *
 *   * the chain grows from its OPENING tile in both directions;
 *   * a double lies CROSSWISE, and the tiles after it run PERPENDICULAR to the
 *     run that led in;
 *   * a long run turns, so the table snakes and expands instead of running off
 *     the felt;
 *   * NO TWO TILES EVER OCCUPY THE SAME SQUARE — the invariant a real table must
 *     not break, checked over dozens of engine-played matches.
 *
 * Run:  node --import tsx --test tests/dominoes-layout.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  layoutChain,
  isDoubleTile,
  pivotIndex,
  RUN_CELLS,
  TILE_LENGTH_CELLS,
  TILE_WIDTH_CELLS,
} from "../src/lib/dominoes/layout.ts";
import { applyAction, createInitialState, legalActions } from "../src/lib/dominoes/rules.ts";
import { dealFromOrder } from "../src/lib/dominoes/deal.ts";
import { TILE_IDS } from "../src/lib/dominoes/constants.ts";

/* -------------------------------------------------------------------------- *
 * Helpers
 * -------------------------------------------------------------------------- */

/** The box a placed tile covers, in cells (the same maths the module uses). */
function boxOf(tile) {
  const crosswise = tile.rotation % 180 === 90;
  const w = crosswise ? TILE_WIDTH_CELLS : TILE_LENGTH_CELLS;
  const h = crosswise ? TILE_LENGTH_CELLS : TILE_WIDTH_CELLS;
  return { x0: tile.cx - w / 2, y0: tile.cy - h / 2, x1: tile.cx + w / 2, y1: tile.cy + h / 2 };
}

function overlap(a, b) {
  const epsilon = 0.01;
  return a.x0 < b.x1 - epsilon && b.x0 < a.x1 - epsilon && a.y0 < b.y1 - epsilon && b.y0 < a.y1 - epsilon;
}

const PERPENDICULAR = {
  right: ["up", "down"],
  left: ["up", "down"],
  up: ["left", "right"],
  down: ["left", "right"],
};

/** A deterministic shuffle, so every seed is reproducible without Web Crypto. */
function orderForSeed(seed) {
  const order = [...TILE_IDS];
  let state = (seed * 2654435761) % 4294967296;
  for (let index = order.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) % 4294967296;
    const swap = state % (index + 1);
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  return order;
}

/** Play one full match and hand every intermediate chain to `visit`. */
function playMatch(seed, visit) {
  let state = createInitialState(dealFromOrder(orderForSeed(seed)));
  let guard = 0;
  while (state.status === "playing" && guard < 400) {
    guard += 1;
    const legal = legalActions(state);
    if (legal.length === 0) break;
    state = applyAction(state, state.turn, legal[guard % legal.length]);
    visit(state.chain);
  }
  return state;
}

/* -------------------------------------------------------------------------- *
 * The basics
 * -------------------------------------------------------------------------- */

test("layout: an empty chain has no table", () => {
  const layout = layoutChain([]);
  assert.deepEqual(layout.tiles, []);
  assert.equal(layout.pivot, -1);
  assert.equal(layout.cols, 0);
  assert.equal(layout.rows, 0);
  // A projection that sends nothing is not an error.
  assert.deepEqual(layoutChain(null).tiles, []);
  assert.deepEqual(layoutChain(undefined).tiles, []);
});

test("layout: the opening tile sits at the origin, lying along the table", () => {
  const layout = layoutChain([{ id: "6-5", end: "left" }]);
  assert.equal(layout.tiles.length, 1);
  const [tile] = layout.tiles;
  assert.equal(tile.cx, 0);
  assert.equal(tile.cy, 0);
  assert.equal(tile.rotation, 0);
  assert.equal(tile.isDouble, false);
  // Two cells long, one wide — a real domino's 2:1 proportion.
  assert.equal(layout.cols, TILE_LENGTH_CELLS);
  assert.equal(layout.rows, TILE_WIDTH_CELLS);
});

test("layout: an opening double is drawn CROSSWISE", () => {
  const layout = layoutChain([{ id: "6-6", end: "left", isDouble: true }]);
  const [tile] = layout.tiles;
  assert.equal(tile.rotation, 90, "a double lies perpendicular to the line");
  assert.equal(tile.isDouble, true);
  // ...so the opening tile is one cell wide and two tall.
  assert.equal(layout.cols, TILE_WIDTH_CELLS);
  assert.equal(layout.rows, TILE_LENGTH_CELLS);
});

test("layout: both ends of the chain grow, each away from the opening tile", () => {
  // The engine prepends a left play, so the array reads: left segment, opening
  // tile, right segment.
  const chain = [
    { id: "5-4", end: "left", left: 5, right: 4 },
    { id: "6-5", end: "left", left: 6, right: 5 },
    { id: "6-3", end: "right", left: 6, right: 3 },
  ];
  assert.equal(pivotIndex(chain), 1, "the opening tile is the last left-attached one");
  const layout = layoutChain(chain);
  const byIndex = Object.fromEntries(layout.tiles.map((tile) => [tile.index, tile]));
  assert.ok(byIndex[0].cx < 0, "the left play widens the table to the left");
  assert.ok(byIndex[2].cx > 0, "the right play widens it to the right");
  assert.equal(byIndex[0].cy, 0);
  assert.equal(byIndex[2].cy, 0);
  // The order of the array is the order of the line.
  assert.ok(byIndex[0].cx < byIndex[1].cx && byIndex[1].cx < byIndex[2].cx);
});

test("layout: a projection with no `end` still lays the chain out in order", () => {
  const layout = layoutChain([{ id: "6-5" }, { id: "5-2" }, { id: "2-2", isDouble: true }]);
  assert.equal(layout.pivot, 0);
  assert.deepEqual(
    layout.tiles.map((tile) => tile.index),
    layout.tiles.map((_, position) => position),
  );
  const xs = layout.tiles.map((tile) => tile.cx);
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b), "left to right, as the engine ordered it");
});

/* -------------------------------------------------------------------------- *
 * Doubles pivot the table
 * -------------------------------------------------------------------------- */

test("layout: a double is crosswise and the tile after it runs perpendicular", () => {
  const chain = [
    { id: "6-5", end: "left", left: 6, right: 5 },
    { id: "5-5", end: "right", left: 5, right: 5, isDouble: true },
    { id: "5-2", end: "right", left: 5, right: 2 },
    { id: "2-1", end: "right", left: 2, right: 1 },
  ];
  const layout = layoutChain(chain);
  const double = layout.tiles.find((tile) => tile.index === 1);
  const after = layout.tiles.find((tile) => tile.index === 2);

  assert.equal(double.isDouble, true);
  assert.equal(double.rotation % 180, 90, "the double is drawn across the run");
  assert.ok(
    PERPENDICULAR[double.direction].includes(after.direction),
    `the next tile (${after.direction}) must run perpendicular to the double's run (${double.direction})`,
  );
  // ...and the tile after that carries on along the new direction.
  const third = layout.tiles.find((tile) => tile.index === 3);
  assert.equal(third.direction, after.direction);
  // A crosswise double advances the line by its short side only.
  assert.ok(Math.abs(after.cx - double.cx) <= 1.01);
});

test("layout: a run turns instead of running off the felt", () => {
  // No doubles: the path must still bend, or the table would be one endless row.
  const chain = [{ id: "6-5", end: "left" }];
  const ids = ["6-1", "5-2", "4-3", "6-4", "6-0", "5-1", "4-2", "6-3", "5-4"];
  for (const id of ids) chain.push({ id, end: "right" });

  const layout = layoutChain(chain);
  const directions = new Set(layout.tiles.map((tile) => tile.direction));
  assert.ok(directions.size > 1, "a long run has to turn");
  assert.ok(layout.rows > TILE_WIDTH_CELLS, "the table grew a second band");
  // The band it turns within is the documented one.
  const firstTurn = layout.tiles.find((tile) => tile.direction !== "right");
  assert.ok(firstTurn, "the chain turned");
  assert.ok(
    firstTurn.cx * TILE_LENGTH_CELLS >= RUN_CELLS - 1e-9,
    "the turn happens at the end of a band, not after one tile",
  );
});

/* -------------------------------------------------------------------------- *
 * The joins — the halves that match must face each other
 * -------------------------------------------------------------------------- */

/** How far apart two boxes are: 0 when they share an edge. */
function gapBetween(a, b) {
  const span = (a0, a1, b0, b1) => (a1 < b0 ? b0 - a1 : b1 < a0 ? a0 - b1 : 0);
  return Math.hypot(span(a.x0, a.x1, b.x0, b.x1), span(a.y0, a.y1, b.y0, b.y1));
}

test("layout: every neighbouring pair of tiles TOUCHES", () => {
  // `chain[i]` and `chain[i+1]` are joined on the table, wherever the join is: end
  // to end along a run, or a tile meeting a crosswise double's long side. A tile
  // floating off its neighbour is the bug this check exists to catch, whether the
  // join is a line or the T a double makes.
  for (let seed = 1; seed <= 20; seed += 1) {
    playMatch(seed, (chain) => {
      const layout = layoutChain(chain);
      const byIndex = new Map(layout.tiles.map((tile) => [tile.index, tile]));
      for (let index = 0; index + 1 < chain.length; index += 1) {
        const a = byIndex.get(index);
        const b = byIndex.get(index + 1);
        assert.ok(a && b, "both neighbours are on the table");
        const gap = gapBetween(boxOf(a), boxOf(b));
        assert.ok(
          gap < 0.01,
          `seed ${seed}: tiles ${index} and ${index + 1} do not touch (gap ${gap.toFixed(2)} cells)`,
        );
      }
    });
  }
});

test("layout: a double hands the chain off at its ENDS, not its side", () => {
  // A real double is set crosswise: the run comes into its long side, and the
  // tiles after it are laid flush against one of its two short ends, a whole cell
  // either side of its centre. Hanging the next tile off the side would leave a
  // broken join, which is what this pins.
  const chain = [
    { id: "6-5", end: "left", left: 6, right: 5 },
    { id: "5-5", end: "right", left: 5, right: 5, isDouble: true },
    { id: "5-3", end: "right", left: 5, right: 3 },
  ];
  const layout = layoutChain(chain);
  const double = layout.tiles.find((tile) => tile.index === 1);
  const after = layout.tiles.find((tile) => tile.index === 2);
  assert.equal(double.rotation % 180, 90, "the double lies across the run");
  // The double is vertical, so its ends are directly above and below its centre.
  assert.equal(after.cx, double.cx, "the next tile leaves from an END of the double");
  const box = boxOf(double);
  const next = boxOf(after);
  const touchesAnEnd = Math.abs(next.y0 - box.y1) < 1e-9 || Math.abs(next.y1 - box.y0) < 1e-9;
  assert.ok(touchesAnEnd, "it is flush against that end, not offset over the side");
});

test("layout: an opening double is left through its two ends", () => {
  const chain = [
    { id: "4-4", end: "left", left: 4, right: 4, isDouble: true },
    { id: "4-2", end: "right", left: 4, right: 2 },
  ];
  const layout = layoutChain(chain);
  const double = layout.tiles.find((tile) => tile.index === 0);
  const next = layout.tiles.find((tile) => tile.index === 1);
  assert.equal(double.rotation, 90, "the opening double is crosswise");
  assert.equal(next.cx, double.cx, "the chain leaves the double from an end");
  assert.ok(next.cy > double.cy, "and runs away from it");
});

/* -------------------------------------------------------------------------- *
 * The invariant: a table is one tile per square
 * -------------------------------------------------------------------------- */

test("layout: no two tiles overlap over 40 engine-played matches", () => {
  let boards = 0;
  let tilesSeen = 0;
  for (let seed = 1; seed <= 40; seed += 1) {
    playMatch(seed, (chain) => {
      boards += 1;
      tilesSeen = Math.max(tilesSeen, chain.length);
      const layout = layoutChain(chain);
      assert.equal(layout.tiles.length, chain.length, "every tile is placed exactly once");
      const boxes = layout.tiles.map(boxOf);
      for (let a = 0; a < boxes.length; a += 1) {
        for (let b = a + 1; b < boxes.length; b += 1) {
          assert.equal(
            overlap(boxes[a], boxes[b]),
            false,
            `seed ${seed}: tiles ${a} and ${b} share a square`,
          );
        }
      }
    });
  }
  assert.ok(boards > 100, `only ${boards} boards were checked`);
  assert.ok(tilesSeen >= 20, "the sweep must include long chains");
});

test("layout: the reported bounds contain every tile", () => {
  for (let seed = 1; seed <= 12; seed += 1) {
    playMatch(seed, (chain) => {
      const layout = layoutChain(chain);
      for (const tile of layout.tiles) {
        const box = boxOf(tile);
        assert.ok(box.x0 >= layout.minX - 1e-9, "the board is at least as wide as its tiles");
        assert.ok(box.y0 >= layout.minY - 1e-9);
        assert.ok(box.x1 <= layout.maxX + 1e-9, "no tile hangs off the right of the board");
        assert.ok(box.y1 <= layout.maxY + 1e-9);
      }
      assert.ok(layout.cols >= 0 && layout.rows >= 0);
    });
  }
});

test("layout: the board expands as the chain grows, and never shrinks at the same pivot", () => {
  let previous = null;
  playMatch(3, (chain) => {
    const layout = layoutChain(chain);
    if (previous && layout.pivot === previous.pivot) {
      for (const tile of previous.tiles) {
        const placed = layout.tiles.find((candidate) => candidate.index === tile.index);
        assert.ok(placed, "an existing tile keeps its place on the table");
        assert.equal(placed.cx, tile.cx, "a new tile never moves the ones already laid");
        assert.equal(placed.cy, tile.cy);
        assert.equal(placed.rotation, tile.rotation);
      }
      assert.ok(layout.cols >= previous.cols && layout.rows >= previous.rows);
    }
    previous = layout;
  });
});

/* -------------------------------------------------------------------------- *
 * Purity and determinism
 * -------------------------------------------------------------------------- */

test("layout: the same chain always lays out the same table", () => {
  const chain = [
    { id: "6-6", end: "left", isDouble: true },
    { id: "6-2", end: "right" },
    { id: "2-2", end: "right", isDouble: true },
    { id: "2-5", end: "right" },
    { id: "5-5", end: "right", isDouble: true },
    { id: "5-0", end: "right" },
  ];
  assert.deepEqual(layoutChain(chain), layoutChain(chain));
});

test("layout: `isDoubleTile` trusts the engine's flag, and falls back to the id", () => {
  assert.equal(isDoubleTile({ id: "5-5", isDouble: true }), true);
  assert.equal(isDoubleTile({ id: "5-4", isDouble: false }), false);
  assert.equal(isDoubleTile({ id: "3-3" }), true, "an unflagged double is still a double");
  assert.equal(isDoubleTile({ id: "3-4" }), false);
  assert.equal(isDoubleTile({ id: "nonsense" }), false);
});

test("layout: the module is pure — no React, no engine, no DOM", () => {
  const source = readFileSync(new URL("../src/lib/dominoes/layout.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "react"/);
  assert.doesNotMatch(source, /next\//);
  assert.doesNotMatch(source, /drizzle|db\/client|serverStore/);
  assert.doesNotMatch(source, /from "\.\/rules"/, "the layout draws a position, it does not rule on one");
  assert.doesNotMatch(source, /window\.|document\.|localStorage/);
});
