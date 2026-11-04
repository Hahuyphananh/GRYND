// src/lib/battleship/rules.ts
//
// The PURE Battleship rules engine: NO database, NO I/O, NO HTTP, and no
// randomness at all (fleet DEALING is a separate module, ./fleet, so this file
// stays a deterministic function of its inputs).
//
// ── THE RULES, EXACTLY ────────────────────────────────────────────────────
//
//   • A 14×10 board per player, cells addressed A1–N10 (`{ x, y }` internally).
//   • Six ships — Carrier 5, Battleship 4, Cruiser 3, Submarine 3, Frigate 3 and
//     Destroyer 2 — for exactly 20 occupied cells. Ships may touch, including diagonally;
//     only a shared CELL is illegal. Every ship is a straight run of its own
//     length, horizontal or vertical, entirely inside the board.
//   • Each round BOTH players lock exactly one attack coordinate. The two
//     attacks are revealed together and resolve SIMULTANEOUSLY.
//   • A coordinate may be attacked once per player per match.
//   • A shot on empty water is a MISS; on a ship that still has undamaged cells
//     it is a HIT; on the ship's last undamaged cell it is SUNK.
//   • The first player to destroy all six enemy ships wins. If both fleets are
//     destroyed by the same round's two attacks, the match is a DRAW — no
//     winner is invented.
//
// ── THE PROPERTY THIS FILE EXISTS TO GUARANTEE ────────────────────────────
//
// Neither attack may influence the other's validity or result. `resolveRound`
// therefore EVALUATES both attacks against the same immutable PRE-ROUND state
// and only then applies both records; nothing is written before both verdicts
// exist. A player whose fleet is about to be wiped out still gets their own
// shot resolved, which is what makes a mutual final blow a draw.
//
// ── HIDDEN INFORMATION ────────────────────────────────────────────────────
//
// `PrivateMatchState` holds both fleets and never leaves the server. The only
// shapes a client may receive are `publicMatchState(state)` and
// `matchViewForSeat(state, seat)`, and neither has a field that can carry an
// enemy ship position. `matchViewForSeat` includes the VIEWER's own fleet
// because a player must be able to see their own ships.

import {
  BOARD_CELL,
  BOARD_COLUMNS,
  BOARD_ROWS,
  COLUMNS,
  FLEET_CELL_COUNT,
  FLEET_SIZE,
  MATCH_OUTCOME,
  MATCH_STATUS,
  ORIENTATIONS,
  REJECTION,
  ROWS,
  SEATS,
  SEAT_RESULTS,
  SHIP_KEYS,
  SHIP_LENGTHS,
  SHOT_RESULTS,
} from "./constants";
import type {
  AttackRecord,
  AttackResolution,
  BoardCell,
  Coordinate,
  CoordinateInput,
  Fleet,
  FleetCells,
  FleetVerdict,
  MatchOutcome,
  MatchView,
  PlacementVerdict,
  PrivateMatchState,
  PublicAttackEvent,
  PublicMatchState,
  PublicPlayerBoardState,
  RejectionCode,
  RoundResolution,
  RoundResult,
  RoundSubmissions,
  Seat,
  SeatResult,
  ShipKey,
  ShipPlacement,
  StateValidation,
} from "./types";

/** Thrown only for a programming error (a fleet that cannot exist), never for
 *  a player's illegal input — those are returned as verdicts. */
export class BattleshipRuleError extends Error {
  readonly code: RejectionCode;

  constructor(code: RejectionCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "BattleshipRuleError";
    this.code = code;
  }
}

/**
 * The printed-cell pattern, built from the board's own labels: widening the
 * board widens what parses ("B7", "N10") with no second list to keep in sync.
 */
const ROW_ALTERNATION = [...ROWS]
  .sort((a, b) => String(b).length - String(a).length)
  .join("|");
const COORDINATE_PATTERN = new RegExp(`^([${COLUMNS.join("")}])(${ROW_ALTERNATION})$`);

// ── Seats ─────────────────────────────────────────────────────────────────

export function otherSeat(seat: Seat): Seat {
  return seat === "player1" ? "player2" : "player1";
}

// ── Coordinates ───────────────────────────────────────────────────────────

/** Parses `{ x, y }` or the printed form ("B7", case-insensitive). Returns null
 *  for anything else — including geometrically out-of-range columns, which are
 *  a different error from an in-range cell the rules reject. */
export function parseCoordinate(input: CoordinateInput | null | undefined): Coordinate | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "string") {
    const text = input.trim().toUpperCase();
    const match = COORDINATE_PATTERN.exec(text);
    if (!match) return null;
    return { x: COLUMNS.indexOf(match[1] as (typeof COLUMNS)[number]), y: Number(match[2]) - 1 };
  }
  if (typeof input !== "object") return null;
  const { x, y } = input;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  return { x, y };
}

/** The printed form of a cell: `"B7"`. */
export function formatCoordinate(coordinate: Coordinate): string {
  const column = COLUMNS[coordinate.x];
  return `${column ?? "?"}${coordinate.y + 1}`;
}

/** A stable key for a cell, for sets and duplicate checks. */
export function cellKey(coordinate: Coordinate): string {
  return `${coordinate.x},${coordinate.y}`;
}

/** True when the cell is an integer inside the board. */
export function inBounds(coordinate: Coordinate): boolean {
  if (!coordinate) return false;
  const { x, y } = coordinate;
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < BOARD_COLUMNS &&
    y < BOARD_ROWS
  );
}

/** Every cell of the board, row by row (used by tests and the board UI). */
export function allCells(): Coordinate[] {
  const cells: Coordinate[] = [];
  for (let y = 0; y < BOARD_ROWS; y += 1) {
    for (let x = 0; x < BOARD_COLUMNS; x += 1) cells.push({ x, y });
  }
  return cells;
}

// ── Ships and fleets ──────────────────────────────────────────────────────

/** The cells a placement covers, in order. Does NOT check bounds — validation
 *  does that, so an out-of-bounds placement can still be described. */
export function shipCells(placement: ShipPlacement): Coordinate[] {
  const length = SHIP_LENGTHS[placement?.ship as ShipKey] ?? 0;
  const cells: Coordinate[] = [];
  for (let index = 0; index < length; index += 1) {
    cells.push(
      placement.orientation === "vertical"
        ? { x: placement.x, y: placement.y + index }
        : { x: placement.x + index, y: placement.y },
    );
  }
  return cells;
}

function rejectPlacement(code: RejectionCode, message: string): PlacementVerdict {
  return { ok: false, code, message };
}

/**
 * Validates ONE ship in isolation: known ship, known orientation, integer start,
 * and every cell of its run inside the board. Overlap is a fleet-level question
 * and is answered by `validateFleet`.
 */
export function validateShipPlacement(placement: ShipPlacement): PlacementVerdict {
  if (!placement || typeof placement !== "object") {
    return rejectPlacement(REJECTION.INVALID_SHIP, "a placement must be an object");
  }
  if (!SHIP_KEYS.includes(placement.ship)) {
    return rejectPlacement(REJECTION.INVALID_SHIP, `"${String(placement.ship)}" is not a ship`);
  }
  if (!ORIENTATIONS.includes(placement.orientation)) {
    return rejectPlacement(
      REJECTION.INVALID_ORIENTATION,
      `"${String(placement.orientation)}" is not an orientation`,
    );
  }
  if (!Number.isInteger(placement.x) || !Number.isInteger(placement.y)) {
    return rejectPlacement(REJECTION.INVALID_COORDINATE, "a ship must start on an integer cell");
  }
  const cells = shipCells(placement);
  const outside = cells.find((cell) => !inBounds(cell));
  if (outside) {
    return rejectPlacement(
      REJECTION.OUT_OF_BOUNDS,
      `the ${placement.ship} leaves the board at ${formatCoordinate(outside)}`,
    );
  }
  return { ok: true, ship: placement.ship, cells };
}

/**
 * Validates a WHOLE fleet: six ships, one of each, every one inside the board,
 * every one its required length, and no two sharing a cell.
 *
 * Touching — including diagonally — is legal and deliberately not checked.
 */
export function validateFleet(fleet: Fleet | null | undefined): FleetVerdict {
  const ships = fleet?.ships;
  if (!Array.isArray(ships)) {
    return { ok: false, code: REJECTION.INVALID_FLEET, message: "a fleet must carry a ships array" };
  }
  if (ships.length !== FLEET_SIZE) {
    return {
      ok: false,
      code: REJECTION.WRONG_FLEET_SIZE,
      message: `a fleet is exactly ${FLEET_SIZE} ships, got ${ships.length}`,
    };
  }

  const byShip = new Map<ShipKey, ShipPlacement>();
  for (const placement of ships) {
    const verdict = validateShipPlacement(placement);
    if (verdict.ok === false) return { ok: false, code: verdict.code, message: verdict.message };
    if (byShip.has(verdict.ship)) {
      return {
        ok: false,
        code: REJECTION.DUPLICATE_SHIP,
        message: `the ${verdict.ship} is placed more than once`,
      };
    }
    byShip.set(verdict.ship, placement);
  }

  const missing = SHIP_KEYS.find((ship) => !byShip.has(ship));
  if (missing) {
    return {
      ok: false,
      code: REJECTION.MISSING_SHIP,
      message: `the fleet has no ${missing}`,
    };
  }

  // Overlap is the ONLY contact rule: touching, even diagonally, is legal.
  const occupied = new Map<string, ShipKey>();
  const cells = {} as Record<ShipKey, Coordinate[]>;
  for (const ship of SHIP_KEYS) {
    const placement = byShip.get(ship) as ShipPlacement;
    const shipCellList = shipCells(placement);
    cells[ship] = shipCellList;
    for (const cell of shipCellList) {
      const key = cellKey(cell);
      const other = occupied.get(key);
      if (other) {
        return {
          ok: false,
          code: REJECTION.OVERLAP,
          message: `the ${ship} overlaps the ${other} at ${formatCoordinate(cell)}`,
        };
      }
      occupied.set(key, ship);
    }
  }

  if (occupied.size !== FLEET_CELL_COUNT) {
    return {
      ok: false,
      code: REJECTION.WRONG_CELL_COUNT,
      message: `a fleet occupies exactly ${FLEET_CELL_COUNT} cells, got ${occupied.size}`,
    };
  }

  return { ok: true, cells: cells as FleetCells };
}

/** The cells of every ship, keyed by ship. Throws when the fleet is invalid. */
export function fleetCells(fleet: Fleet): FleetCells {
  const verdict = validateFleet(fleet);
  if (verdict.ok === false) throw new BattleshipRuleError(verdict.code, verdict.message);
  return verdict.cells;
}

// ── Damage and single-shot evaluation ─────────────────────────────────────

/** The ship occupying a cell, or null for open water. */
export function shipAt(fleet: Fleet, coordinate: Coordinate): ShipKey | null {
  for (const placement of fleet.ships) {
    if (shipCells(placement).some((cell) => cellKey(cell) === cellKey(coordinate))) {
      return placement.ship;
    }
  }
  return null;
}

function hitKeysFrom(attacks: readonly AttackRecord[]): Set<string> {
  const hits = new Set<string>();
  for (const attack of attacks) {
    if (attack.result !== SHOT_RESULTS.MISS) hits.add(String(attack.coordinate));
  }
  return hits;
}

/**
 * Evaluates ONE shot against an immutable fleet plus the shots already fired at
 * it. Pure: nothing is recorded here, which is exactly what lets both attacks of
 * a round be judged against the same pre-round position.
 */
export function evaluateShot(
  fleet: Fleet,
  previousAttacks: readonly AttackRecord[],
  coordinate: Coordinate,
): AttackResolution {
  const label = formatCoordinate(coordinate);
  const ship = shipAt(fleet, coordinate);
  if (!ship) {
    return { coordinate: label, result: SHOT_RESULTS.MISS, ship: null };
  }
  const hits = hitKeysFrom(previousAttacks);
  hits.add(label);
  const placement = fleet.ships.find((candidate) => candidate.ship === ship) as ShipPlacement;
  const sunk = shipCells(placement).every((cell) => hits.has(formatCoordinate(cell)));
  return {
    coordinate: label,
    result: sunk ? SHOT_RESULTS.SUNK : SHOT_RESULTS.HIT,
    ship: sunk ? ship : null,
  };
}

/** Has this player already attacked this cell? */
export function hasAttacked(attacks: readonly AttackRecord[], coordinate: Coordinate): boolean {
  const label = formatCoordinate(coordinate);
  return attacks.some((attack) => attack.coordinate === label);
}

/** True when every cell of every ship of `fleet` has been hit. */
export function fleetDestroyed(fleet: Fleet, attacks: readonly AttackRecord[]): boolean {
  const hits = hitKeysFrom(attacks);
  return fleet.ships.every((placement) =>
    shipCells(placement).every((cell) => hits.has(formatCoordinate(cell))),
  );
}

/** Which of this fleet's ships are already fully hit. */
export function sunkShips(fleet: Fleet, attacks: readonly AttackRecord[]): ShipKey[] {
  const hits = hitKeysFrom(attacks);
  return fleet.ships
    .filter((placement) => shipCells(placement).every((cell) => hits.has(formatCoordinate(cell))))
    .map((placement) => placement.ship);
}

// ── Match state ───────────────────────────────────────────────────────────

/**
 * Opens a match with both fleets already placed. Placement is a store concern
 * (it happens before a match reaches the engine), so an engine state is always
 * playable.
 */
export function createMatchState(fleets: { player1: Fleet; player2: Fleet }): PrivateMatchState {
  for (const seat of SEATS) {
    const verdict = validateFleet(fleets?.[seat]);
    if (verdict.ok === false) {
      throw new BattleshipRuleError(verdict.code, `${seat}: ${verdict.message}`);
    }
  }
  return {
    status: MATCH_STATUS.PLAYING,
    round: 1,
    players: {
      player1: { seat: "player1", fleet: fleets.player1, attacks: [] },
      player2: { seat: "player2", fleet: fleets.player2, attacks: [] },
    },
    outcome: null,
    winner: null,
  };
}

function winnerFor(outcome: MatchOutcome | null): Seat | null {
  if (outcome === MATCH_OUTCOME.PLAYER1) return "player1";
  if (outcome === MATCH_OUTCOME.PLAYER2) return "player2";
  return null;
}

function validateAttackLog(state: PrivateMatchState, seat: Seat): StateValidation {
  const own = state.players[seat];
  const enemyFleet = state.players[otherSeat(seat)].fleet;
  const seen = new Set<string>();
  const replay: AttackRecord[] = [];

  for (let index = 0; index < own.attacks.length; index += 1) {
    const record = own.attacks[index];
    // One shot per seat per round, starting at round 1: the engine only ever
    // produces 1..n, so anything else is a corrupted row rather than a rule.
    if (record.round !== index + 1) {
      return {
        ok: false,
        code: REJECTION.INVALID_ROUND,
        message: `${seat} shot ${index + 1} claims round ${String(record.round)}`,
      };
    }
    const coordinate = parseCoordinate(record.coordinate);
    if (!coordinate || !inBounds(coordinate)) {
      return {
        ok: false,
        code: REJECTION.INVALID_COORDINATE,
        message: `${seat} has an unreadable coordinate "${String(record.coordinate)}"`,
      };
    }
    const key = cellKey(coordinate);
    if (seen.has(key)) {
      return {
        ok: false,
        code: REJECTION.ALREADY_ATTACKED,
        message: `${seat} attacked ${record.coordinate} twice`,
      };
    }
    const expected = evaluateShot(enemyFleet, replay, coordinate);
    if (expected.result !== record.result) {
      return {
        ok: false,
        code: REJECTION.INVALID_STATE,
        message: `${seat}'s shot at ${record.coordinate} is recorded as "${String(record.result)}" but is "${expected.result}"`,
      };
    }
    if (record.result === SHOT_RESULTS.SUNK) {
      if (record.ship !== expected.ship) {
        return {
          ok: false,
          code: REJECTION.INVALID_STATE,
          message: `${seat}'s shot at ${record.coordinate} names the wrong sunk ship`,
        };
      }
    } else if (record.ship !== null && record.ship !== undefined) {
      return {
        ok: false,
        code: REJECTION.INVALID_STATE,
        message: `only a sunk shot may name a ship (${seat} at ${record.coordinate})`,
      };
    }
    seen.add(key);
    replay.push(record);
  }

  return { ok: true };
}

/**
 * Validates a whole authoritative state: both fleets, the attack log's internal
 * consistency (rounds, coordinates, recomputed results, no duplicates), and that
 * the recorded outcome agrees with the boards. Used by the store before writing
 * and by `resolveRound` before accepting a round.
 */
export function validateMatchState(state: PrivateMatchState | null | undefined): StateValidation {
  if (!state || typeof state !== "object") {
    return { ok: false, code: REJECTION.INVALID_STATE, message: "a match state must be an object" };
  }
  if (state.status !== MATCH_STATUS.PLAYING && state.status !== MATCH_STATUS.FINISHED) {
    return {
      ok: false,
      code: REJECTION.INVALID_STATE,
      message: `"${String(state.status)}" is not a match status`,
    };
  }
  if (!Number.isInteger(state.round) || state.round < 1) {
    return {
      ok: false,
      code: REJECTION.INVALID_ROUND,
      message: `a match starts at round 1, got ${String(state.round)}`,
    };
  }

  for (const seat of SEATS) {
    const player = state.players?.[seat];
    if (!player) {
      return { ok: false, code: REJECTION.INVALID_STATE, message: `the state has no ${seat}` };
    }
    const verdict = validateFleet(player.fleet);
    if (verdict.ok === false) {
      return { ok: false, code: verdict.code, message: `${seat}: ${verdict.message}` };
    }
    const logVerdict = validateAttackLog(state, seat);
    if (!logVerdict.ok) return logVerdict;
  }

  if (state.players.player1.attacks.length !== state.players.player2.attacks.length) {
    return {
      ok: false,
      code: REJECTION.INVALID_STATE,
      message: "both seats resolve exactly one attack per round",
    };
  }

  const player1Destroyed = fleetDestroyed(state.players.player2.fleet, state.players.player1.attacks);
  const player2Destroyed = fleetDestroyed(state.players.player1.fleet, state.players.player2.attacks);

  if (state.status === MATCH_STATUS.FINISHED) {
    const expected: MatchOutcome | null =
      player1Destroyed && player2Destroyed
        ? MATCH_OUTCOME.DRAW
        : player1Destroyed
          ? MATCH_OUTCOME.PLAYER1
          : player2Destroyed
            ? MATCH_OUTCOME.PLAYER2
            : null;
    if (!expected) {
      return {
        ok: false,
        code: REJECTION.INVALID_STATE,
        message: "a finished match must have a destroyed fleet behind its result",
      };
    }
    if (state.outcome !== expected) {
      return {
        ok: false,
        code: REJECTION.INVALID_STATE,
        message: `the outcome "${String(state.outcome)}" disagrees with the boards ("${expected}")`,
      };
    }
    if ((state.winner ?? null) !== winnerFor(expected)) {
      return {
        ok: false,
        code: REJECTION.INVALID_STATE,
        message: "the winner disagrees with the outcome",
      };
    }
  } else {
    if (player1Destroyed || player2Destroyed) {
      return {
        ok: false,
        code: REJECTION.INVALID_STATE,
        message: "a fleet is destroyed but the match is still playing",
      };
    }
    if ((state.outcome ?? null) !== null || (state.winner ?? null) !== null) {
      return {
        ok: false,
        code: REJECTION.INVALID_STATE,
        message: "a running match cannot carry an outcome",
      };
    }
  }

  return { ok: true };
}

// ── Round resolution ──────────────────────────────────────────────────────

function parseSubmission(input: CoordinateInput | undefined): Coordinate | null {
  return parseCoordinate(input);
}

/**
 * Resolves ONE round from both players' locked attacks.
 *
 * Order of operations is the whole point:
 *   1. validate the state,
 *   2. validate BOTH submissions against the pre-round attacks (a duplicate or
 *      an out-of-board cell rejects the round; nothing is applied),
 *   3. evaluate BOTH shots against the same immutable pre-round fleets,
 *   4. only then append both records,
 *   5. derive both results, both sunk ships, both fleet-destroyed flags,
 *   6. decide the outcome: both destroyed → draw; one → that seat; else continue.
 *
 * Because step 3 never sees the other seat's shot, one player's attack can
 * neither save nor doom the other's — a mutual final hit is a draw, and a losing
 * player still lands their own shot.
 */
export function resolveRound(
  state: PrivateMatchState,
  submissions: RoundSubmissions,
): RoundResolution {
  const stateVerdict = validateMatchState(state);
  if (stateVerdict.ok === false) {
    return { ok: false, code: stateVerdict.code, message: stateVerdict.message, invalid: {} };
  }
  if (state.status === MATCH_STATUS.FINISHED) {
    return {
      ok: false,
      code: REJECTION.MATCH_FINISHED,
      message: "the match is already over",
      invalid: {},
    };
  }

  const invalid: Partial<Record<Seat, RejectionCode>> = {};
  const messages: string[] = [];
  const coordinates: Partial<Record<Seat, Coordinate>> = {};

  for (const seat of SEATS) {
    const coordinate = parseSubmission(submissions?.[seat]);
    if (!coordinate) {
      invalid[seat] = REJECTION.INVALID_COORDINATE;
      messages.push(`${seat}: "${String(submissions?.[seat])}" is not a coordinate`);
      continue;
    }
    if (!inBounds(coordinate)) {
      invalid[seat] = REJECTION.OUT_OF_BOUNDS;
      messages.push(`${seat}: ${formatCoordinate(coordinate)} is off the board`);
      continue;
    }
    if (hasAttacked(state.players[seat].attacks, coordinate)) {
      invalid[seat] = REJECTION.ALREADY_ATTACKED;
      messages.push(`${seat}: ${formatCoordinate(coordinate)} was already attacked`);
      continue;
    }
    coordinates[seat] = coordinate;
  }

  if (Object.keys(invalid).length > 0) {
    const code = (Object.values(invalid)[0] as RejectionCode) ?? REJECTION.INVALID_STATE;
    return { ok: false, code, message: messages.join("; "), invalid };
  }

  // Step 3 — both shots judged against the SAME pre-round fleets.
  const resolutions = {} as Record<Seat, AttackResolution>;
  for (const seat of SEATS) {
    resolutions[seat] = evaluateShot(
      state.players[otherSeat(seat)].fleet,
      state.players[seat].attacks,
      coordinates[seat] as Coordinate,
    );
  }

  // Step 4 — apply both records together.
  const records = {} as Record<Seat, AttackRecord[]>;
  for (const seat of SEATS) {
    const resolution = resolutions[seat];
    records[seat] = [
      ...state.players[seat].attacks,
      {
        round: state.round,
        seat,
        coordinate: resolution.coordinate,
        result: resolution.result,
        ship: resolution.ship,
      },
    ];
  }

  // Step 5 — derive both flags from the POST-round logs.
  const destroyed = {
    player1: fleetDestroyed(state.players.player2.fleet, records.player1),
    player2: fleetDestroyed(state.players.player1.fleet, records.player2),
  } as Record<Seat, boolean>;

  // Step 6 — outcome, with the simultaneous double-kill resolved as a DRAW.
  let outcome: MatchOutcome | null = null;
  if (destroyed.player1 && destroyed.player2) outcome = MATCH_OUTCOME.DRAW;
  else if (destroyed.player1) outcome = MATCH_OUTCOME.PLAYER1;
  else if (destroyed.player2) outcome = MATCH_OUTCOME.PLAYER2;

  const status = outcome ? MATCH_STATUS.FINISHED : MATCH_STATUS.PLAYING;
  const nextState: PrivateMatchState = {
    status,
    round: outcome ? state.round : state.round + 1,
    players: {
      player1: { ...state.players.player1, attacks: records.player1 },
      player2: { ...state.players.player2, attacks: records.player2 },
    },
    outcome,
    winner: winnerFor(outcome),
  };

  const round: RoundResult = {
    round: state.round,
    attacks: resolutions,
    destroyed,
    outcome,
    status,
    roundAdvanced: !outcome,
  };

  return { ok: true, state: nextState, round };
}

// ── Public projections ────────────────────────────────────────────────────

/** An empty public board, `board[y][x]`, every cell unknown. */
export function emptyBoard(): BoardCell[][] {
  return Array.from({ length: BOARD_ROWS }, () =>
    Array.from({ length: BOARD_COLUMNS }, () => BOARD_CELL.UNKNOWN as BoardCell),
  );
}

function publicAttacks(attacks: readonly AttackRecord[]): PublicAttackEvent[] {
  return attacks.map((attack) => ({
    round: attack.round,
    coordinate: attack.coordinate,
    result: attack.result,
    ship: attack.ship ?? null,
  }));
}

/**
 * The board a player is allowed to see: their own shots against the enemy, with
 * misses, hits and — once a ship is destroyed — that ship's whole footprint
 * marked `sunk`. Nothing else can appear, so an enemy ship position is never
 * leaked by this projection.
 */
export function publicBoardFor(state: PrivateMatchState, seat: Seat): BoardCell[][] {
  const board = emptyBoard();
  const defender = state.players[otherSeat(seat)].fleet;

  for (const attack of state.players[seat].attacks) {
    const coordinate = parseCoordinate(attack.coordinate);
    if (!coordinate || !inBounds(coordinate)) continue;

    if (attack.result === SHOT_RESULTS.MISS) {
      board[coordinate.y][coordinate.x] = BOARD_CELL.MISS;
      continue;
    }
    if (attack.result === SHOT_RESULTS.HIT) {
      board[coordinate.y][coordinate.x] = BOARD_CELL.HIT;
      continue;
    }

    // SUNK — the ship is destroyed, so its footprint is public information.
    const placement = attack.ship
      ? defender.ships.find((candidate) => candidate.ship === attack.ship)
      : null;
    const cells = placement ? shipCells(placement) : [coordinate];
    for (const cell of cells) {
      if (inBounds(cell)) board[cell.y][cell.x] = BOARD_CELL.SUNK;
    }
  }

  return board;
}

function boardStateFor(state: PrivateMatchState, seat: Seat): PublicPlayerBoardState {
  const attacker = state.players[seat];
  const defender = state.players[otherSeat(seat)];
  const sunk = sunkShips(defender.fleet, attacker.attacks);
  return {
    board: publicBoardFor(state, seat),
    attacks: publicAttacks(attacker.attacks),
    sunkShips: sunk,
    enemyShipsRemaining: FLEET_SIZE - sunk.length,
  };
}

/** The whole match as any client may see it — no fleet positions anywhere. */
export function publicMatchState(state: PrivateMatchState): PublicMatchState {
  return {
    status: state.status,
    round: state.round,
    outcome: state.outcome,
    winner: state.winner,
    boards: {
      player1: boardStateFor(state, "player1"),
      player2: boardStateFor(state, "player2"),
    },
  };
}

/**
 * What ONE player may hold: their own fleet plus the public boards. The
 * opponent object has no `fleet` field at all, which is the structural guarantee
 * that an enemy ship position cannot be serialized to a client.
 */
export function matchViewForSeat(state: PrivateMatchState, seat: Seat): MatchView {
  const opponent = otherSeat(seat);
  const own = state.players[seat];
  const ownSunk = sunkShips(state.players[opponent].fleet, own.attacks);
  const opponentView = boardStateFor(state, opponent);
  return {
    status: state.status,
    round: state.round,
    outcome: state.outcome,
    winner: state.winner,
    you: {
      seat,
      fleet: own.fleet,
      ...boardStateFor(state, seat),
      sunkShips: ownSunk,
    },
    opponent: {
      seat: opponent,
      board: opponentView.board,
      attacks: opponentView.attacks,
      sunkShips: opponentView.sunkShips,
      enemyShipsRemaining: opponentView.enemyShipsRemaining,
    },
  };
}

/** WIN / LOSS / DRAW / CONTINUE, from one seat's point of view. */
export function outcomeForSeat(outcome: MatchOutcome | null, seat: Seat): SeatResult {
  if (!outcome) return SEAT_RESULTS.CONTINUE;
  if (outcome === MATCH_OUTCOME.DRAW) return SEAT_RESULTS.DRAW;
  return outcome === seat ? SEAT_RESULTS.WIN : SEAT_RESULTS.LOSS;
}
