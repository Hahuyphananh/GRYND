/**
 * Dominoes (GRYND) — the double-six set, the deal shape and every magic string
 * the PURE rules engine can emit.
 *
 * Dominoes here is the classic two-player "block" game played with the standard
 * double-six set: 28 unique tiles, seven to each player and fourteen face down.
 * This module and `./rules` are the single source of truth for those rules; the
 * server store, the board UI and the tests are all expected to derive from them
 * rather than re-implement them.
 *
 * THE RULES, AND WHERE THEY COME FROM (transcribed, in the order a player meets
 * them — the authority for the engine is `./rules`):
 *
 *   1. Set — 28 unique tiles, every unordered pair of values 0..6, i.e. a tile
 *      has two halves and `6-3` is the SAME tile as `3-6`. Identity is
 *      canonicalised to `"<high>-<low>"` (`TILE_IDS`), so a duplicate cannot
 *      even be named, and `TILE_COUNT` is derived rather than asserted.
 *   2. Deal — 7 tiles each, the remaining 14 shuffled face down as the draw
 *      pile. The pile's ORDER is the shuffled order: drawing takes the next
 *      tile off it, never a re-randomised index, so a persisted deal replays
 *      exactly.
 *   3. Start — the highest double in either hand starts (6-6 down to 0-0).
 *      With no double anywhere, the highest TOTAL tile starts. Two hands can
 *      hold equal totals, so the tie-break is the canonical tile order
 *      (`TILE_IDS` is descending high half, then descending low half): the
 *      earlier tile wins, and two disjoint hands can never share a tile, so the
 *      tie-break is total. The same deal therefore ALWAYS produces the same
 *      starting seat.
 *   4. Chain — one shared line of tiles with two open values, one at each end.
 *      A tile is legal on an end when one of its halves equals that end's open
 *      value; the engine orients the tile (the matching half faces the chain,
 *      the other half becomes the new open value). A double is a tile whose
 *      halves are equal: it is displayed crosswise but matches like any other.
 *   5. Turn — a tile may only be played by the seat on turn, only from that
 *      seat's own hand, and only when the match is still `playing`.
 *   6. Draw — a seat with NO legal tile draws one tile at a time and keeps the
 *      turn while it does; a drawn tile may be played immediately, and if it is
 *      not playable the seat draws again. Drawing is therefore legal only when
 *      nothing in hand is playable, and a playable tile may never be skipped.
 *   7. Pass — the pile is empty and the seat still cannot play.
 *   8. Victory — a hand that empties wins immediately. With the pile empty and
 *      NEITHER seat able to play, the round is over: fewer remaining pips wins,
 *      and equal pips are a draw. This is checked after every accepted action,
 *      so a draw that empties the pile ends the round without a ceremonial
 *      pass.
 *   9. Terminal — a finished match accepts nothing further.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT CONTAIN:
 *
 *   * the 15-second turn clock and its timeout action, the disconnect forfeit,
 *     the matchmaking lock namespace usage and the persistence shape. Those are
 *     the server store's policy, not the corpus of rules — the engine only
 *     exposes the legal actions a turn may consist of, which is what a timeout
 *     resolver chooses between.
 *   * anything from React, HTTP, D1/SQL or the browser. The only platform API
 *     the engine touches at all is Web Crypto, and only in `./deal`, behind an
 *     injectable RNG.
 */

import type { TileId } from "./types";

/** Highest half-value on a tile. A double-six set stops here. */
export const MAX_PIP = 6;

/** Every legal half-value, ascending. */
export const PIP_VALUES = [0, 1, 2, 3, 4, 5, 6] as const;

/**
 * The canonical tile order: `"6-6"`, `"6-5"` … `"6-0"`, `"5-5"` … `"0-0"`.
 *
 * This one order carries three jobs, which is why it is defined once:
 *   * it enumerates the set, so `TILE_IDS.length` IS the tile count;
 *   * it is the tie-break when two hands hold tiles with equal pip totals for
 *     the starting seat (see `chooseStartingSeat` in `./rules`);
 *   * it gives every tile a stable sort key, so a dealt hand is stored in a
 *     predictable order and a state compares byte for byte.
 */
function buildTileIds(): TileId[] {
  const ids: TileId[] = [];
  for (let high = MAX_PIP; high >= 0; high -= 1) {
    for (let low = high; low >= 0; low -= 1) {
      ids.push(`${high}-${low}` as TileId);
    }
  }
  return ids;
}

/** The 28 tiles of a double-six set, canonical order. Frozen. */
export const TILE_IDS: readonly TileId[] = Object.freeze(buildTileIds());

/** Tiles in a set — 28, derived from the enumeration above. */
export const TILE_COUNT = TILE_IDS.length;

/** Tiles dealt to each seat. */
export const HAND_SIZE = 7;

/** Tiles left face down after the deal (28 - 2 × 7). */
export const DRAW_PILE_SIZE = TILE_COUNT - HAND_SIZE * 2;

/**
 * The two seats, in canonical order. A seat is derived from the match row,
 * never from a request body, and seat order is also the last-resort tie-break
 * when a caller hands the engine a deal that shares a tile between hands.
 */
export const SEATS = ["player1", "player2"] as const;

/** The two ends of the shared chain. */
export const CHAIN_ENDS = ["left", "right"] as const;

/** Match lifecycle, in the vocabulary the rest of GRYND's stores persist. */
export const MATCH_STATUS = {
  WAITING: "waiting",
  PLAYING: "playing",
  FINISHED: "finished",
  CANCELLED: "cancelled",
} as const;

/** The three action kinds a turn can consist of. */
export const ACTION_TYPES = {
  PLAY: "play",
  DRAW: "draw",
  PASS: "pass",
} as const;

/**
 * Why the round is over. The engine only ever produces EMPTIED_HAND or
 * BLOCKED_PIPS; the rest belong to the server store (a resignation, a
 * disconnect forfeit, an abandoned lobby) and are declared here so every
 * terminal state in the app shares one vocabulary.
 */
export const END_REASONS = {
  EMPTIED_HAND: "emptied-hand",
  BLOCKED_PIPS: "blocked-pips",
  RESIGNED: "resigned",
  TIMED_OUT: "timed-out",
  ABANDONED: "abandoned",
} as const;

/**
 * Advisory-lock namespace for the online match store's matchmaking critical
 * section (`pg_advisory_xact_lock(DOMINOES_LOCK_NAMESPACE, 0)`). One namespace
 * per game, exactly like the other PvP stores, so two concurrent callers can
 * never both open a lobby and a caller can never join a lobby being cancelled.
 *
 * Declared here (with the rest of the game's vocabulary) so the constant is
 * never duplicated in the store; the engine itself never uses it.
 */
export const DOMINOES_LOCK_NAMESPACE = 0x444f4d4e & 0x7fffffff; // "DOMN"

/**
 * The synthetic id that occupies the second seat of a FREE PRACTICE match.
 *
 * A bot is not an account: it has no `users` row, so it can never be rated,
 * never appear on a leaderboard, never receive the daily reward and can never
 * be found by `getSeatIdentity` (which queries `users`). It is a stable string
 * — not a UUID and not a Clerk id — so nothing that expects a real player can
 * mistake it for one. `is_ai` on the row is what declares the seat a bot; this
 * id is what the move log and the projection record.
 */
export const DOMINOES_AI_PLAYER_ID = "dominoes_ai_bot";

/**
 * How long the seat on turn has to act. The store stamps an absolute instant
 * (`turn_deadline_at`) from the SERVER clock and resolves an expired turn with
 * `applyTimeout`; a client countdown is decoration, never evidence.
 *
 * Declared here so the number is stated once, beside the game it paces. The
 * engine itself has no clock — `applyTimeout` is a pure function of the state.
 */
export const TURN_WINDOW_MS = 15_000;

/**
 * The persisted `result` vocabulary (the row's own column). `draw` is a real
 * outcome here — blocked on equal pips — unlike the win/lose-only duels.
 */
export const RESULT = {
  PLAYER1: "player1",
  PLAYER2: "player2",
  DRAW: "draw",
} as const;

/**
 * HOW THE STARTING SEAT WAS CHOSEN. Purely descriptive — the store and the
 * result screen show it, and the tests assert it — but it also documents the
 * two-branch rule at the place a reader meets it.
 */
export const STARTING_RULES = {
  HIGHEST_DOUBLE: "highest-double",
  HIGHEST_TOTAL: "highest-total",
} as const;

/**
 * Every reason `validateAction` / `applyAction` can reject a turn. These strings
 * are the contract with the API routes and the UI (they become the 400 body and
 * the toast), so they are stable and kebab-cased.
 */
export const REJECTION = {
  /** The action is not `{ type: "play" | "draw" | "pass", … }`. */
  INVALID_ACTION: "invalid-action",
  /** `seat` is not one of SEATS. */
  INVALID_SEAT: "invalid-seat",
  /** `tile` is not a tile of a double-six set (`"7-1"`, `"3-6"`, `"x"`, …). */
  INVALID_TILE: "invalid-tile",
  /** `end` is neither "left" nor "right", or a chain play named no end. */
  INVALID_END: "invalid-end",
  /** The dealt tiles are not a double-six deal (counts, duplicates, ids). */
  INVALID_DEAL: "invalid-deal",
  /** Match is finished/cancelled — no further action is accepted. */
  MATCH_NOT_PLAYING: "match-not-playing",
  /** The acting seat is not the seat on turn. */
  NOT_YOUR_TURN: "not-your-turn",
  /** That tile is a real tile, but it is in the other seat's hand (or none). */
  TILE_NOT_IN_HAND: "tile-not-in-hand",
  /** The tile does not match the open value of that end. */
  TILE_MISMATCH: "tile-mismatch",
  /** A playable tile exists, so neither drawing nor passing is allowed. */
  MUST_PLAY_TILE: "must-play-tile",
  /** The draw pile is empty — there is nothing to draw. */
  DRAW_PILE_EMPTY: "draw-pile-empty",
  /** The draw pile still holds tiles, so the seat must draw instead of pass. */
  DRAW_PILE_NOT_EMPTY: "draw-pile-not-empty",
} as const;
