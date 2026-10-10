/**
 * Barricade (GRYND) — board geometry, inventories and every magic string the
 * PURE rules engine can emit.
 *
 * Barricade is Quoridor under a different name: a 9×9 race in which each player
 * spends one action per turn either walking their pawn one square or dropping a
 * two-square barricade that blocks BOTH players. This module and `./rules` are
 * the single source of truth for those rules; the store, the AI and the board
 * UI are all expected to derive from them rather than re-implement them.
 *
 * SOURCES — the rule model below is transcribed from, and cross-checked
 * against, two published rule sets:
 *
 *   1. the reference game, Barricade — https://barricade.gg/rules
 *      ("9×9 grid… middle square of their back row with 10 barricades…
 *        move one square up, down, left or right — no diagonals… barricades are
 *        two squares long and sit between cells… can't overlap or cross… can't
 *        completely cut off either player's path… when the two players are
 *        adjacent you can jump over your opponent to the square directly behind
 *        them. If there's a barricade (or the board edge) directly behind your
 *        opponent you can't jump straight — instead you move diagonally to
 *        either square beside them… the first player to reach any square on the
 *        opposite side wins")
 *
 *   2. the original board game, Gigamic's Quoridor rulebook, quoted via
 *      https://www.ultraboardgames.com/quoridor/game-rules.php and
 *      https://en.wikipedia.org/wiki/Quoridor (which is where the reference
 *      game's rules come from, and which settles the two places Barricade's own
 *      rules page is silent on — see docs/GAME_BARRICADE.md, "Documented
 *      decisions and discrepancies").
 *
 * Two of those decisions are worth knowing before reading `./rules`:
 *
 *   * A jump is only legal when the two pawns are NOT separated by a
 *     barricade. Quoridor: "When two pawns face each other on neighboring
 *     squares WHICH ARE NOT SEPARATED BY A FENCE, the player whose turn it is
 *     can jump the opponent's pawn." barricade.gg omits the qualifier; we
 *     follow the stricter, published rule.
 *   * A diagonal (lateral) jump may not hop a barricade. Quoridor: "Walls may
 *     not be jumped, including when moving laterally due to a pawn or wall
 *     being behind a jumped pawn." So the diagonal is legal only when both of
 *     the squares it travels (sideways past the pawn, then across) are open.
 *
 * None of this module touches React, HTTP, D1/SQL or browser APIs.
 */

/** Board edge length. barricade.gg: "played on a 9×9 grid". */
export const BOARD_SIZE = 9;

/** Interior grooves per axis — a barricade slot is always 2 squares long. */
export const WALL_SLOTS = BOARD_SIZE - 1; // 8

/** Starting barricades per player. barricade.gg: "10 barricades in reserve". */
export const WALLS_PER_PLAYER = 10;

/** Centre column — both pawns start here, on opposite baselines. */
export const CENTRE_COLUMN = (BOARD_SIZE - 1) / 2; // 4

/** The two seats, in turn order. Seat is derived from the match, never a client. */
export const SEATS = ["player1", "player2"] as const;

/** player1 owns the bottom baseline (row 0) and races upwards; player2 mirrors. */
export const FIRST_SEAT = "player1";

/** A wall is either horizontal (blocks up/down) or vertical (blocks left/right). */
export const ORIENTATIONS = ["horizontal", "vertical"] as const;

/** Match lifecycle, matching the vocabulary the rest of GRYND stores persist. */
export const MATCH_STATUS = {
  WAITING: "waiting",
  PLAYING: "playing",
  FINISHED: "finished",
  CANCELLED: "cancelled",
} as const;

/**
 * Advisory-lock namespace for the online match store's matchmaking critical
 * section (`pg_advisory_xact_lock(BARRICADE_LOCK_NAMESPACE, 0)`). One namespace
 * per game, exactly like the other PvP stores, so two concurrent callers can
 * never both open a lobby and a caller can never join a lobby being cancelled.
 */
export const BARRICADE_LOCK_NAMESPACE = 0x42435244 & 0x7fffffff; // "BCRD"

/** The two action kinds a turn can consist of — exactly one of them, never both. */
export const ACTION_TYPES = {
  MOVE: "move",
  WALL: "wall",
} as const;

/**
 * How a pawn reached its destination. Purely descriptive — the engine derives
 * it from the geometry, and the UI/analytics use it to pick an animation.
 */
export const MOVE_KINDS = {
  STEP: "step", // one square, orthogonal
  JUMP_STRAIGHT: "jump-straight", // two squares over the opponent
  JUMP_DIAGONAL: "jump-diagonal", // past the opponent, around a block behind them
} as const;

/**
 * Why a match ended. The engine itself only ever produces REACHED_BASELINE;
 * RESIGNED / TIMED_OUT / ABANDONED belong to the store (barricade.gg: "You also
 * win if your opponent resigns or runs out of time") and are declared here so
 * every terminal state in the app shares one vocabulary.
 */
export const END_REASONS = {
  REACHED_BASELINE: "reached-baseline",
  RESIGNED: "resigned",
  TIMED_OUT: "timed-out",
  ABANDONED: "abandoned",
} as const;

/** A terminal outcome can never be a draw — somebody walks to the far baseline. */
export const WIN_REASON = END_REASONS.REACHED_BASELINE;

/**
 * Every reason `validateAction` / `applyAction` can reject a turn. These strings
 * are the contract with the API routes and the UI (they become the 400 body and
 * the toast), so they are stable and kebab-cased.
 */
export const REJECTION = {
  /** The action object is not `{ type: "move" | "wall", … }`. */
  INVALID_ACTION: "invalid-action",
  /** `seat` is not one of SEATS. */
  INVALID_SEAT: "invalid-seat",
  /** A coordinate is not an integer inside the board / slot grid. */
  OUT_OF_BOUNDS: "out-of-bounds",
  /** `orientation` is neither "horizontal" nor "vertical". */
  INVALID_ORIENTATION: "invalid-orientation",
  /** Match is finished/cancelled — no further move is accepted. */
  MATCH_NOT_PLAYING: "match-not-playing",
  /** The acting seat is not the seat on turn. */
  NOT_YOUR_TURN: "not-your-turn",
  /** A derived `kind` was supplied and contradicts the geometry. */
  ACTION_MISMATCH: "action-mismatch",
  /** Destination already holds a pawn (and is not a legal jump target). */
  DESTINATION_OCCUPIED: "destination-occupied",
  /** Destination is not adjacent and not a jump target at all. */
  MOVE_NOT_ADJACENT: "move-not-adjacent",
  /** Destination would be legal, but a barricade lies across the path. */
  MOVE_BLOCKED_BY_WALL: "move-blocked-by-wall",
  /** A jump was attempted where the rules do not allow one. */
  JUMP_NOT_AVAILABLE: "jump-not-available",
  /** That seat has spent its barricades and must move its pawn. */
  NO_WALLS_REMAINING: "no-walls-remaining",
  /** A barricade already occupies that groove segment. */
  WALL_OVERLAP: "wall-overlap",
  /** A barricade of the other orientation already occupies that slot. */
  WALL_CROSSING: "wall-crossing",
  /** The barricade would cut off a pawn's last route to its goal. */
  WALL_BLOCKS_PATH: "wall-blocks-path",
} as const;
