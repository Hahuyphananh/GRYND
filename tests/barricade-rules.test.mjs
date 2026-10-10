/**
 * barricade-rules.test.mjs
 *
 * The PURE Barricade rules engine, pinned exhaustively.
 *
 * Barricade is a 9×9 race in which each turn is exactly one pawn step (or jump)
 * or one two-square barricade, and a barricade may never seal off the last route
 * to either goal. This suite is the referee: setup, movement, jumps, wall
 * geometry, path preservation, victory and terminal behaviour, plus the
 * anti-cheat property — every rejection leaves the authoritative state byte for
 * byte untouched, and the engine's own generated actions are always accepted by
 * its own validator (asserted by a deterministic self-play fuzz, not by hope).
 *
 * The reference rules are quoted in src/lib/barricade/constants.ts and the two
 * judgement calls are written up in docs/GAME_BARRICADE.md.
 *
 * Run:  node --import tsx --test tests/barricade-rules.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BOARD_SIZE,
  MATCH_STATUS,
  MOVE_KINDS,
  ORIENTATIONS,
  REJECTION,
  WALL_SLOTS,
} from "../src/lib/barricade/constants.ts";
import {
  BarricadeRuleError,
  applyAction,
  baselineRowFor,
  classifyPawnMove,
  classifyWall,
  cloneState,
  createInitialState,
  distanceToGoal,
  findBlockingWall,
  findWallConflict,
  goalRowFor,
  hasPathToGoal,
  isBarricadeRuleError,
  isMatchFinished,
  isStepBlocked,
  legalActions,
  legalMoves,
  legalWalls,
  otherSeat,
  positionKey,
  startPositionFor,
  tryApplyAction,
  validateAction,
  wallBlocksStep,
  wallKey,
  wallSealsAPath,
  wallsConflict,
} from "../src/lib/barricade/rules.ts";

/* -------------------------------------------------------------------------- *
 * Helpers
 * -------------------------------------------------------------------------- */

/** A barricade placement literal. */
function wall(col, row, orientation) {
  return { col, row, orientation };
}

/** A square literal. */
function pos(col, row) {
  return { col, row };
}

/** A state built on top of the initial position, with only what a test cares about. */
function stateWith(overrides = {}) {
  const base = createInitialState();
  const { pawns, walls = [], wallsRemaining = {}, status, turn, ply, winner } = overrides;
  return {
    ...base,
    status: status ?? base.status,
    turn: turn ?? base.turn,
    ply: ply ?? base.ply,
    pawns: { ...base.pawns, ...pawns },
    walls,
    wallsRemaining: { ...base.wallsRemaining, ...wallsRemaining },
    winner: winner ?? null,
    outcome: null,
    lastAction: null,
  };
}

/** Recursively freeze a plain state so any mutation attempt throws in strict mode. */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** Deep snapshot for "nothing changed" assertions. */
function snapshot(state) {
  return JSON.stringify(state);
}

function moveKeys(state, seat) {
  return legalMoves(state, seat).map((action) => positionKey(action.to));
}

function wallKeys(state, seat) {
  return legalWalls(state, seat).map((action) => wallKey(action.wall));
}

/* -------------------------------------------------------------------------- *
 * An independent reference implementation, used to validate the engine
 * -------------------------------------------------------------------------- */

const STEP_VECTORS = [
  [0, 1],
  [0, -1],
  [-1, 0],
  [1, 0],
];

function inBounds(cell) {
  return (
    Number.isInteger(cell.col) &&
    Number.isInteger(cell.row) &&
    cell.col >= 0 &&
    cell.col < BOARD_SIZE &&
    cell.row >= 0 &&
    cell.row < BOARD_SIZE
  );
}

/**
 * Reference groove test, written straight from the geometry: a step between two
 * orthogonally adjacent squares crosses the groove line at the mid coordinate,
 * and a two-square barricade covers that line for exactly two columns/rows.
 */
function referenceStepBlocked(walls, from, to) {
  const boundaryRow = Math.min(from.row, to.row);
  const boundaryCol = Math.min(from.col, to.col);
  return walls.some((barricade) => {
    if (barricade.orientation === "horizontal") {
      if (from.col !== to.col || Math.abs(from.row - to.row) !== 1) return false;
      return (
        barricade.row === boundaryRow &&
        from.col >= barricade.col &&
        from.col <= barricade.col + 1
      );
    }
    if (from.row !== to.row || Math.abs(from.col - to.col) !== 1) return false;
    return (
      barricade.col === boundaryCol &&
      from.row >= barricade.row &&
      from.row <= barricade.row + 1
    );
  });
}

/** Reference BFS over the board, using the reference groove test. */
function referenceDistance(state, seat) {
  const goal = goalRowFor(seat);
  const start = state.pawns[seat];
  if (start.row === goal) return 0;
  const seen = new Set([positionKey(start)]);
  let frontier = [start];
  let distance = 0;
  while (frontier.length > 0) {
    distance += 1;
    const next = [];
    for (const cell of frontier) {
      for (const [dc, dr] of STEP_VECTORS) {
        const to = pos(cell.col + dc, cell.row + dr);
        if (!inBounds(to)) continue;
        if (referenceStepBlocked(state.walls, cell, to)) continue;
        const key = positionKey(to);
        if (seen.has(key)) continue;
        if (to.row === goal) return distance;
        seen.add(key);
        next.push(to);
      }
    }
    frontier = next;
  }
  return Number.POSITIVE_INFINITY;
}

function referenceWallKeys(state, seat) {
  if (state.wallsRemaining[seat] <= 0) return [];
  const keys = [];
  for (let row = 0; row < WALL_SLOTS; row += 1) {
    for (let col = 0; col < WALL_SLOTS; col += 1) {
      for (const orientation of ORIENTATIONS) {
        const candidate = wall(col, row, orientation);
        if (findWallConflict(state.walls, candidate)) continue;
        const trial = { ...state, walls: [...state.walls, candidate] };
        if (!Number.isFinite(referenceDistance(trial, "player1"))) continue;
        if (!Number.isFinite(referenceDistance(trial, "player2"))) continue;
        keys.push(wallKey(candidate));
      }
    }
  }
  return keys;
}

/** Deterministic PRNG so the fuzz below is reproducible in CI. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* -------------------------------------------------------------------------- *
 * 1. Initial board and pawn placement
 * -------------------------------------------------------------------------- */

test("barricade: the initial position matches the published setup", () => {
  const state = createInitialState();

  assert.equal(state.status, MATCH_STATUS.PLAYING);
  assert.equal(state.turn, "player1");
  assert.equal(state.ply, 0);
  assert.equal(state.winner, null);
  assert.equal(state.outcome, null);
  assert.equal(state.lastAction, null);
  assert.deepEqual(state.walls, []);
  assert.equal(isMatchFinished(state), false);

  // "Each player starts on the middle square of their back row."
  assert.deepEqual(state.pawns.player1, pos(4, 0));
  assert.deepEqual(state.pawns.player2, pos(4, 8));
  assert.deepEqual(startPositionFor("player1"), pos(4, 0));
  assert.deepEqual(startPositionFor("player2"), pos(4, 8));

  // 9×9 board, opposite baselines, 10 barricades each.
  assert.equal(BOARD_SIZE, 9);
  assert.equal(baselineRowFor("player1"), 0);
  assert.equal(baselineRowFor("player2"), 8);
  assert.equal(goalRowFor("player1"), 8);
  assert.equal(goalRowFor("player2"), 0);
  assert.deepEqual(state.wallsRemaining, { player1: 10, player2: 10 });
});

test("barricade: neither pawn is trapped at the start and the full menu is open", () => {
  const state = createInitialState();

  assert.equal(distanceToGoal(state, "player1"), 8);
  assert.equal(distanceToGoal(state, "player2"), 8);
  assert.equal(hasPathToGoal(state, "player1"), true);
  assert.equal(hasPathToGoal(state, "player2"), true);

  // player1 must walk up from the bottom edge: left, right or up — never down.
  assert.deepEqual(moveKeys(state, "player1"), ["4,1", "3,0", "5,0"]);
  // player2 mirrors it on the top edge.
  assert.deepEqual(moveKeys(state, "player2"), ["4,7", "3,8", "5,8"]);

  // 8×8 slots × 2 orientations: no single barricade can seal a 9×9 board.
  assert.equal(legalWalls(state).length, 128);
  assert.equal(legalActions(state).length, 131);
});

test("barricade: the engine returns frozen states so a caller cannot corrupt them", () => {
  const state = createInitialState();
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.pawns), true);
  assert.equal(Object.isFrozen(state.walls), true);
  assert.equal(Object.isFrozen(state.wallsRemaining), true);

  const next = applyAction(state, "player1", { type: "move", to: pos(4, 1) });
  assert.equal(Object.isFrozen(next), true);
  assert.equal(Object.isFrozen(next.pawns), true);
  assert.equal(Object.isFrozen(next.lastAction), true);
  assert.equal(Object.isFrozen(next.lastAction.action), true);
});

/* -------------------------------------------------------------------------- *
 * 2. Normal movement and board boundaries
 * -------------------------------------------------------------------------- */

test("barricade: a pawn in open space has four orthogonal neighbours", () => {
  const state = stateWith({ pawns: { player1: pos(4, 4), player2: pos(0, 8) } });
  const moves = legalMoves(state, "player1");

  assert.equal(moves.length, 4);
  for (const action of moves) assert.equal(action.kind, MOVE_KINDS.STEP);
  assert.deepEqual(new Set(moves.map((action) => positionKey(action.to))), new Set(["4,5", "4,3", "3,4", "5,4"]));
});

test("barricade: movement is blocked by the board edge, and never diagonal", () => {
  const corner = stateWith({ pawns: { player1: pos(0, 0), player2: pos(8, 8) } });
  assert.deepEqual(new Set(moveKeys(corner, "player1")), new Set(["0,1", "1,0"]));

  const leftEdge = stateWith({ pawns: { player1: pos(0, 4), player2: pos(8, 8) } });
  assert.equal(legalMoves(leftEdge, "player1").length, 3);
  assert.deepEqual(
    classifyPawnMove(leftEdge, "player1", pos(-1, 4)),
    { ok: false, code: REJECTION.OUT_OF_BOUNDS, message: "that square is off the board" },
  );

  // Diagonals are never a plain move.
  const open = stateWith({ pawns: { player1: pos(4, 4), player2: pos(0, 8) } });
  const verdict = classifyPawnMove(open, "player1", pos(5, 5));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, REJECTION.MOVE_NOT_ADJACENT);
});

test("barricade: a pawn may walk backwards and sideways", () => {
  const state = stateWith({ pawns: { player1: pos(4, 4), player2: pos(0, 8) } });
  for (const target of [pos(4, 3), pos(3, 4), pos(5, 4)]) {
    assert.equal(validateAction(state, "player1", { type: "move", to: target }).ok, true);
  }
});

/* -------------------------------------------------------------------------- *
 * 3. Movement blocked by barricades
 * -------------------------------------------------------------------------- */

test("barricade: a horizontal barricade blocks both squares it spans, up and down", () => {
  const barricade = wall(3, 0, "horizontal");
  // The barricade between rows 0 and 1 covers columns 3 and 4.
  assert.equal(wallBlocksStep(barricade, pos(3, 0), pos(3, 1)), true);
  assert.equal(wallBlocksStep(barricade, pos(4, 0), pos(4, 1)), true);
  assert.equal(wallBlocksStep(barricade, pos(3, 1), pos(3, 0)), true);
  assert.equal(wallBlocksStep(barricade, pos(5, 0), pos(5, 1)), false);
  // It never blocks sideways movement.
  assert.equal(wallBlocksStep(barricade, pos(3, 0), pos(4, 0)), false);
});

test("barricade: a vertical barricade blocks both squares it spans, left and right", () => {
  const barricade = wall(3, 0, "vertical");
  assert.equal(wallBlocksStep(barricade, pos(3, 0), pos(4, 0)), true);
  assert.equal(wallBlocksStep(barricade, pos(3, 1), pos(4, 1)), true);
  assert.equal(wallBlocksStep(barricade, pos(4, 0), pos(3, 0)), true);
  assert.equal(wallBlocksStep(barricade, pos(3, 2), pos(4, 2)), false);
  assert.equal(wallBlocksStep(barricade, pos(4, 0), pos(4, 1)), false);
});

test("barricade: the engine's groove geometry agrees with the reference definition everywhere", () => {
  let checked = 0;
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      for (const [dc, dr] of STEP_VECTORS) {
        const from = pos(col, row);
        const to = pos(col + dc, row + dr);
        if (!inBounds(to)) continue;
        for (let slotRow = 0; slotRow < WALL_SLOTS; slotRow += 1) {
          for (let slotCol = 0; slotCol < WALL_SLOTS; slotCol += 1) {
            for (const orientation of ORIENTATIONS) {
              const candidate = wall(slotCol, slotRow, orientation);
              const expected = referenceStepBlocked([candidate], from, to);
              assert.equal(
                wallBlocksStep(candidate, from, to),
                expected,
                `wallBlocksStep ${orientation} ${slotCol},${slotRow} step ${positionKey(from)}→${positionKey(to)}`,
              );
              assert.equal(isStepBlocked([candidate], from, to), expected);
              assert.equal(
                Boolean(findBlockingWall([candidate], from, to)),
                expected,
                `findBlockingWall disagreement at ${orientation} ${slotCol},${slotRow}`,
              );
              checked += 1;
            }
          }
        }
      }
    }
  }
  // Every on-board step (288 of the 324 cell/direction pairs) × every barricade.
  assert.equal(checked, 288 * WALL_SLOTS * WALL_SLOTS * ORIENTATIONS.length);
});

test("barricade: a barricade blocks the step in the state and the action is rejected", () => {
  const state = stateWith({
    pawns: { player1: pos(4, 0), player2: pos(0, 8) },
    walls: [{ ...wall(3, 0, "horizontal"), owner: "player2" }],
  });

  assert.equal(moveKeys(state, "player1").includes("4,1"), false);
  assert.deepEqual(new Set(moveKeys(state, "player1")), new Set(["3,0", "5,0"]));

  const verdict = classifyPawnMove(state, "player1", pos(4, 1));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, REJECTION.MOVE_BLOCKED_BY_WALL);

  assert.throws(
    () => applyAction(state, "player1", { type: "move", to: pos(4, 1) }),
    (error) => {
      assert.equal(isBarricadeRuleError(error), true);
      assert.equal(error instanceof BarricadeRuleError, true);
      assert.equal(error.name, "BarricadeRuleError");
      assert.equal(error.code, REJECTION.MOVE_BLOCKED_BY_WALL);
      assert.equal(error.seat, "player1");
      return true;
    },
  );
});

test("barricade: one player's barricade blocks the other player's pawn too", () => {
  const state = stateWith({
    pawns: { player1: pos(4, 4), player2: pos(4, 5) },
    walls: [{ ...wall(4, 4, "horizontal"), owner: "player2" }],
  });
  // The barricade sits between rows 4 and 5 at columns 4 and 5.
  assert.equal(wallBlocksStep(wall(4, 4, "horizontal"), pos(4, 4), pos(4, 5)), true);
  // Both pawns are stopped by it — a barricade belongs to nobody once placed.
  assert.equal(hasPathToGoal(state, "player1"), true);
  for (const [seat, from, to] of [
    ["player1", pos(4, 4), pos(4, 5)],
    ["player2", pos(4, 5), pos(4, 4)],
  ]) {
    assert.equal(isStepBlocked(state.walls, from, to), true);
    assert.equal(
      classifyPawnMove(state, seat, to).code,
      REJECTION.DESTINATION_OCCUPIED, // the occupant is reported before the wall
    );
  }
  // One step off the line of the barricade and the pawn walks free.
  assert.equal(isStepBlocked(state.walls, pos(3, 5), pos(3, 6)), false);
  assert.equal(classifyPawnMove(state, "player1", pos(3, 4)).ok, true);
});

/* -------------------------------------------------------------------------- *
 * 4. Straight jumps and diagonal jumps
 * -------------------------------------------------------------------------- */

test("barricade: a pawn jumps straight over an adjacent opponent", () => {
  const state = stateWith({ pawns: { player1: pos(4, 2), player2: pos(4, 3) } });
  const moves = legalMoves(state, "player1");
  const jump = moves.find((action) => positionKey(action.to) === "4,4");

  assert.ok(jump, "the straight jump must be offered");
  assert.equal(jump.kind, MOVE_KINDS.JUMP_STRAIGHT);
  assert.equal(legalMoves(state, "player2").find((a) => positionKey(a.to) === "4,1").kind, MOVE_KINDS.JUMP_STRAIGHT);

  const onto = classifyPawnMove(state, "player1", pos(4, 3));
  assert.equal(onto.code, REJECTION.DESTINATION_OCCUPIED);

  // The other three steps are still available.
  assert.deepEqual(new Set(moveKeys(state, "player1")), new Set(["4,4", "4,1", "3,2", "5,2"]));
});

test("barricade: jumping works in every direction, not just forwards", () => {
  // Opponent above and to the right of player2's own pawn.
  const above = stateWith({ pawns: { player1: pos(4, 3), player2: pos(4, 2) } });
  assert.equal(
    legalMoves(above, "player1").find((a) => positionKey(a.to) === "4,1").kind,
    MOVE_KINDS.JUMP_STRAIGHT,
  );

  const sideways = stateWith({ pawns: { player1: pos(4, 4), player2: pos(5, 4) } });
  assert.equal(
    legalMoves(sideways, "player1").find((a) => positionKey(a.to) === "6,4").kind,
    MOVE_KINDS.JUMP_STRAIGHT,
  );
});

test("barricade: a blocking board edge turns the straight jump into a diagonal jump", () => {
  const state = stateWith({ pawns: { player1: pos(4, 7), player2: pos(4, 8) } });
  const moves = legalMoves(state, "player1");

  assert.equal(moves.some((action) => positionKey(action.to) === "4,9"), false);
  const diagonals = moves.filter((action) => action.kind === MOVE_KINDS.JUMP_DIAGONAL);
  assert.deepEqual(
    new Set(diagonals.map((action) => positionKey(action.to))),
    new Set(["3,8", "5,8"]),
  );
  assert.deepEqual(new Set(moveKeys(state, "player1")), new Set(["4,6", "3,7", "5,7", "3,8", "5,8"]));
});

test("barricade: a barricade behind the opponent turns the straight jump into a diagonal jump", () => {
  const state = stateWith({
    pawns: { player1: pos(4, 4), player2: pos(4, 5) },
    walls: [{ ...wall(4, 5, "horizontal"), owner: "player2" }],
  });

  // The barricade covers columns 4 and 5 between rows 5 and 6.
  assert.equal(wallBlocksStep(wall(4, 5, "horizontal"), pos(4, 5), pos(4, 6)), true);
  assert.equal(wallSealsAPath(state, wall(4, 5, "horizontal")), false);

  const straight = classifyPawnMove(state, "player1", pos(4, 6));
  assert.equal(straight.ok, false);
  assert.equal(straight.code, REJECTION.MOVE_BLOCKED_BY_WALL);

  const moves = legalMoves(state, "player1");
  const diagonals = moves.filter((action) => action.kind === MOVE_KINDS.JUMP_DIAGONAL);
  assert.deepEqual(
    new Set(diagonals.map((action) => positionKey(action.to))),
    new Set(["5,5", "3,5"]),
  );
  assert.deepEqual(new Set(moveKeys(state, "player1")), new Set(["4,3", "3,4", "5,4", "5,5", "3,5"]));
});

test("barricade: the diagonal is refused while the straight jump is open", () => {
  const state = stateWith({ pawns: { player1: pos(4, 4), player2: pos(4, 5) } });

  for (const target of [pos(3, 5), pos(5, 5)]) {
    const verdict = classifyPawnMove(state, "player1", target);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, REJECTION.JUMP_NOT_AVAILABLE);
    assert.equal(moveKeys(state, "player1").includes(positionKey(target)), false);
  }
});

test("barricade: the diagonal route around the opponent may not hop a barricade", () => {
  // Straight jump blocked, and the way around on the right is walled off twice:
  // once alongside the moving pawn, once alongside the opponent.
  const alongside = stateWith({
    pawns: { player1: pos(4, 4), player2: pos(4, 5) },
    walls: [
      { ...wall(4, 5, "horizontal"), owner: "player2" }, // blocks the straight jump
      { ...wall(4, 4, "vertical"), owner: "player1" }, // blocks (4,4)→(5,4)
    ],
  });
  assert.equal(alongside.walls.length, 2);
  const rightBlocked = classifyPawnMove(alongside, "player1", pos(5, 5));
  assert.equal(rightBlocked.ok, false);
  assert.equal(rightBlocked.code, REJECTION.MOVE_BLOCKED_BY_WALL);
  // The left diagonal is untouched, so the jump is not lost — only that side is.
  assert.equal(classifyPawnMove(alongside, "player1", pos(3, 5)).ok, true);

  const across = stateWith({
    pawns: { player1: pos(4, 4), player2: pos(4, 5) },
    walls: [
      { ...wall(4, 5, "horizontal"), owner: "player2" }, // blocks the straight jump
      { ...wall(5, 4, "horizontal"), owner: "player1" }, // blocks (5,4)→(5,5)
    ],
  });
  const acrossBlocked = classifyPawnMove(across, "player1", pos(5, 5));
  assert.equal(acrossBlocked.ok, false);
  assert.equal(acrossBlocked.code, REJECTION.MOVE_BLOCKED_BY_WALL);
  assert.equal(classifyPawnMove(across, "player1", pos(3, 5)).ok, true);
});

test("barricade: the diagonal is not offered off the side of the board", () => {
  // Opponent on the left edge with a barricade behind them: the left-hand
  // diagonal does not exist, so only the right-hand one is offered.
  const state = stateWith({
    pawns: { player1: pos(0, 4), player2: pos(0, 5) },
    walls: [{ ...wall(0, 5, "horizontal"), owner: "player2" }],
  });
  assert.equal(isStepBlocked(state.walls, pos(0, 5), pos(0, 6)), true);
  assert.equal(wallSealsAPath(state, wall(0, 5, "horizontal")), false);

  const diagonals = legalMoves(state, "player1").filter(
    (action) => action.kind === MOVE_KINDS.JUMP_DIAGONAL,
  );
  assert.deepEqual(new Set(diagonals.map((action) => positionKey(action.to))), new Set(["1,5"]));
  // (0,6) is the blocked straight jump, (-1,5) is off the board.
  assert.equal(classifyPawnMove(state, "player1", pos(0, 6)).code, REJECTION.MOVE_BLOCKED_BY_WALL);
  assert.equal(classifyPawnMove(state, "player1", pos(-1, 5)).code, REJECTION.OUT_OF_BOUNDS);
});

/**
 * Regression: the diagonal around a blocked straight jump is the pair of squares
 * BESIDE the opponent, at right angles to the direction of travel — on both axes.
 * A fixed pair of offsets only works for a vertical jump; on a horizontal one it
 * resolved to the straight-jump square and, worse, to the square the pawn was
 * standing on, so the generator offered a move the validator refused.
 */
test("barricade: the diagonal jump geometry is correct on both axes", () => {
  const cases = [
    {
      label: "jumping right over a neighbour",
      pawn: pos(4, 4),
      opponent: pos(5, 4),
      blocker: wall(5, 4, "vertical"),
      straight: pos(6, 4),
      diagonals: ["5,5", "5,3"],
    },
    {
      label: "jumping left over a neighbour",
      pawn: pos(5, 4),
      opponent: pos(4, 4),
      blocker: wall(3, 4, "vertical"),
      straight: pos(3, 4),
      diagonals: ["4,5", "4,3"],
    },
    {
      label: "jumping up over a neighbour",
      pawn: pos(4, 4),
      opponent: pos(4, 5),
      blocker: wall(4, 5, "horizontal"),
      straight: pos(4, 6),
      diagonals: ["5,5", "3,5"],
    },
    {
      label: "jumping down over a neighbour",
      pawn: pos(4, 5),
      opponent: pos(4, 4),
      blocker: wall(4, 3, "horizontal"),
      straight: pos(4, 3),
      diagonals: ["5,4", "3,4"],
    },
  ];

  for (const scenario of cases) {
    const state = stateWith({
      pawns: { player1: scenario.pawn, player2: scenario.opponent },
      walls: [{ ...scenario.blocker, owner: "player2" }],
    });

    const moves = legalMoves(state, "player1");
    const diagonals = moves.filter((action) => action.kind === MOVE_KINDS.JUMP_DIAGONAL);
    assert.deepEqual(
      new Set(diagonals.map((action) => positionKey(action.to))),
      new Set(scenario.diagonals),
      `${scenario.label}: diagonals`,
    );

    // The straight jump is blocked, and the pawn's own square is never offered.
    assert.equal(
      classifyPawnMove(state, "player1", scenario.straight).code,
      REJECTION.MOVE_BLOCKED_BY_WALL,
      `${scenario.label}: straight jump`,
    );
    assert.equal(
      moveKeys(state, "player1").includes(positionKey(scenario.pawn)),
      false,
      `${scenario.label}: the pawn may not move onto itself`,
    );

    // The generator's own output must survive the validator — the invariant the
    // AI (and every click) depends on.
    for (const action of moves) {
      assert.equal(
        validateAction(state, "player1", action).ok,
        true,
        `${scenario.label}: offered ${positionKey(action.to)} must be playable`,
      );
    }
    assert.equal(moves.length, 5, `${scenario.label}: three steps and two diagonals`);
  }
});

test("barricade: pawns separated by a barricade may not jump over it", () => {
  // Quoridor: pawns jump when face to face "which are not separated by a fence".
  const state = stateWith({
    pawns: { player1: pos(4, 4), player2: pos(4, 5) },
    walls: [{ ...wall(3, 4, "horizontal"), owner: "player2" }],
  });

  // h(3,4) covers columns 3 and 4, so it sits between (4,4) and (4,5).
  assert.equal(wallBlocksStep(wall(3, 4, "horizontal"), pos(4, 4), pos(4, 5)), true);
  // The lateral route (4,4)→(5,4)→(5,5) is completely free in this position...
  assert.equal(isStepBlocked(state.walls, pos(4, 4), pos(5, 4)), false);
  assert.equal(isStepBlocked(state.walls, pos(5, 4), pos(5, 5)), false);

  // ...and still refused, because you cannot jump a barricade to get around it.
  for (const target of [pos(4, 6), pos(5, 5), pos(3, 5)]) {
    const verdict = classifyPawnMove(state, "player1", target);
    assert.equal(verdict.ok, false, `expected ${positionKey(target)} to be refused`);
    assert.equal(verdict.code, REJECTION.JUMP_NOT_AVAILABLE);
  }
  // Only the three ordinary steps remain.
  assert.deepEqual(new Set(moveKeys(state, "player1")), new Set(["3,4", "5,4", "4,3"]));
  // (4,5) holds the opponent: pawns never share a square, so that is reported
  // ahead of the barricade explanation.
  assert.equal(classifyPawnMove(state, "player1", pos(4, 5)).code, REJECTION.DESTINATION_OCCUPIED);
});

test("barricade: a pawn two squares away is an obstacle, never a jump target beyond it", () => {
  const state = stateWith({ pawns: { player1: pos(4, 4), player2: pos(4, 6) } });
  assert.equal(classifyPawnMove(state, "player1", pos(4, 5)).ok, true);
  assert.equal(classifyPawnMove(state, "player1", pos(4, 6)).code, REJECTION.DESTINATION_OCCUPIED);
});

/* -------------------------------------------------------------------------- *
 * 5. Barricade placement, in both orientations
 * -------------------------------------------------------------------------- */

test("barricade: a horizontal barricade is placed, charged and handed over", () => {
  const state = createInitialState();
  const next = applyAction(state, "player1", {
    type: "wall",
    wall: wall(3, 0, "horizontal"),
  });

  assert.deepEqual(next.walls, [
    { col: 3, row: 0, orientation: "horizontal", owner: "player1" },
  ]);
  assert.deepEqual(next.wallsRemaining, { player1: 9, player2: 10 });
  assert.equal(next.ply, 1);
  assert.equal(next.turn, "player2");
  assert.equal(next.status, MATCH_STATUS.PLAYING);
  assert.equal(next.winner, null);
  assert.deepEqual(next.pawns, state.pawns);
  assert.deepEqual(next.lastAction, {
    seat: "player1",
    action: { type: "wall", wall: { col: 3, row: 0, orientation: "horizontal" } },
  });
  assert.equal(Object.isFrozen(next.lastAction.action.wall), true);

  // The barricade is real: player1 can no longer walk up through column 4 from
  // the bottom row, while player2 is unaffected.
  assert.equal(moveKeys(next, "player1").includes("4,1"), false);
  assert.equal(moveKeys(next, "player2").includes("4,7"), true);
});

test("barricade: a vertical barricade is placed the same way", () => {
  const state = createInitialState();
  const next = applyAction(state, "player1", { type: "wall", wall: wall(4, 0, "vertical") });

  assert.deepEqual(next.walls, [{ col: 4, row: 0, orientation: "vertical", owner: "player1" }]);
  assert.deepEqual(next.wallsRemaining, { player1: 9, player2: 10 });
  assert.equal(moveKeys(next, "player1").includes("5,0"), false);
  assert.equal(moveKeys(next, "player1").includes("4,1"), true);
});

test("barricade: the placed slot leaves the menu and nothing else is lost on a 9×9 board", () => {
  const state = createInitialState();
  const next = applyAction(state, "player1", { type: "wall", wall: wall(3, 0, "horizontal") });
  const menu = wallKeys(next, "player2");

  // The occupied slot removes BOTH orientations (overlap and crossing), and no
  // single follow-up barricade can seal player1's pawn from this position.
  assert.equal(menu.length, 126);
  assert.equal(menu.includes(wallKey(wall(3, 0, "horizontal"))), false);
  assert.equal(menu.includes(wallKey(wall(3, 0, "vertical"))), false);
});

/* -------------------------------------------------------------------------- *
 * 6. Overlapping, crossing, out-of-bounds and unaffordable barricades
 * -------------------------------------------------------------------------- */

test("barricade: conflict detection is exact", () => {
  assert.equal(wallsConflict(wall(3, 0, "horizontal"), wall(3, 0, "horizontal")), "overlap");
  assert.equal(wallsConflict(wall(3, 0, "horizontal"), wall(3, 0, "vertical")), "crossing");
  assert.equal(wallsConflict(wall(3, 0, "horizontal"), wall(4, 0, "horizontal")), null);
  assert.equal(wallsConflict(wall(3, 0, "horizontal"), wall(2, 0, "horizontal")), null);
  // Meeting at a single point is legal in the physical game.
  assert.equal(wallsConflict(wall(3, 0, "horizontal"), wall(4, 0, "vertical")), null);
  assert.equal(wallsConflict(wall(3, 0, "vertical"), wall(3, 1, "vertical")), null);
  assert.equal(wallsConflict(wall(0, 0, "horizontal"), wall(7, 7, "vertical")), null);
});

test("barricade: a conflicting slot is refused as overlap or crossing", () => {
  const state = stateWith({
    pawns: { player1: pos(4, 0), player2: pos(4, 8) },
    walls: [{ ...wall(3, 0, "horizontal"), owner: "player2" }],
  });

  const overlap = classifyWall(state, "player1", wall(3, 0, "horizontal"));
  assert.equal(overlap.ok, false);
  assert.equal(overlap.code, REJECTION.WALL_OVERLAP);

  const crossing = classifyWall(state, "player1", wall(3, 0, "vertical"));
  assert.equal(crossing.ok, false);
  assert.equal(crossing.code, REJECTION.WALL_CROSSING);

  assert.throws(
    () => applyAction(state, "player1", { type: "wall", wall: wall(3, 0, "vertical") }),
    (error) => error.code === REJECTION.WALL_CROSSING,
  );
  assert.equal(findWallConflict(state.walls, wall(4, 1, "vertical")), null);
});

test("barricade: slots outside the groove grid are refused", () => {
  const state = createInitialState();
  const cases = [
    wall(8, 0, "horizontal"),
    wall(0, 8, "vertical"),
    wall(-1, 0, "horizontal"),
    wall(0, -1, "horizontal"),
    wall(1.5, 0, "horizontal"),
    wall(0, 1.5, "vertical"),
  ];
  for (const candidate of cases) {
    const verdict = classifyWall(state, "player1", candidate);
    assert.equal(verdict.ok, false, `${wallKey(candidate)} should be refused`);
    assert.equal(verdict.code, REJECTION.OUT_OF_BOUNDS);
    assert.throws(
      () => applyAction(state, "player1", { type: "wall", wall: candidate }),
      (error) => error.code === REJECTION.OUT_OF_BOUNDS,
    );
  }
  // The last legal slot is 7,7 in both orientations.
  assert.equal(classifyWall(state, "player1", wall(7, 7, "horizontal")).ok, true);
  assert.equal(classifyWall(state, "player1", wall(7, 7, "vertical")).ok, true);
});

test("barricade: an unknown orientation is refused", () => {
  const state = createInitialState();
  const verdict = classifyWall(state, "player1", { col: 3, row: 0, orientation: "diagonal" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, REJECTION.INVALID_ORIENTATION);
  assert.throws(
    () =>
      applyAction(state, "player1", {
        type: "wall",
        wall: { col: 3, row: 0, orientation: "diagonal" },
      }),
    (error) => error.code === REJECTION.INVALID_ORIENTATION,
  );
});

test("barricade: a seat with an empty reserve must move its pawn instead", () => {
  const state = stateWith({
    pawns: { player1: pos(4, 4), player2: pos(4, 8) },
    wallsRemaining: { player1: 0 },
  });

  const verdict = classifyWall(state, "player1", wall(3, 4, "horizontal"));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, REJECTION.NO_WALLS_REMAINING);
  assert.deepEqual(legalWalls(state, "player1"), []);

  const menu = legalActions({ ...state, turn: "player1" });
  assert.equal(menu.length, 4);
  for (const action of menu) assert.equal(action.type, "move");
});

test("barricade: 10 barricades each, then the reserve is genuinely empty", () => {
  // Every barricade below lives in columns 0–2, so columns 4 and up stay clear
  // and no placement can seal either pawn — the point here is the RESERVE, not
  // the geometry (the geometry has its own tests).
  const player1Walls = [
    wall(0, 0, "horizontal"),
    wall(1, 0, "horizontal"),
    wall(2, 0, "horizontal"),
    wall(0, 1, "vertical"),
    wall(1, 1, "vertical"),
    wall(2, 1, "vertical"),
    wall(0, 2, "horizontal"),
    wall(1, 2, "horizontal"),
    wall(2, 2, "horizontal"),
    wall(0, 3, "vertical"),
  ];
  const player2Walls = [
    wall(1, 3, "vertical"),
    wall(2, 3, "vertical"),
    wall(0, 4, "horizontal"),
    wall(1, 4, "horizontal"),
    wall(2, 4, "horizontal"),
    wall(0, 5, "vertical"),
    wall(1, 5, "vertical"),
    wall(2, 5, "vertical"),
    wall(0, 6, "horizontal"),
    wall(1, 6, "horizontal"),
  ];

  let state = createInitialState();
  for (let ply = 0; ply < 20; ply += 1) {
    const seat = state.turn;
    const placement = seat === "player1" ? player1Walls[ply / 2] : player2Walls[(ply - 1) / 2];
    const action = { type: "wall", wall: placement };
    assert.equal(validateAction(state, seat, action).ok, true, `ply ${ply} must be legal`);
    state = applyAction(state, seat, action);
  }

  assert.equal(state.walls.length, 20);
  assert.deepEqual(state.wallsRemaining, { player1: 0, player2: 0 });
  assert.equal(state.ply, 20);
  assert.deepEqual(
    state.walls.slice(0, 4).map((placed) => placed.owner),
    ["player1", "player2", "player1", "player2"],
  );

  // No two of the twenty conflict, however the generator ordered them.
  for (let i = 0; i < state.walls.length; i += 1) {
    for (let j = i + 1; j < state.walls.length; j += 1) {
      assert.equal(wallsConflict(state.walls[i], state.walls[j]), null);
    }
  }

  assert.deepEqual(legalWalls(state, "player1"), []);
  assert.deepEqual(legalWalls(state, "player2"), []);
  assert.throws(
    () => applyAction(state, state.turn, { type: "wall", wall: wall(5, 5, "vertical") }),
    (error) => error.code === REJECTION.NO_WALLS_REMAINING,
  );
  // Both pawns survived twenty barricades, and only moves remain in the menu.
  assert.equal(hasPathToGoal(state, "player1"), true);
  assert.equal(hasPathToGoal(state, "player2"), true);
  const menu = legalActions(state);
  assert.equal(menu.length > 0, true);
  for (const action of menu) assert.equal(action.type, "move");
});

/* -------------------------------------------------------------------------- *
 * 7. Barricades that would seal a route
 * -------------------------------------------------------------------------- */

/**
 * The four barricades that box a pawn standing on (4,2) in: up, down, left and
 * right. They share no slot, so they are legal one at a time — the fourth one
 * is the one that would imprison the pawn.
 */
const POCKET = [wall(4, 2, "horizontal"), wall(3, 1, "horizontal"), wall(3, 2, "vertical"), wall(4, 1, "vertical")];

test("barricade: a pocket opens and closes exactly as the geometry says", () => {
  const trapped = stateWith({
    pawns: { player1: pos(4, 2), player2: pos(4, 8) },
    walls: POCKET.map((barricade) => ({ ...barricade, owner: "player2" })),
  });

  assert.equal(distanceToGoal(trapped, "player1"), Number.POSITIVE_INFINITY);
  assert.equal(hasPathToGoal(trapped, "player1"), false);
  assert.deepEqual(legalMoves(trapped, "player1"), []);

  // Three of the four leave a way out, and the fourth always closes it.
  for (let missing = 0; missing < POCKET.length; missing += 1) {
    const three = POCKET.filter((_, index) => index !== missing).map((barricade) => ({
      ...barricade,
      owner: "player2",
    }));
    const state = stateWith({ pawns: { player1: pos(4, 2), player2: pos(4, 8) }, walls: three });

    assert.equal(hasPathToGoal(state, "player1"), true, `three walls (missing ${missing}) stay open`);
    assert.equal(distanceToGoal(state, "player1") > 0, true);

    const closing = classifyWall(state, "player1", POCKET[missing]);
    assert.equal(closing.ok, false, `closing wall ${missing} must be refused`);
    assert.equal(closing.code, REJECTION.WALL_BLOCKS_PATH);
    assert.equal(wallSealsAPath(state, POCKET[missing]), true);

    assert.throws(
      () => applyAction(state, "player1", { type: "wall", wall: POCKET[missing] }),
      (error) => error.code === REJECTION.WALL_BLOCKS_PATH,
    );
    // Everything that does not close the pocket is still playable: 128 slots ×
    // orientations, minus the 3 occupied slots (both orientations each), minus
    // exactly one sealing barricade.
    assert.equal(legalWalls(state, "player1").length, 128 - 6 - 1);
    assert.equal(wallKeys(state, "player1").includes(wallKey(POCKET[missing])), false);
  }
});

test("barricade: the last route of the OPPONENT is protected too", () => {
  const three = POCKET.filter((_, index) => index !== 3).map((barricade) => ({
    ...barricade,
    owner: "player1",
  }));
  const state = stateWith({
    pawns: { player1: pos(4, 0), player2: pos(4, 2) },
    walls: three,
  });

  assert.equal(hasPathToGoal(state, "player2"), true);
  assert.equal(wallSealsAPath(state, POCKET[3]), true);
  assert.throws(
    () => applyAction(state, "player1", { type: "wall", wall: POCKET[3] }),
    (error) => {
      assert.equal(error.code, REJECTION.WALL_BLOCKS_PATH);
      assert.equal(error.seat, "player1");
      return true;
    },
  );
});

test("barricade: a barricade that lengthens the race is still legal", () => {
  const state = stateWith({ pawns: { player1: pos(4, 0), player2: pos(4, 8) } });
  const detour = applyAction(state, "player1", { type: "wall", wall: wall(3, 0, "horizontal") });

  // Straight up is 8 steps; around the barricade is 9 — and it costs player2 the
  // same single step, because the barricade straddles both columns 3 and 4.
  assert.equal(distanceToGoal(state, "player1"), 8);
  assert.equal(distanceToGoal(detour, "player1"), 9);
  assert.equal(hasPathToGoal(detour, "player1"), true);
  assert.equal(distanceToGoal(detour, "player2"), 9);
  assert.equal(hasPathToGoal(detour, "player2"), true);
});

/* -------------------------------------------------------------------------- *
 * 8. Victory and terminal behaviour
 * -------------------------------------------------------------------------- */

test("barricade: reaching the opposite baseline wins immediately", () => {
  const state = stateWith({ pawns: { player1: pos(4, 7), player2: pos(0, 8) } });
  const won = applyAction(state, "player1", { type: "move", to: pos(4, 8) });

  assert.equal(won.status, MATCH_STATUS.FINISHED);
  assert.equal(won.winner, "player1");
  assert.deepEqual(won.outcome, { winner: "player1", reason: "reached-baseline" });
  assert.equal(isMatchFinished(won), true);
  assert.equal(won.ply, 1);
  assert.deepEqual(won.pawns.player1, pos(4, 8));
  // The turn still advances, but it no longer means anything.
  assert.equal(won.turn, "player2");
});

test("barricade: any square of the goal row wins, including a diagonal jump landing", () => {
  const state = stateWith({ pawns: { player1: pos(4, 7), player2: pos(4, 8) } });
  const options = legalMoves(state, "player1").filter((action) => action.to.row === 8);
  assert.deepEqual(new Set(options.map((action) => positionKey(action.to))), new Set(["3,8", "5,8"]));

  for (const action of options) {
    const won = applyAction(state, "player1", action);
    assert.equal(won.winner, "player1");
    assert.equal(won.outcome.reason, "reached-baseline");
  }
});

test("barricade: player2 wins on row 0", () => {
  const state = stateWith({ pawns: { player1: pos(0, 0), player2: pos(4, 1) }, turn: "player2" });
  const won = applyAction(state, "player2", { type: "move", to: pos(4, 0) });
  assert.equal(won.winner, "player2");
  assert.equal(won.status, MATCH_STATUS.FINISHED);
  assert.deepEqual(won.outcome, { winner: "player2", reason: "reached-baseline" });
});

test("barricade: a finished match accepts no further action at all", () => {
  const state = stateWith({ pawns: { player1: pos(4, 7), player2: pos(0, 8) } });
  const won = applyAction(state, "player1", { type: "move", to: pos(4, 8) });

  assert.deepEqual(legalActions(won), []);
  assert.deepEqual(legalMoves(won, "player1"), []);
  assert.deepEqual(legalWalls(won, "player2"), []);

  // Even the seat nominally on turn is refused, and so is a legal wall.
  for (const action of [
    { type: "move", to: pos(0, 1) },
    { type: "wall", wall: wall(0, 1, "horizontal") },
  ]) {
    const verdict = validateAction(won, "player2", action);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, REJECTION.MATCH_NOT_PLAYING);
    assert.throws(
      () => applyAction(won, "player2", action),
      (error) => error.code === REJECTION.MATCH_NOT_PLAYING,
    );
  }
  // Even the winner cannot move again.
  assert.equal(
    validateAction(won, "player1", { type: "move", to: pos(3, 8) }).code,
    REJECTION.MATCH_NOT_PLAYING,
  );
});

test("barricade: a cancelled match is equally inert", () => {
  const state = stateWith({ status: MATCH_STATUS.CANCELLED });
  assert.equal(isMatchFinished(state), true);
  assert.deepEqual(legalActions(state), []);
  assert.equal(
    validateAction(state, "player1", { type: "move", to: pos(4, 1) }).code,
    REJECTION.MATCH_NOT_PLAYING,
  );
});

test("barricade: a match in the waiting lobby accepts nothing either", () => {
  const state = stateWith({ status: MATCH_STATUS.WAITING });
  assert.equal(
    validateAction(state, "player1", { type: "wall", wall: wall(3, 0, "horizontal") }).code,
    REJECTION.MATCH_NOT_PLAYING,
  );
});

/* -------------------------------------------------------------------------- *
 * 9. Alternating turns and rejected actions
 * -------------------------------------------------------------------------- */

test("barricade: turns alternate strictly, one action each", () => {
  let state = createInitialState();
  const order = [];
  for (let i = 0; i < 6; i += 1) {
    order.push(state.turn);
    state = applyAction(state, state.turn, legalActions(state)[0]);
    assert.equal(state.ply, i + 1);
  }
  assert.deepEqual(order, ["player1", "player2", "player1", "player2", "player1", "player2"]);
  assert.equal(state.turn, "player1");
});

test("barricade: acting out of turn is refused, and the state is not touched", () => {
  const state = deepFreeze(createInitialState());
  const before = snapshot(state);

  const verdict = validateAction(state, "player2", { type: "move", to: pos(4, 7) });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, REJECTION.NOT_YOUR_TURN);
  assert.throws(
    () => applyAction(state, "player2", { type: "move", to: pos(4, 7) }),
    (error) => error.code === REJECTION.NOT_YOUR_TURN,
  );
  assert.equal(snapshot(state), before);
});

test("barricade: an unknown seat is refused", () => {
  const state = deepFreeze(createInitialState());
  const verdict = validateAction(state, "player3", { type: "move", to: pos(4, 1) });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, REJECTION.INVALID_ACTION);
  assert.throws(
    () => applyAction(state, "player3", { type: "move", to: pos(4, 1) }),
    (error) => error.code === REJECTION.INVALID_ACTION,
  );
});

test("barricade: malformed actions are refused", () => {
  const state = deepFreeze(createInitialState());
  const malformed = [
    null,
    undefined,
    {},
    "move",
    42,
    { type: "teleport" },
    { type: "move" },
    { type: "move", to: null },
    { type: "wall" },
    { type: "wall", wall: null },
  ];
  for (const action of malformed) {
    const verdict = validateAction(state, "player1", action);
    assert.equal(verdict.ok, false, `${JSON.stringify(action)} should be refused`);
    assert.equal(verdict.code, REJECTION.INVALID_ACTION);
    assert.throws(
      () => applyAction(state, "player1", action),
      (error) => error.code === REJECTION.INVALID_ACTION,
    );
  }
});

test("barricade: an off-board destination is refused", () => {
  const state = deepFreeze(createInitialState());
  for (const target of [pos(4, 9), pos(4, -1), pos(-1, 0), pos(9, 0), pos(1.5, 0), { col: 4 }, {}]) {
    const verdict = validateAction(state, "player1", { type: "move", to: target });
    assert.equal(verdict.ok, false, `${JSON.stringify(target)} should be refused`);
    assert.equal(verdict.code, REJECTION.OUT_OF_BOUNDS);
  }
});

test("barricade: a supplied move kind is checked, never trusted", () => {
  const state = createInitialState();
  const honest = validateAction(state, "player1", {
    type: "move",
    to: pos(4, 1),
    kind: MOVE_KINDS.STEP,
  });
  assert.equal(honest.ok, true);
  assert.equal(honest.kind, MOVE_KINDS.STEP);

  const lying = validateAction(state, "player1", {
    type: "move",
    to: pos(4, 1),
    kind: MOVE_KINDS.JUMP_STRAIGHT,
  });
  assert.equal(lying.ok, false);
  assert.equal(lying.code, REJECTION.ACTION_MISMATCH);
  assert.throws(
    () =>
      applyAction(state, "player1", {
        type: "move",
        to: pos(4, 1),
        kind: MOVE_KINDS.JUMP_STRAIGHT,
      }),
    (error) => error.code === REJECTION.ACTION_MISMATCH,
  );
});

test("barricade: a rejected action never mutates the original state", () => {
  const state = deepFreeze(
    stateWith({
      pawns: { player1: pos(4, 4), player2: pos(4, 5) },
      walls: [{ ...wall(3, 4, "horizontal"), owner: "player2" }],
    }),
  );
  const before = snapshot(state);

  const rejections = [
    { type: "move", to: pos(4, 5) }, // occupied / separated
    { type: "move", to: pos(4, 6) }, // jump over a barricade
    { type: "move", to: pos(0, 0) }, // not adjacent
    { type: "wall", wall: wall(3, 4, "horizontal") }, // overlap
    { type: "wall", wall: wall(3, 4, "vertical") }, // crossing
    { type: "wall", wall: wall(9, 9, "vertical") }, // out of bounds
  ];
  for (const action of rejections) {
    assert.throws(() => applyAction(state, "player1", action));
    assert.equal(snapshot(state), before);
  }
  // The out-of-turn seat is refused without touching anything either.
  assert.throws(() => applyAction(state, "player2", { type: "move", to: pos(4, 4) }));
  assert.equal(snapshot(state), before);
  // And an accepted action returns a NEW state, leaving this one as it was.
  const next = applyAction(state, "player1", { type: "move", to: pos(5, 4) });
  assert.notEqual(next, state);
  assert.equal(snapshot(state), before);
  assert.equal(state.pawns.player1.col, 4);
  assert.equal(next.pawns.player1.col, 5);
});

test("barricade: tryApplyAction reports rejection as null instead of throwing", () => {
  const state = createInitialState();
  assert.equal(tryApplyAction(state, "player1", { type: "move", to: pos(4, 9) }), null);
  assert.equal(tryApplyAction(state, "player1", { type: "wall", wall: wall(3, 0, "horizontal") }).ply, 1);
  assert.throws(() =>
    tryApplyAction(state, "player1", { type: "move", to: { get col() { throw new Error("boom"); } } }),
  );
});

test("barricade: cloneState copies without aliasing", () => {
  const original = createInitialState();
  const copy = cloneState(original);
  assert.deepEqual(copy, original);
  assert.notEqual(copy, original);
  assert.notEqual(copy.walls, original.walls);
  assert.equal(Object.isFrozen(copy), true);
});

/* -------------------------------------------------------------------------- *
 * 10. Pathfinding and the fast groove index, cross-checked
 * -------------------------------------------------------------------------- */

test("barricade: generated moves and walls always agree with an independent implementation", () => {
  for (const seed of [7, 1234, 987654]) {
    const random = mulberry32(seed);
    let played = 0;

    while (played < 120) {
      let state = createInitialState();
      let ply = 0;

      while (!isMatchFinished(state) && played < 120) {
        const seat = state.turn;
        const actions = legalActions(state);
        assert.equal(actions.length > 0, true, `seed ${seed} ply ${ply}: a live match has options`);

        // Everything the engine offers is accepted by the engine's own validator:
        // the whole menu periodically, and the (cheap) move menu on EVERY ply — a
        // generator that offers a square the validator refuses is a real bug, and
        // the move menu is where it hides.
        for (const action of legalMoves(state, seat)) {
          assert.equal(validateAction(state, seat, action).ok, true, `seed ${seed} ply ${ply} move`);
        }
        if (ply % 10 === 0) {
          for (const action of actions) {
            assert.equal(validateAction(state, seat, action).ok, true, `seed ${seed} ply ${ply}`);
          }
        }

        // The move menu is exactly the set of squares the engine accepts.
        const menu = new Set(moveKeys(state, seat));
        for (let row = 0; row < BOARD_SIZE; row += 1) {
          for (let col = 0; col < BOARD_SIZE; col += 1) {
            const square = pos(col, row);
            assert.equal(
              classifyPawnMove(state, seat, square).ok,
              menu.has(positionKey(square)),
              `seed ${seed} ply ${ply}: ${positionKey(square)}`,
            );
          }
        }

        // Distances agree with the reference BFS, which uses its own geometry.
        for (const player of ["player1", "player2"]) {
          assert.equal(
            distanceToGoal(state, player),
            referenceDistance(state, player),
            `seed ${seed} ply ${ply} (${player})`,
          );
        }

        // Periodically, the whole 128-candidate wall menu against the reference.
        if (ply % 25 === 0) {
          assert.deepEqual(
            wallKeys(state, seat).sort(),
            referenceWallKeys(state, seat).sort(),
            `seed ${seed} ply ${ply} wall menu`,
          );
        }

        // Invariants of every reachable position.
        assert.equal(hasPathToGoal(state, "player1"), true);
        assert.equal(hasPathToGoal(state, "player2"), true);
        assert.equal(
          state.wallsRemaining.player1 + state.wallsRemaining.player2,
          20 - state.walls.length,
        );
        assert.equal(state.walls.length <= 20, true);

        const action = actions[Math.floor(random() * actions.length)];
        const before = snapshot(state);
        state = applyAction(state, seat, action);
        assert.notEqual(snapshot(state), before);
        assert.equal(state.turn, otherSeat(seat));
        assert.equal(state.ply, ply + 1);
        ply += 1;
        played += 1;
      }

      // However this game ended, the terminal state is coherent.
      if (isMatchFinished(state)) {
        assert.notEqual(state.winner, null);
        assert.equal(state.outcome.winner, state.winner);
        assert.equal(state.outcome.reason, "reached-baseline");
        assert.deepEqual(legalActions(state), []);
      }
    }
  }
});

test("barricade: the engine's index and the reference geometry never disagree", () => {
  const random = mulberry32(20261010);
  for (let trial = 0; trial < 300; trial += 1) {
    const walls = [];
    const count = Math.floor(random() * 8);
    for (let i = 0; i < count; i += 1) {
      walls.push({
        col: Math.floor(random() * WALL_SLOTS),
        row: Math.floor(random() * WALL_SLOTS),
        orientation: random() < 0.5 ? "horizontal" : "vertical",
      });
    }
    const state = stateWith({ pawns: { player1: pos(4, 0), player2: pos(4, 8) }, walls });

    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        for (const [dc, dr] of STEP_VECTORS) {
          const to = pos(col + dc, row + dr);
          if (!inBounds(to)) continue;
          assert.equal(
            isStepBlocked(state.walls, pos(col, row), to),
            referenceStepBlocked(state.walls, pos(col, row), to),
            `trial ${trial} step ${col},${row}→${to.col},${to.row}`,
          );
        }
      }
    }
    // The seal check is the reference reachability, negated.
    for (const candidate of [
      wall(0, 0, "horizontal"),
      wall(4, 4, "vertical"),
      wall(7, 7, "horizontal"),
    ]) {
      const withCandidate = { ...state, walls: [...state.walls, candidate] };
      const seals =
        !Number.isFinite(referenceDistance(withCandidate, "player1")) ||
        !Number.isFinite(referenceDistance(withCandidate, "player2"));
      assert.equal(
        wallSealsAPath(state, candidate),
        seals,
        `trial ${trial} ${wallKey(candidate)}`,
      );
    }
  }
});
