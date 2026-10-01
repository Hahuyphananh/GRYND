// src/lib/speed-typing/constants.ts
//
// Shared constants for Speed Typing — GRYND's rated 1v1 typing race.
//
// This module carries the game's whole vocabulary: the canonical game key, the
// lobby/match lifecycle, the SERVER race clock (countdown, hard limit, dead-heat
// tolerance), the checkpoint throttle and the resolution reasons the
// authoritative store writes. The tunable numbers live here and nowhere else so
// the store, the pure rules (./rules.ts) and the tests all read one value.

// WHAT THIS GAME IS (the contract everything below serves):
//   * 1v1, real time, both seats receive the EXACT SAME text
//   * speed and accuracy both matter; first to correctly complete it wins
//   * NO randomness during gameplay, NO tokens, NO wagers, NO balances,
//     NO payouts, NO casino mechanics, NO AI-vs-AI settlement

/**
 * The canonical game key.
 *
 * ONE key spans every registry the platform has — the rated-game list
 * (`RATED_GAMES`, which `TROPHY_GAMES` reuses), the quick-queue key list, the
 * presence label map, the game-tag catalog, the canonical queue lifecycle
 * mirror and the settlement journals. There is deliberately no second
 * vocabulary anywhere, so nothing here can drift.
 */
export const GAME_KEY = "speed-typing" as const;

/** Display name, exactly as the lobby and the rating boards render it. */
export const GAME_DISPLAY_NAME = "Speed Typing" as const;

/**
 * The lobby/match route prefix. `/casino/*` is the app route and `/games/*` is
 * its canonical 308/rewrite alias (see next.config.js), so the canonical id,
 * the route and the card href all line up.
 */
export const GAME_ROUTE = "/casino/speed-typing" as const;

/**
 * `pg_advisory_xact_lock` namespace for matchmaking.
 *
 * A per-game namespace is what lets `createOrJoin` take one lock and make
 * "find an open lobby, else open one" atomic, so two concurrent callers can
 * never both see "no open lobby" and each create a row. Taken inside the
 * matchmaking transaction only (xact-scoped), so no lock is ever held across a
 * request. ASCII "SPTY" masked positive, matching the convention every other
 * PvP store uses.
 */
export const SPEED_TYPING_LOCK_NAMESPACE = 0x53505459 & 0x7fffffff;

/** Seats in a Speed Typing match. Strictly 1v1 — there is no other format. */
export const SEAT_COUNT = 2;

/**
 * Match lifecycle statuses, exactly the shared house vocabulary
 * (`waiting | ready | playing | finished | cancelled`) that the retention
 * sweep, the canonical queue mirror and the match-history formatter all
 * understand.
 *
 * `waiting` is the state a brand-new row is in, and — because a single row
 * doubles as the open lobby — it is also what makes the row joinable.
 */
export const MATCH_STATUS = {
  WAITING: "waiting",
  READY: "ready",
  PLAYING: "playing",
  FINISHED: "finished",
  CANCELLED: "cancelled",
} as const;

export type MatchStatus = (typeof MATCH_STATUS)[keyof typeof MATCH_STATUS];

/** Terminal statuses — nothing settles or transitions out of these. */
export const TERMINAL_STATUSES: readonly string[] = [
  MATCH_STATUS.FINISHED,
  MATCH_STATUS.CANCELLED,
];

/** The only terminal outcomes a settled match can carry. */
export const RESULT = {
  PLAYER1: "player1",
  PLAYER2: "player2",
  TIE: "tie",
} as const;

export type MatchResult = (typeof RESULT)[keyof typeof RESULT];

/** The two valid outcome tokens the shared rating/trophy writers accept. */
export const SETTLEMENT_RESULT = {
  WIN: "win",
  DRAW: "draw",
} as const;

export type SettlementResult =
  (typeof SETTLEMENT_RESULT)[keyof typeof SETTLEMENT_RESULT];

/**
 * The tier the practice bot plays at when a legacy/unchosen row is read.
 *
 * The shared `AiDifficulty` vocabulary resolves anything unrecognised to
 * `normal`; this constant names that fallback for Speed Typing so the AI and
 * the store read one value from one place, exactly like
 * `mini-golf`/`DEFAULT_MINI_GOLF_AI_DIFFICULTY`.
 */
export const DEFAULT_AI_DIFFICULTY = "normal" as const;

/**
 * Stable internal identity for the free human-vs-AI practice seat.
 *
 * It occupies `player2` of an `is_ai` row exactly as a real joiner would, so
 * every seat-based read (`seatForUser`, the race state, the settlement seam)
 * works unchanged — the only difference is that no token ever authenticates as
 * this id and the row is excluded from rating/trophies. Mirrors
 * MINI_GOLF_AI_PLAYER_ID and TIC_TAC_TOE_AI_PLAYER_ID.
 */
export const SPEED_TYPING_AI_PLAYER_ID = "speed_typing_ai_bot";

/**
 * The two seats, as the authoritative race state keys them.
 *
 * Seat ids are the ROW's (`player1` = host, `player2` = joiner): the race state
 * is a per-seat object, and every seat-keyed read/write goes through this
 * vocabulary so the JSONB shape can never drift from the columns beside it.
 */
export const SEAT = {
  PLAYER1: "player1",
  PLAYER2: "player2",
} as const;

export type SeatKey = (typeof SEAT)[keyof typeof SEAT];

/**
 * The countdown the server stamps between "both seats are present" and GO.
 *
 * The GO instant is written to the row as an ABSOLUTE server timestamp
 * (`go_at`), not as a delay each client applies locally. That is what makes the
 * race fair: both seats are told the same instant on the same clock, and a
 * slower connection costs nobody anything. Same principle as Precision's
 * server-stamped round clock — a client clock is never trusted with a number
 * that decides a rated match.
 */
export const RACE_COUNTDOWN_MS = 3_000;

/**
 * The hard limit, measured from GO.
 *
 * A race that reaches it without a verified finish is resolved by the server
 * from its OWN progress checkpoints (whoever typed further wins; an exact tie
 * is a draw), never left hanging — see `resolveRace` in ./rules.ts.
 */
export const RACE_LIMIT_MS = 120_000;

/**
 * Two verified finishes closer together than this are a dead heat.
 *
 * At the scale that matters (300-500 characters of text) this is far below any
 * human-observable difference, so it can only ever be hit by a genuine
 * photo-finish or by the two finish packets landing in the same server tick —
 * and in that case a draw is the honest rating outcome, not a coin flip on
 * packet arrival order.
 */
export const DEAD_HEAT_TOLERANCE_MS = 120;

/**
 * Checkpoint throttle: persist a progress checkpoint only when it advances by
 * at least this many characters (or when the seat finishes).
 *
 * Typing produces far more events than any game should write rows for, so
 * keystrokes NEVER become rows: the socket layer streams them, the server keeps
 * the authoritative position in memory for the duration of the race, and only
 * these throttled checkpoints (plus the one verified finish per seat) reach the
 * database. The throttle lives here so the store and the socket layer agree.
 */
export const PROGRESS_MIN_ADVANCE = 8;

/**
 * How the server ended the race. Written to `resolution_reason` and to the
 * race state's own copy, so a finished match explains itself without a join.
 */
export const RESOLUTION = {
  /** Both seats completed the passage; the earlier verified finish won. */
  FINISH: "finish",
  /** Neither seat finished before the hard limit; the further typist won. */
  DEADLINE: "deadline",
  /** A seat left/disconnected; the opponent won by forfeit. */
  FORFEIT: "forfeit",
  /** The race ended level (photo-finish inside tolerance, or nobody typed). */
  DRAW: "draw",
} as const;

export type ResolutionReason = (typeof RESOLUTION)[keyof typeof RESOLUTION];

/** The reason tokens allowed in the `resolution_reason` column (migration 0191). */
export const RESOLUTION_REASONS: readonly string[] = [
  RESOLUTION.FINISH,
  RESOLUTION.DEADLINE,
  RESOLUTION.FORFEIT,
  RESOLUTION.DRAW,
];
