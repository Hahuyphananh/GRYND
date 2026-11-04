/**
 * battleship-fleet.test.mjs
 *
 * Fleet DEALING and SERIALIZATION: random placement must always produce a legal
 * 20-cell fleet, must be deterministic under an injected random source, and the
 * canonical text form must round-trip — while rejecting anything tampered with.
 *
 * Run:  node --import tsx --test tests/battleship-fleet.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  FLEET_CELL_COUNT,
  FLEET_SPEC,
  SHIP_KEYS,
} from "../src/lib/battleship/constants.ts";
import {
  BattleshipRuleError,
  fleetCells,
  formatCoordinate,
  validateFleet,
} from "../src/lib/battleship/rules.ts";
import {
  deserializeFleet,
  generateRandomFleet,
  placementsFor,
  serializeFleet,
} from "../src/lib/battleship/fleet.ts";

/** Small deterministic PRNG, so a seed pins the entire deal. */
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

test("a generated fleet is always legal and uses exactly 20 cells", () => {
  for (let seed = 1; seed <= 50; seed += 1) {
    const fleet = generateRandomFleet(mulberry32(seed));
    const verdict = validateFleet(fleet);
    assert.ok(verdict.ok, `seed ${seed}: ${verdict.message}`);

    assert.equal(fleet.ships.length, 6, `seed ${seed}`);
    assert.equal(
      Object.values(verdict.cells).reduce((sum, cells) => sum + cells.length, 0),
      FLEET_CELL_COUNT,
    );
    for (const ship of FLEET_SPEC) {
      assert.equal(verdict.cells[ship.key].length, ship.length, `seed ${seed}: ${ship.key}`);
    }
    // No cell may appear twice — the total above plus this set proves it.
    const keys = new Set();
    for (const cells of Object.values(verdict.cells)) {
      for (const cell of cells) keys.add(`${cell.x},${cell.y}`);
    }
    assert.equal(keys.size, FLEET_CELL_COUNT, `seed ${seed}: overlap`);
  }
});

test("the deal is reproducible from its random source", () => {
  const first = serializeFleet(generateRandomFleet(mulberry32(12345)));
  const second = serializeFleet(generateRandomFleet(mulberry32(12345)));
  assert.equal(first, second);

  const different = serializeFleet(generateRandomFleet(mulberry32(54321)));
  assert.notEqual(first, different);
});

test("the generated fleet is in canonical fleet order", () => {
  const fleet = generateRandomFleet(mulberry32(7));
  assert.deepEqual(fleet.ships.map((ship) => ship.ship), [...SHIP_KEYS]);
});

test("a fleet serializes to one canonical form and round-trips", () => {
  const fleet = generateRandomFleet(mulberry32(99));
  const text = serializeFleet(fleet);

  assert.equal(
    text,
    SHIP_KEYS.map((key) => {
      const placement = fleet.ships.find((ship) => ship.ship === key);
      return `${key}:${formatCoordinate({ x: placement.x, y: placement.y })}:${placement.orientation}`;
    }).join(";"),
  );

  const restored = deserializeFleet(text);
  assert.deepEqual(restored, fleet);
  assert.equal(serializeFleet(restored), text);

  // Lower-case coordinates are accepted, but the canonical form is upper-case.
  const lowerCaseCell = text.replace(/:([a-n])(\d{1,2}):/i, (_, column, row) => `:${column.toLowerCase()}${row}:`);
  assert.deepEqual(deserializeFleet(lowerCaseCell), fleet);
});

test("every hand-placed fleet serializes and restores", () => {
  const fleet = {
    ships: [
      { ship: "carrier", orientation: "vertical", x: 0, y: 0 },
      { ship: "battleship", orientation: "horizontal", x: 2, y: 2 },
      { ship: "cruiser", orientation: "vertical", x: 9, y: 4 },
      { ship: "submarine", orientation: "horizontal", x: 4, y: 6 },
      { ship: "frigate", orientation: "horizontal", x: 11, y: 0 },
      { ship: "destroyer", orientation: "vertical", x: 7, y: 8 },
    ],
  };
  const text = serializeFleet(fleet);
  assert.equal(
    text,
    "carrier:A1:vertical;battleship:C3:horizontal;cruiser:J5:vertical;submarine:E7:horizontal;frigate:L1:horizontal;destroyer:H9:vertical",
  );
  assert.deepEqual(deserializeFleet(text), fleet);
});

test("serializing an illegal fleet throws instead of writing it", () => {
  assert.throws(
    () => serializeFleet({ ships: [] }),
    (error) => error instanceof BattleshipRuleError,
  );
});

test("deserializing rejects anything unreadable or illegal", () => {
  for (const bad of [
    null,
    undefined,
    "",
    "   ",
    "not-a-fleet",
    "carrier:F1:horizontal", // missing five ships
    "carrier:F1:horizontal;carrier:F1:horizontal;battleship:A1:horizontal;cruiser:A3:horizontal;submarine:A5:horizontal;frigate:A7:horizontal;destroyer:A9:horizontal",
    "carrier:K1:horizontal;battleship:A1:horizontal;cruiser:A3:horizontal;submarine:A5:horizontal;frigate:A7:horizontal;destroyer:A9:horizontal", // off the board
    "carrier:A1:diagonal;battleship:A3:horizontal;cruiser:A5:horizontal;submarine:A7:horizontal;frigate:A2:horizontal;destroyer:A9:horizontal",
  ]) {
    assert.equal(deserializeFleet(bad), null, `${String(bad)} must be refused`);
  }
});

test("placement candidates are the board's legal runs", () => {
  // Horizontal runs + vertical runs, over 14 columns × 10 rows.
  assert.equal(placementsFor("carrier").length, 184); // 10 × 10 rows + 6 × 14 columns
  assert.equal(placementsFor("battleship").length, 208); // 11 × 10 + 7 × 14
  assert.equal(placementsFor("destroyer").length, 256); // 13 × 10 + 9 × 14
  for (const placement of placementsFor("destroyer")) {
    assert.equal(placement.ship, "destroyer");
    assert.equal(validateFleet({ ships: [placement] }).ok, false, "one ship is not a fleet");
  }
});

test("fleetCells exposes every ship's cells and refuses an invalid fleet", () => {
  const fleet = generateRandomFleet(mulberry32(3));
  const cells = fleetCells(fleet);
  assert.equal(cells.carrier.length, 5);
  assert.equal(cells.destroyer.length, 2);
  assert.throws(() => fleetCells({ ships: [] }), BattleshipRuleError);
});
