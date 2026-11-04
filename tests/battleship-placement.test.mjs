/**
 * battleship-placement.test.mjs
 *
 * The PURE placement model behind the placement screen.
 *
 * Placement is where a player touches the game most, so its rules are pinned
 * here rather than in the component: placing, moving by replacing, lifting,
 * rotating, auto-placing, rejecting overlaps and out-of-board cells, and the
 * confirm gate. The 60-second timer's constant is asserted too — the brief fixes
 * it, and a component reading a different number would be a silent regression.
 *
 * Run:  node --import tsx --test tests/battleship-placement.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { REJECTION } from "../src/lib/battleship/constants.ts";
import { validateFleet } from "../src/lib/battleship/rules.ts";
import { serializeFleet } from "../src/lib/battleship/fleet.ts";
import {
  PLACEMENT_SECONDS,
  autoPlace,
  clampPlacement,
  confirmPlacement,
  emptyPlacement,
  isPlaced,
  placeShip,
  placementComplete,
  placementOf,
  removeShip,
  rotate,
  toFleet,
} from "../src/lib/battleship/placement.ts";

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const carrierAt = (x, y, orientation = "horizontal") => ({ ship: "carrier", orientation, x, y });

test("the placement clock is 60 seconds", () => {
  assert.equal(PLACEMENT_SECONDS, 60);
});

test("an empty placement has no ships and cannot be confirmed", () => {
  const state = emptyPlacement();
  assert.deepEqual(state.ships, []);
  assert.equal(placementComplete(state), false);
  assert.equal(toFleet(state), null);

  const confirmed = confirmPlacement(state);
  assert.equal(confirmed.ok, false);
  assert.equal(confirmed.code, REJECTION.WRONG_FLEET_SIZE);
});

test("a ship placed on open water is accepted", () => {
  const result = placeShip(emptyPlacement(), carrierAt(0, 0));
  assert.ok(result.ok);
  assert.equal(result.state.ships.length, 1);
  assert.equal(isPlaced(result.state, "carrier"), true);
  assert.deepEqual(placementOf(result.state, "carrier"), carrierAt(0, 0));
  assert.equal(placementComplete(result.state), false);
});

test("a ship that overlaps another is refused with the shared cell named", () => {
  const placed = placeShip(emptyPlacement(), carrierAt(0, 0)); // A1..E1
  assert.ok(placed.ok);

  const clash = placeShip(placed.state, { ship: "battleship", orientation: "horizontal", x: 2, y: 0 });
  assert.equal(clash.ok, false);
  assert.equal(clash.code, REJECTION.OVERLAP);
  assert.match(clash.message, /C1/);
  assert.equal(clash.state, undefined, "a refused placement returns no state");
});

test("a ship that leaves the board is refused", () => {
  const out = placeShip(emptyPlacement(), carrierAt(10, 0)); // K..O
  assert.equal(out.ok, false);
  assert.equal(out.code, REJECTION.OUT_OF_BOUNDS);
});

test("a cell near the edge snaps the ship back onto the board", () => {
  // Clicking the last column with a five-cell carrier slides it to J..N.
  assert.deepEqual(clampPlacement(carrierAt(13, 3)), carrierAt(9, 3));
  assert.deepEqual(
    clampPlacement({ ship: "carrier", orientation: "vertical", x: 4, y: 9 }),
    { ship: "carrier", orientation: "vertical", x: 4, y: 5 },
  );

  // A placement already inside the board is untouched.
  assert.deepEqual(clampPlacement(carrierAt(2, 2)), carrierAt(2, 2));

  // And the clamped placement is the one the model accepts, so tapping an edge
  // cell places the ship rather than refusing the tap.
  const result = placeShip(emptyPlacement(), clampPlacement(carrierAt(13, 3)));
  assert.ok(result.ok, result.message);
  assert.deepEqual(placementOf(result.state, "carrier"), carrierAt(9, 3));
});

test("placing the same ship again MOVES it", () => {
  const first = placeShip(emptyPlacement(), carrierAt(0, 0));
  const moved = placeShip(first.state, carrierAt(0, 4));

  assert.ok(moved.ok);
  assert.equal(moved.state.ships.length, 1, "a move replaces, it does not duplicate");
  assert.deepEqual(placementOf(moved.state, "carrier"), carrierAt(0, 4));
});

test("a ship can be lifted back onto the shelf", () => {
  const placed = placeShip(emptyPlacement(), carrierAt(0, 0));
  const emptied = removeShip(placed.state, "carrier");
  assert.equal(emptied.ships.length, 0);
  assert.equal(isPlaced(emptied, "carrier"), false);
});

test("rotation flips both ways", () => {
  assert.equal(rotate("horizontal"), "vertical");
  assert.equal(rotate("vertical"), "horizontal");
});

test("ships may touch, including diagonally, on the placement board", () => {
  let state = emptyPlacement();
  for (const placement of [
    carrierAt(0, 0), // A1..E1
    { ship: "destroyer", orientation: "horizontal", x: 5, y: 1 }, // F2..G2 — corner contact only
    { ship: "battleship", orientation: "vertical", x: 0, y: 2 },
    { ship: "cruiser", orientation: "horizontal", x: 2, y: 4 },
    { ship: "frigate", orientation: "horizontal", x: 4, y: 6 },
    { ship: "submarine", orientation: "vertical", x: 9, y: 5 },
  ]) {
    const result = placeShip(state, placement);
    assert.ok(result.ok, `${placement.ship}: ${result.message}`);
    state = result.state;
  }
  assert.equal(placementComplete(state), true);
});

test("auto place always deals a legal, complete fleet", () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const state = autoPlace(emptyPlacement(), mulberry32(seed));
    assert.equal(state.ships.length, 6, `seed ${seed}`);
    assert.equal(placementComplete(state), true, `seed ${seed}`);
    const fleet = toFleet(state);
    assert.ok(fleet);
    assert.ok(validateFleet(fleet).ok);
  }
});

test("auto place is deterministic from its random source", () => {
  const first = autoPlace(emptyPlacement(), mulberry32(4242));
  const second = autoPlace(emptyPlacement(), mulberry32(4242));
  assert.equal(serializeFleet(toFleet(first)), serializeFleet(toFleet(second)));
});

test("confirming returns the canonical fleet once all six ships are down", () => {
  const state = autoPlace(emptyPlacement(), mulberry32(11));
  const confirmed = confirmPlacement(state);
  assert.ok(confirmed.ok);
  assert.equal(confirmed.fleet.ships.length, 6);
  assert.deepEqual(confirmed.fleet.ships.map((ship) => ship.ship), [
    "carrier",
    "battleship",
    "cruiser",
    "submarine",
    "frigate",
    "destroyer",
  ]);

  const incomplete = placeShip(emptyPlacement(), carrierAt(0, 0));
  assert.ok(incomplete.ok);
  assert.equal(confirmPlacement(incomplete.state).ok, false);
});

test("a partial fleet is never reported as complete", () => {
  let state = emptyPlacement();
  for (const key of ["carrier", "battleship", "cruiser", "submarine"]) {
    const result = placeShip(state, {
      ship: key,
      orientation: "horizontal",
      x: 0,
      y: ["carrier", "battleship", "cruiser", "submarine", "destroyer"].indexOf(key) * 2,
    });
    assert.ok(result.ok);
    state = result.state;
    assert.equal(placementComplete(state), false, `complete with only ${key}`);
  }
});
