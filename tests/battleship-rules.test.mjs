/**
 * battleship-rules.test.mjs
 *
 * The PURE Battleship rules engine, pinned rule by rule.
 *
 * Placement (every length, both orientations, bounds, overlap, touching),
 * combat (miss / hit / sunk / duplicate attacks), simultaneous resolution
 * (including the mutual final blow that must be a DRAW), state validation, the
 * public projections that must never carry an enemy fleet, and the immutability
 * property the whole design rests on: resolving a round never mutates the state
 * it was given.
 *
 * Run:  node --import tsx --test tests/battleship-rules.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BOARD_CELL,
  BOARD_COLUMNS,
  BOARD_ROWS,
  FLEET_CELL_COUNT,
  FLEET_SIZE,
  FLEET_SPEC,
  MATCH_OUTCOME,
  MATCH_STATUS,
  REJECTION,
  SHIP_KEYS,
  SHOT_RESULTS,
} from "../src/lib/battleship/constants.ts";
import {
  BattleshipRuleError,
  createMatchState,
  emptyBoard,
  evaluateShot,
  fleetDestroyed,
  formatCoordinate,
  hasAttacked,
  matchViewForSeat,
  outcomeForSeat,
  parseCoordinate,
  publicMatchState,
  resolveRound,
  shipAt,
  shipCells,
  validateFleet,
  validateMatchState,
  validateShipPlacement,
} from "../src/lib/battleship/rules.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────

/** A's fleet: rows 1/3/5/7/9 in columns A–D. */
const FLEET_A = {
  ships: [
    { ship: "carrier", orientation: "horizontal", x: 0, y: 0 },
    { ship: "battleship", orientation: "horizontal", x: 0, y: 2 },
    { ship: "cruiser", orientation: "horizontal", x: 0, y: 4 },
    { ship: "submarine", orientation: "horizontal", x: 0, y: 6 },
    { ship: "frigate", orientation: "horizontal", x: 0, y: 1 },
    { ship: "destroyer", orientation: "horizontal", x: 0, y: 8 },
  ],
};

/** B's fleet: the same shape, shifted to columns F–J, so the two boards'
 *  coordinates never coincide — which is what lets the hidden-data test prove a
 *  coordinate in the view came from the viewer's own fleet, not the enemy's. */
const FLEET_B = {
  ships: [
    { ship: "carrier", orientation: "horizontal", x: 5, y: 0 },
    { ship: "battleship", orientation: "horizontal", x: 5, y: 2 },
    { ship: "cruiser", orientation: "horizontal", x: 5, y: 4 },
    { ship: "submarine", orientation: "horizontal", x: 5, y: 6 },
    { ship: "frigate", orientation: "horizontal", x: 5, y: 1 },
    { ship: "destroyer", orientation: "horizontal", x: 5, y: 8 },
  ],
};

/** Every cell of A, in fleet order. */
const A_CELLS = ["A1", "B1", "C1", "D1", "E1", "A3", "B3", "C3", "D3", "A5", "B5", "C5", "A7", "B7", "C7", "A2", "B2", "C2", "A9", "B9"];
/** Every cell of B, in fleet order. */
const B_CELLS = ["F1", "G1", "H1", "I1", "J1", "F3", "G3", "H3", "I3", "F5", "G5", "H5", "F7", "G7", "H7", "F2", "G2", "H2", "F9", "G9"];

const newState = () => createMatchState({ player1: FLEET_A, player2: FLEET_B });

/** Plays one round and insists the engine accepted it. */
function playRound(state, player1, player2) {
  const resolved = resolveRound(state, { player1, player2 });
  assert.ok(resolved.ok, `round rejected: ${resolved.message}`);
  return resolved;
}

/** Plays a whole sequence of rounds. */
function playRounds(state, player1Shots, player2Shots) {
  let current = state;
  const rounds = [];
  for (let index = 0; index < player1Shots.length; index += 1) {
    const resolved = playRound(current, player1Shots[index], player2Shots[index]);
    rounds.push(resolved.round);
    current = resolved.state;
  }
  return { state: current, rounds };
}

// ── Board geometry ────────────────────────────────────────────────────────

test("the board is 14x10 and the fleet is six ships occupying 20 cells", () => {
  assert.equal(BOARD_COLUMNS, 14);
  assert.equal(BOARD_ROWS, 10);
  assert.equal(FLEET_SIZE, 6);
  assert.equal(FLEET_CELL_COUNT, 20);
  assert.deepEqual(SHIP_KEYS, [
    "carrier",
    "battleship",
    "cruiser",
    "submarine",
    "frigate",
    "destroyer",
  ]);
  assert.deepEqual(
    FLEET_SPEC.map((ship) => [ship.key, ship.length]),
    [
      ["carrier", 5],
      ["battleship", 4],
      ["cruiser", 3],
      ["submarine", 3],
      ["frigate", 3],
      ["destroyer", 2],
    ],
  );
  assert.equal(FLEET_SPEC.reduce((sum, ship) => sum + ship.length, 0), 20);
  assert.equal(emptyBoard().length, BOARD_ROWS);
  assert.equal(emptyBoard()[0].length, BOARD_COLUMNS);
  assert.equal(emptyBoard()[BOARD_ROWS - 1][BOARD_COLUMNS - 1], BOARD_CELL.UNKNOWN);
});

test("coordinates parse as A1..N10 and print canonically", () => {
  assert.deepEqual(parseCoordinate("A1"), { x: 0, y: 0 });
  assert.deepEqual(parseCoordinate("j10"), { x: 9, y: 9 });
  assert.deepEqual(parseCoordinate("n10"), { x: 13, y: 9 });
  assert.deepEqual(parseCoordinate(" b7 "), { x: 1, y: 6 });
  assert.deepEqual(parseCoordinate({ x: 2, y: 3 }), { x: 2, y: 3 });

  for (const bad of ["O1", "A11", "A0", "A01", "1A", "", "  ", "AA1", null, undefined, 7]) {
    assert.equal(parseCoordinate(bad), null, `${String(bad)} must not parse`);
  }
  assert.equal(parseCoordinate({ x: 1.5, y: 2 }), null);
  assert.equal(parseCoordinate({ x: "1", y: 2 }), null);

  assert.equal(formatCoordinate({ x: 0, y: 0 }), "A1");
  assert.equal(formatCoordinate({ x: 9, y: 9 }), "J10");
  assert.equal(formatCoordinate({ x: 13, y: 9 }), "N10");
});

// ── Placement ─────────────────────────────────────────────────────────────

test("every ship occupies exactly its required number of consecutive cells", () => {
  for (const ship of FLEET_SPEC) {
    const horizontal = validateShipPlacement({ ship: ship.key, orientation: "horizontal", x: 0, y: 0 });
    assert.ok(horizontal.ok, `${ship.key} must place horizontally`);
    assert.equal(horizontal.cells.length, ship.length);
    assert.deepEqual(
      horizontal.cells.map(formatCoordinate),
      Array.from({ length: ship.length }, (_, index) => formatCoordinate({ x: index, y: 0 })),
    );

    const vertical = validateShipPlacement({ ship: ship.key, orientation: "vertical", x: 0, y: 0 });
    assert.ok(vertical.ok, `${ship.key} must place vertically`);
    assert.equal(vertical.cells.length, ship.length);
    assert.deepEqual(
      vertical.cells.map(formatCoordinate),
      Array.from({ length: ship.length }, (_, index) => formatCoordinate({ x: 0, y: index })),
    );
  }
});

test("horizontal and vertical placements are read from their first cell", () => {
  const carrier = validateShipPlacement({ ship: "carrier", orientation: "horizontal", x: 0, y: 0 });
  assert.deepEqual(carrier.cells.map(formatCoordinate), ["A1", "B1", "C1", "D1", "E1"]);

  const battleship = validateShipPlacement({ ship: "battleship", orientation: "vertical", x: 0, y: 0 });
  assert.deepEqual(battleship.cells.map(formatCoordinate), ["A1", "A2", "A3", "A4"]);
});

test("a placement that leaves the board is rejected", () => {
  const cases = [
    { ship: "carrier", orientation: "horizontal", x: 10, y: 0 }, // K..O
    { ship: "carrier", orientation: "vertical", x: 0, y: 6 }, // rows 7..11
    { ship: "destroyer", orientation: "horizontal", x: 13, y: 0 }, // N,O
    { ship: "destroyer", orientation: "vertical", x: 0, y: 9 }, // rows 10,11
  ];
  for (const placement of cases) {
    const verdict = validateShipPlacement(placement);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, REJECTION.OUT_OF_BOUNDS);
  }
});

test("a placement with an unknown ship, orientation or cell is rejected", () => {
  assert.equal(
    validateShipPlacement({ ship: "submarine-2", orientation: "horizontal", x: 0, y: 0 }).code,
    REJECTION.INVALID_SHIP,
  );
  assert.equal(
    validateShipPlacement({ ship: "carrier", orientation: "diagonal", x: 0, y: 0 }).code,
    REJECTION.INVALID_ORIENTATION,
  );
  assert.equal(
    validateShipPlacement({ ship: "carrier", orientation: "horizontal", x: 0.5, y: 0 }).code,
    REJECTION.INVALID_COORDINATE,
  );
});

test("a complete legal fleet validates with 20 occupied cells", () => {
  const verdict = validateFleet(FLEET_A);
  assert.ok(verdict.ok);
  assert.equal(Object.values(verdict.cells).reduce((sum, cells) => sum + cells.length, 0), 20);
  for (const ship of FLEET_SPEC) {
    assert.equal(verdict.cells[ship.key].length, ship.length);
  }
});

test("overlapping ships are rejected", () => {
  const fleet = {
    ships: [
      { ship: "carrier", orientation: "horizontal", x: 0, y: 0 }, // A1..E1
      { ship: "battleship", orientation: "horizontal", x: 2, y: 0 }, // C1..F1 — shares C1
      { ship: "cruiser", orientation: "horizontal", x: 0, y: 2 },
      { ship: "submarine", orientation: "horizontal", x: 0, y: 4 },
      { ship: "frigate", orientation: "horizontal", x: 0, y: 8 },
      { ship: "destroyer", orientation: "horizontal", x: 0, y: 6 },
    ],
  };
  const verdict = validateFleet(fleet);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, REJECTION.OVERLAP);
  assert.match(verdict.message, /C1/);
});

test("ships may touch orthogonally", () => {
  const fleet = {
    ships: [
      { ship: "carrier", orientation: "horizontal", x: 0, y: 0 }, // A1..E1
      { ship: "battleship", orientation: "horizontal", x: 0, y: 1 }, // A2..D2, directly below
      { ship: "cruiser", orientation: "horizontal", x: 0, y: 3 },
      { ship: "submarine", orientation: "horizontal", x: 0, y: 5 },
      { ship: "frigate", orientation: "horizontal", x: 0, y: 9 },
      { ship: "destroyer", orientation: "horizontal", x: 0, y: 7 },
    ],
  };
  assert.ok(validateFleet(fleet).ok);
});

test("ships may touch diagonally", () => {
  // E1 and F2 share only a corner: no orthogonal adjacency anywhere.
  const fleet = {
    ships: [
      { ship: "carrier", orientation: "horizontal", x: 0, y: 0 }, // A1..E1
      { ship: "destroyer", orientation: "horizontal", x: 5, y: 1 }, // F2..G2
      { ship: "battleship", orientation: "horizontal", x: 0, y: 3 },
      { ship: "cruiser", orientation: "horizontal", x: 0, y: 5 },
      { ship: "submarine", orientation: "horizontal", x: 0, y: 7 },
      { ship: "frigate", orientation: "horizontal", x: 5, y: 3 },
    ],
  };
  assert.ok(validateFleet(fleet).ok);
});

test("a fleet with the wrong number of ships is rejected", () => {
  const verdict = validateFleet({ ships: FLEET_A.ships.slice(0, 4) });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, REJECTION.WRONG_FLEET_SIZE);
});

test("a duplicated ship is rejected", () => {
  const verdict = validateFleet({
    ships: [
      ...FLEET_A.ships.slice(0, 5),
      { ship: "cruiser", orientation: "horizontal", x: 0, y: 8 },
    ],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, REJECTION.DUPLICATE_SHIP);
});

test("a missing fleet is rejected", () => {
  assert.equal(validateFleet(null).code, REJECTION.INVALID_FLEET);
  assert.equal(validateFleet({ ships: [] }).code, REJECTION.WRONG_FLEET_SIZE);
});

// ── Combat ────────────────────────────────────────────────────────────────

test("a shot on open water is a MISS", () => {
  const resolution = evaluateShot(FLEET_B, [], parseCoordinate("A10"));
  assert.equal(resolution.result, SHOT_RESULTS.MISS);
  assert.equal(resolution.coordinate, "A10");
  assert.equal(resolution.ship, null);
});

test("a shot on a ship with undamaged cells is a HIT", () => {
  const resolution = evaluateShot(FLEET_B, [], parseCoordinate("F1"));
  assert.equal(resolution.result, SHOT_RESULTS.HIT);
  assert.equal(resolution.ship, null, "a hit must not name the ship");
  assert.equal(shipAt(FLEET_B, parseCoordinate("F1")), "carrier");
});

test("a ship sinks on its last undamaged cell", () => {
  const first = playRound(newState(), "F9", "J10");
  const second = playRound(first.state, "G9", "J9");
  assert.equal(first.round.attacks.player1.result, SHOT_RESULTS.HIT);
  assert.equal(second.round.attacks.player1.result, SHOT_RESULTS.SUNK);
  assert.equal(second.round.attacks.player1.ship, "destroyer");
});

test("an already attacked coordinate cannot be attacked again", () => {
  const { state } = playRound(newState(), "F1", "A10");
  const replay = resolveRound(state, { player1: "F1", player2: "B10" });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, REJECTION.ALREADY_ATTACKED);
  assert.equal(replay.invalid.player1, REJECTION.ALREADY_ATTACKED);
  assert.equal(hasAttacked(state.players.player1.attacks, parseCoordinate("F1")), true);
  assert.equal(hasAttacked(state.players.player1.attacks, parseCoordinate("F2")), false);
});

test("the two players may attack the same coordinate on their own boards", () => {
  const resolved = playRound(newState(), "F1", "F1");
  assert.equal(resolved.round.attacks.player1.result, SHOT_RESULTS.HIT); // B's carrier
  assert.equal(resolved.round.attacks.player2.result, SHOT_RESULTS.MISS); // A has no F file
});

test("an unreadable or off-board attack is rejected and nothing is applied", () => {
  const state = newState();
  const snapshot = JSON.stringify(state);

  const unreadable = resolveRound(state, { player1: "O1", player2: "A1" });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.invalid.player1, REJECTION.INVALID_COORDINATE);

  const offBoard = resolveRound(state, { player1: { x: 14, y: 0 }, player2: "A1" });
  assert.equal(offBoard.ok, false);
  assert.equal(offBoard.invalid.player1, REJECTION.OUT_OF_BOUNDS);

  assert.equal(JSON.stringify(state), snapshot, "a rejected round must not touch the state");
});

// ── Resolution ────────────────────────────────────────────────────────────

test("destroying all six enemy ships wins the match on that round", () => {
  const { state, rounds } = playRounds(
    newState(),
    B_CELLS,
    A_CELLS.slice(0, A_CELLS.length - 1).concat("J10"),
  );

  for (let index = 0; index < B_CELLS.length - 1; index += 1) {
    assert.equal(rounds[index].outcome, null, `round ${index + 1} must continue`);
    assert.equal(rounds[index].status, MATCH_STATUS.PLAYING);
  }
  const final = rounds[rounds.length - 1];
  assert.equal(final.outcome, MATCH_OUTCOME.PLAYER1);
  assert.equal(final.status, MATCH_STATUS.FINISHED);
  assert.deepEqual(final.destroyed, { player1: true, player2: false });
  assert.equal(state.winner, "player1");
  assert.equal(state.round, B_CELLS.length, "a finished match stays on its deciding round");
  assert.equal(fleetDestroyed(FLEET_B, state.players.player1.attacks), true);
  assert.equal(fleetDestroyed(FLEET_A, state.players.player2.attacks), false);
});

test("both fleets destroyed by the same round is a DRAW, not a winner", () => {
  // One cell short of each fleet: each board has a single enemy cell standing.
  const { state } = playRounds(newState(), B_CELLS.slice(0, -1), A_CELLS.slice(0, -1));
  assert.equal(state.status, MATCH_STATUS.PLAYING);

  const final = playRound(
    state,
    B_CELLS[B_CELLS.length - 1],
    A_CELLS[A_CELLS.length - 1],
  );
  assert.equal(final.round.attacks.player1.result, SHOT_RESULTS.SUNK);
  assert.equal(final.round.attacks.player2.result, SHOT_RESULTS.SUNK);
  assert.deepEqual(final.round.destroyed, { player1: true, player2: true });
  assert.equal(final.round.outcome, MATCH_OUTCOME.DRAW);
  assert.equal(final.state.winner, null);
  assert.equal(final.round.roundAdvanced, false);
  assert.equal(outcomeForSeat(final.state.outcome, "player1"), "draw");
  assert.equal(outcomeForSeat(final.state.outcome, "player2"), "draw");
});

test("a losing player's own attack still resolves on the deciding round", () => {
  const { state } = playRounds(newState(), B_CELLS.slice(0, -1), A_CELLS.slice(0, -1));
  const final = playRound(state, B_CELLS[B_CELLS.length - 1], "J10");

  assert.equal(final.round.outcome, MATCH_OUTCOME.PLAYER1);
  assert.equal(final.round.attacks.player2.result, SHOT_RESULTS.MISS);
  assert.equal(
    final.state.players.player2.attacks.length,
    B_CELLS.length,
    "the losing shot is recorded",
  );
  assert.equal(final.round.attacks.player2.coordinate, "J10");
});

test("neither attack can change the other's validity in the same round", () => {
  // Player 2 fires at a cell that player 1 is ALSO firing at, on the same round,
  // and on the same coordinate as a previous player-1 hit: the two boards are
  // independent, so both are judged against their own pre-round position.
  const { state } = playRound(newState(), "F1", "F1");
  const second = playRound(state, "G1", "G1");
  assert.equal(second.round.attacks.player1.result, SHOT_RESULTS.HIT);
  assert.equal(second.round.attacks.player2.result, SHOT_RESULTS.MISS);
  assert.equal(second.state.players.player1.attacks.length, 2);
  assert.equal(second.state.players.player2.attacks.length, 2);
});

test("resolving a round never mutates the state it was given", () => {
  const state = newState();
  const before = JSON.stringify(state);
  playRound(state, "F1", "A10");
  assert.equal(JSON.stringify(state), before);
  assert.equal(state.round, 1);
  assert.equal(state.players.player1.attacks.length, 0);
  assert.equal(state.players.player2.attacks.length, 0);
});

test("a finished match accepts no further rounds", () => {
  const { state } = playRounds(
    newState(),
    B_CELLS,
    A_CELLS.slice(0, A_CELLS.length - 1).concat("J10"),
  );
  const again = resolveRound(state, { player1: "A1", player2: "A1" });
  assert.equal(again.ok, false);
  assert.equal(again.code, REJECTION.MATCH_FINISHED);
});

test("WIN / LOSS / DRAW / CONTINUE are derived per seat", () => {
  assert.equal(outcomeForSeat(null, "player1"), "continue");
  assert.equal(outcomeForSeat(MATCH_OUTCOME.PLAYER1, "player1"), "win");
  assert.equal(outcomeForSeat(MATCH_OUTCOME.PLAYER1, "player2"), "loss");
  assert.equal(outcomeForSeat(MATCH_OUTCOME.PLAYER2, "player2"), "win");
  assert.equal(outcomeForSeat(MATCH_OUTCOME.DRAW, "player1"), "draw");
});

// ── State validation ──────────────────────────────────────────────────────

test("a fresh match is playing, at round 1, with no attacks", () => {
  const state = newState();
  assert.deepEqual(validateMatchState(state), { ok: true });
  assert.equal(state.status, MATCH_STATUS.PLAYING);
  assert.equal(state.round, 1);
  assert.equal(state.players.player1.attacks.length, 0);
  assert.equal(state.players.player2.attacks.length, 0);
});

test("a fleet that cannot exist cannot open a match", () => {
  assert.throws(
    () => createMatchState({ player1: FLEET_A, player2: { ships: FLEET_B.ships.slice(0, 4) } }),
    (error) => error instanceof BattleshipRuleError && error.code === REJECTION.WRONG_FLEET_SIZE,
  );
});

test("invalid match states are refused", () => {
  const seeded = playRound(newState(), "F1", "A10").state;

  const badRound = structuredClone(seeded);
  badRound.round = 0;
  assert.equal(validateMatchState(badRound).code, REJECTION.INVALID_ROUND);

  const duplicateAttack = structuredClone(seeded);
  duplicateAttack.round = 2;
  duplicateAttack.players.player1.attacks.push({
    round: 2,
    seat: "player1",
    coordinate: "F1",
    result: SHOT_RESULTS.HIT,
    ship: null,
  });
  duplicateAttack.players.player2.attacks.push({
    round: 2,
    seat: "player2",
    coordinate: "A1",
    result: SHOT_RESULTS.MISS,
    ship: null,
  });
  assert.equal(validateMatchState(duplicateAttack).code, REJECTION.ALREADY_ATTACKED);

  const wrongResult = structuredClone(seeded);
  wrongResult.players.player1.attacks[0].result = SHOT_RESULTS.MISS;
  assert.equal(validateMatchState(wrongResult).code, REJECTION.INVALID_STATE);

  const unnamedSunk = structuredClone(seeded);
  unnamedSunk.players.player1.attacks[0].ship = "carrier";
  assert.equal(validateMatchState(unnamedSunk).code, REJECTION.INVALID_STATE);

  const unequalRounds = structuredClone(seeded);
  unequalRounds.players.player2.attacks = [];
  assert.equal(validateMatchState(unequalRounds).code, REJECTION.INVALID_STATE);

  const finished = playRounds(
    newState(),
    B_CELLS,
    A_CELLS.slice(0, A_CELLS.length - 1).concat("J10"),
  ).state;

  const finishedWithoutOutcome = structuredClone(finished);
  finishedWithoutOutcome.outcome = null;
  finishedWithoutOutcome.winner = null;
  assert.equal(validateMatchState(finishedWithoutOutcome).code, REJECTION.INVALID_STATE);

  const playingAfterDestruction = structuredClone(finished);
  playingAfterDestruction.status = MATCH_STATUS.PLAYING;
  playingAfterDestruction.outcome = null;
  playingAfterDestruction.winner = null;
  assert.equal(validateMatchState(playingAfterDestruction).code, REJECTION.INVALID_STATE);

  const impossibleOutcome = structuredClone(finished);
  impossibleOutcome.outcome = MATCH_OUTCOME.DRAW;
  impossibleOutcome.winner = null;
  assert.equal(validateMatchState(impossibleOutcome).code, REJECTION.INVALID_STATE);
});

test("an off-board coordinate in a stored log is refused", () => {
  const seeded = playRound(newState(), "F1", "A10").state;
  const corrupt = structuredClone(seeded);
  corrupt.players.player1.attacks[0].coordinate = "O1";
  assert.equal(validateMatchState(corrupt).code, REJECTION.INVALID_COORDINATE);
});

// ── Hidden information ────────────────────────────────────────────────────

test("the public projection never contains an enemy fleet", () => {
  const { state } = playRound(newState(), "F1", "A10");
  const view = matchViewForSeat(state, "player1");

  assert.equal("fleet" in view.opponent, false, "the opponent view has no fleet field");
  assert.equal(view.opponent.fleet, undefined);
  assert.deepEqual(view.you.fleet, FLEET_A, "a player may see their own fleet");

  const serialized = JSON.stringify(view);
  for (const cell of ["H5", "I3", "H7", "J1"]) {
    assert.equal(serialized.includes(`"${cell}"`), false, `${cell} must not leak`);
  }
});

test("the public match state carries no fleet positions at all", () => {
  const { state } = playRound(newState(), "F1", "A10");
  const publicState = publicMatchState(state);
  const serialized = JSON.stringify(publicState);
  assert.equal(serialized.includes("fleet"), false);
  assert.equal(serialized.includes('"H5"'), false);
  assert.equal(publicState.outcome, null);
  assert.equal(publicState.boards.player1.enemyShipsRemaining, 6);
});

test("a public board shows misses, hits and only the footprint of a sunk ship", () => {
  const { state } = playRounds(
    newState(),
    ["F1", "F9", "G9", "A10"],
    ["A10", "J10", "I10", "J9"],
  );

  const view = matchViewForSeat(state, "player1");
  assert.equal(view.you.board[0][5], BOARD_CELL.HIT, "F1 is a hit");
  assert.equal(view.you.board[9][0], BOARD_CELL.MISS, "A10 is a miss");
  assert.equal(view.you.board[8][5], BOARD_CELL.SUNK, "F9 is part of the sunk destroyer");
  assert.equal(view.you.board[8][6], BOARD_CELL.SUNK, "G9 is part of the sunk destroyer");
  assert.equal(view.you.board[1][5], BOARD_CELL.UNKNOWN, "F2 was never attacked");
  assert.deepEqual(view.you.sunkShips, ["destroyer"]);
  assert.equal(view.you.enemyShipsRemaining, 5);
  assert.deepEqual(
    view.you.attacks.map((attack) => [attack.round, attack.coordinate, attack.result]),
    [
      [1, "F1", SHOT_RESULTS.HIT],
      [2, "F9", SHOT_RESULTS.HIT],
      [3, "G9", SHOT_RESULTS.SUNK],
      [4, "A10", SHOT_RESULTS.MISS],
    ],
  );

  const opponent = matchViewForSeat(state, "player2");
  assert.equal(opponent.you.board[9][0], BOARD_CELL.MISS, "player2's own A10 shot is a miss");
  assert.equal(opponent.opponent.seat, "player1");
});

test("every cell of a ship's run is derived from its placement", () => {
  const cells = shipCells(FLEET_B.ships[5]); // destroyer F9..G9
  assert.deepEqual(cells.map(formatCoordinate), ["F9", "G9"]);
});
