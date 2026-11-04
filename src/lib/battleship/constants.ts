/**
 * Battleship (GRYND) — board geometry, the fleet table and every magic string
 * the PURE rules engine can emit.
 *
 * ── GEOMETRY ──────────────────────────────────────────────────────────────
 *
 *   * The board is 14×10 — a LANDSCAPE board. Columns are the letters A–N and
 *     rows are the numbers 1–10, so a cell is addressed exactly the way the
 *     physical game prints it ("B7"). Internally a cell is `{ x, y }` with
 *     `0 ≤ x < BOARD_COLUMNS` and `0 ≤ y < BOARD_ROWS`, where `x` is the column
 *     index (A = 0) and `y` the row index (1 = 0) — the same top-left origin
 *     every other GRYND board uses.
 *   * A ship placement is addressed by its FIRST cell — the LEFTMOST cell when
 *     horizontal, the TOPMOST cell when vertical — plus its orientation, so a
 *     placement is unambiguous and its cells can never drift from it.
 *
 * ── FLEET ─────────────────────────────────────────────────────────────────
 *
 *   Carrier 5, Battleship 4, Cruiser 3, Submarine 3, Frigate 3, Destroyer 2 =
 *   20 cells.
 *
 * Ships MAY touch, orthogonally or diagonally: in the physical game the only
 * illegal contact is a shared cell. That is why `validateFleet` rejects overlap
 * and nothing else — a rule set that also forbade adjacency would make the game
 * materially smaller and is not what the table game prints.
 *
 * None of this module touches React, HTTP, SQL or browser APIs.
 */

/**
 * Board size in cells: 14 columns × 10 rows. The extra columns are what make the
 * board wider than it is tall — more water to hide a fleet in, with cells small
 * enough that the whole board still fits the card it is drawn in.
 */
export const BOARD_COLUMNS = 14;
export const BOARD_ROWS = 10;

/** Every addressable cell on one board. */
export const BOARD_CELL_COUNT = BOARD_COLUMNS * BOARD_ROWS;

/** The column labels, in `x` order. */
export const COLUMNS = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
] as const;

/** The row labels, in `y` order. */
export const ROWS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** The two ways a ship can lie. `horizontal` grows along +x; `vertical` along +y. */
export const ORIENTATIONS = ["horizontal", "vertical"] as const;

/** The two seats. A seat comes from the match row, never from a request body. */
export const SEATS = ["player1", "player2"] as const;

/**
 * Canonical fleet order — largest first. Placements are serialized and
 * validated in THIS order, so a fleet has one canonical text form.
 */
export const SHIP_KEYS = [
  "carrier",
  "battleship",
  "cruiser",
  "submarine",
  "frigate",
  "destroyer",
] as const;

export const SHIP_NAMES: Readonly<Record<(typeof SHIP_KEYS)[number], string>> = {
  carrier: "Carrier",
  battleship: "Battleship",
  cruiser: "Cruiser",
  submarine: "Submarine",
  frigate: "Frigate",
  destroyer: "Destroyer",
};

/**
 * The ONLINE match phases stored on `battleship_matches.phase`.
 *
 * Deliberately separate from `MATCH_STATUS` above, which is the pure engine's
 * vocabulary: the engine only ever sees a match once both fleets are placed, so
 * it knows `playing`/`finished`, while the store also owns waiting, placement
 * and cancellation.
 */
export const MATCH_PHASE = {
  WAITING: "waiting",
  PLACEMENT: "placement",
  COMBAT: "combat",
  FINISHED: "finished",
  CANCELLED: "cancelled",
} as const;

/** How long a player has to place their fleet once both seats are filled. */
export const PLACEMENT_SECONDS = 60;

/** The combat round clock the resolution phase enforces. */
export const ROUND_SECONDS = 15;

/**
 * One Postgres advisory-lock namespace per game, so Battleship matchmaking
 * serialises against itself and never against another game's lobby sweep.
 * "BSHP" packed into 31 bits, matching the other games' convention.
 */
export const BATTLESHIP_LOCK_NAMESPACE = 0x42534850 & 0x7fffffff;

/**
 * The sentinel id the practice bot occupies in seat 2. It is NOT a real account:
 * it never appears in `users`, `getSeatIdentity` skips it (real ids start with
 * `user_`), and the client labels the seat "GRYND AI" from the `is_ai` flag.
 */
export const BATTLESHIP_AI_PLAYER_ID = "battleship_ai_bot";

/** Cells per ship type. This table IS the fleet requirement. */
export const SHIP_LENGTHS: Readonly<Record<(typeof SHIP_KEYS)[number], number>> = {
  carrier: 5,
  battleship: 4,
  cruiser: 3,
  submarine: 3,
  frigate: 3,
  destroyer: 2,
};

/** The fleet table as an ordered list, for UI and validation. */
export const FLEET_SPEC = SHIP_KEYS.map((key) => ({
  key,
  name: SHIP_NAMES[key],
  length: SHIP_LENGTHS[key],
}));

/** Exactly six ships. */
export const FLEET_SIZE = SHIP_KEYS.length;

/** Exactly twenty occupied cells. */
export const FLEET_CELL_COUNT = SHIP_KEYS.reduce((sum, key) => sum + SHIP_LENGTHS[key], 0);

/**
 * Match lifecycle as the ENGINE knows it. Placement happens in the store before
 * a match reaches the engine: a state only exists once both fleets are placed.
 */
export const MATCH_STATUS = {
  PLAYING: "playing",
  FINISHED: "finished",
} as const;

/** What one attack came back as. `sunk` means THIS shot destroyed the ship. */
export const SHOT_RESULTS = {
  MISS: "miss",
  HIT: "hit",
  SUNK: "sunk",
} as const;

/** A PUBLIC board cell: everything a player is allowed to know about a cell. */
export const BOARD_CELL = {
  UNKNOWN: "unknown",
  MISS: "miss",
  HIT: "hit",
  SUNK: "sunk",
} as const;

/** The final result of a match, in match-absolute terms. */
export const MATCH_OUTCOME = {
  PLAYER1: "player1",
  PLAYER2: "player2",
  DRAW: "draw",
} as const;

/** The same result from one seat's point of view. */
export const SEAT_RESULTS = {
  WIN: "win",
  LOSS: "loss",
  DRAW: "draw",
  CONTINUE: "continue",
} as const;

/** Machine-readable rejection codes (also the API/UI error keys). */
export const REJECTION = {
  INVALID_COORDINATE: "invalid_coordinate",
  OUT_OF_BOUNDS: "out_of_bounds",
  INVALID_ORIENTATION: "invalid_orientation",
  INVALID_SHIP: "invalid_ship",
  OVERLAP: "overlap",
  DUPLICATE_SHIP: "duplicate_ship",
  MISSING_SHIP: "missing_ship",
  WRONG_FLEET_SIZE: "wrong_fleet_size",
  WRONG_CELL_COUNT: "wrong_cell_count",
  INVALID_FLEET: "invalid_fleet",
  ALREADY_ATTACKED: "already_attacked",
  MATCH_FINISHED: "match_finished",
  INVALID_ROUND: "invalid_round",
  INVALID_STATE: "invalid_state",
} as const;
