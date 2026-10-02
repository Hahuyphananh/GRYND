// src/lib/solitaire-duel/constants.ts
//
// The single source of truth for Solitaire Duel. The pure engine, the
// authoritative store and the renderer all import from here, so there is
// exactly one place to change a value.
//
// WHAT THIS GAME IS (the contract everything below serves):
//   * 1v1, simultaneous, both seats race the EXACT SAME deterministic Klondike
//     deal, generated once by the server from one committed seed
//   * the first seat to put all 52 cards on the foundations wins immediately
//   * if neither finishes before the match limit, the seat with the greater
//     progress wins (see the ladder in `./rules.ts`)
//   * NO wagers, NO tokens, NO balances, NO payouts — a purely skill-based duel

/**
 * The canonical game key.
 *
 * ONE key spans every registry the platform has — the rated-game list
 * (`RATED_GAMES`, which `TROPHY_GAMES` reuses), the quick-queue key list, the
 * presence label map, the game-tag catalog, the canonical queue lifecycle
 * mirror and the settlement journals. There is deliberately no second
 * vocabulary anywhere, so nothing here can drift.
 */
export const GAME_KEY = "solitaire-duel" as const;

/** Display name, exactly as the lobby and the rating boards render it. */
export const GAME_DISPLAY_NAME = "Solitaire Duel" as const;

/** `/casino/*` is the app route; `/games/*` is its canonical 308 alias. */
export const GAME_ROUTE = "/casino/solitaire-duel" as const;

/**
 * `pg_advisory_xact_lock` namespace for matchmaking.
 *
 * A per-game namespace is what lets `createOrJoin` take one lock and make
 * "find an open lobby, else open one" atomic, so two concurrent callers can
 * never both see "no open lobby" and each create a row. Taken inside the
 * matchmaking transaction only (xact-scoped), so no lock is ever held across a
 * request. ASCII "SOLI" masked positive, matching every other PvP store.
 */
export const SOLITAIRE_DUEL_LOCK_NAMESPACE = 0x534f4c49 & 0x7fffffff;

/** Seats in a Solitaire Duel match. Strictly 1v1 — there is no other format. */
export const SEAT_COUNT = 2;

// ──────────────────────────────────────────────────────────────────────────
// The variant — ONE frozen ruleset, versioned
// ──────────────────────────────────────────────────────────────────────────

/**
 * The exact ruleset every match is played under.
 *
 * `klondike-1` is Klondike with a single-card draw and UNLIMITED redeals. That
 * choice is deliberate: the primary win condition is "first to solve the whole
 * puzzle wins immediately", and single-card draw has by far the highest
 * completion rate, so the completion path is the normal ending rather than the
 * exception. A three-card draw would make solving far rarer and leave most
 * matches unfinished.
 */
export const VARIANT = "klondike-1" as const;

/**
 * The variant's version, and part of the deal digest.
 *
 * Bumping it changes every deal derived from the same server seed, so old
 * matches stay reproducible and interpretable, and a ruleset change can never
 * silently reinterpret an existing match's stored deal.
 */
export const VARIANT_VERSION = 1;

/** Seven tableau columns; column `i` is dealt `i + 1` cards. */
export const TABLEAU_COLUMNS = 7;

/** A full standard deck. */
export const DECK_SIZE = 52;

/** 1+2+3+4+5+6+7 — every tableau card in the opening deal. */
export const TABLEAU_CARDS = 28;

/** The rest of the deck goes to the stock: 24 cards. */
export const STOCK_SIZE = DECK_SIZE - TABLEAU_CARDS;

/** Rank sentinels. `ACE` opens a foundation, `KING` closes it. */
export const ACE = 1 as const;
export const KING = 13 as const;

export const SUITS = Object.freeze(["spades", "hearts", "diamonds", "clubs"] as const);

/** Hearts and diamonds are red; spades and clubs are black. */
export const RED_SUITS = Object.freeze(["hearts", "diamonds"] as const);

/** Every rank, ascending, so a deck is built by enumeration rather than by hand. */
export const RANKS = Object.freeze([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
] as const);

/** Every move kind the server understands. */
export const MOVE_KINDS = Object.freeze([
  "draw",
  "waste-to-foundation",
  "waste-to-tableau",
  "tableau-to-foundation",
  "tableau-to-tableau",
  "foundation-to-tableau",
] as const);

// ──────────────────────────────────────────────────────────────────────────
// Match lifecycle — the shared house vocabulary
// ──────────────────────────────────────────────────────────────────────────

export const MATCH_STATUS = Object.freeze({
  WAITING: "waiting",
  READY: "ready",
  PLAYING: "playing",
  FINISHED: "finished",
  CANCELLED: "cancelled",
});

/** Terminal statuses — nothing settles or transitions out of these. */
export const TERMINAL_STATUSES: readonly string[] = Object.freeze([
  MATCH_STATUS.FINISHED,
  MATCH_STATUS.CANCELLED,
]);

/** The only terminal outcomes a settled match can carry. */
export const RESULT = Object.freeze({
  PLAYER1: "player1",
  PLAYER2: "player2",
  DRAW: "draw",
});

/** The two valid outcome tokens the shared rating/trophy writers accept. */
export const SETTLEMENT_RESULT = Object.freeze({
  WIN: "win",
  DRAW: "draw",
});

/** The two seats, as the store keys them (player1 is the host). */
export const SEAT = Object.freeze({
  PLAYER1: "player1",
  PLAYER2: "player2",
});

/**
 * Stable internal identity for the free human-vs-AI practice seat.
 *
 * It occupies `player2` of an `is_ai` row exactly as a real joiner would, so
 * every seat-based read (the per-seat board, the move log, the race facts)
 * works unchanged — no token ever authenticates as this id, and the row is
 * excluded from rating/trophies. Mirrors TIC_TAC_TOE_AI_PLAYER_ID and
 * SPEED_TYPING_AI_PLAYER_ID.
 */
export const SOLITAIRE_DUEL_AI_PLAYER_ID = "solitaire_duel_ai_bot";

/** How the server ended the match. Persisted in `resolution_reason`. */
export const RESOLUTION = Object.freeze({
  /** A seat put all 52 cards on the foundations. */
  FINISH: "finish",
  /** A seat left, conceded, disconnected or went inactive. */
  FORFEIT: "forfeit",
  /** The race ended level. */
  DRAW: "draw",
});

/** The reason tokens the server writes to `resolution_reason`. */
export const RESOLUTION_REASONS: readonly string[] = Object.freeze([
  RESOLUTION.FINISH,
  RESOLUTION.FORFEIT,
  RESOLUTION.DRAW,
]);

// ──────────────────────────────────────────────────────────────────────────
// Timers
// ──────────────────────────────────────────────────────────────────────────

/**
 * The synchronized planning window between "both seats are present" and GO.
 *
 * The GO instant is written to the row as an ABSOLUTE server timestamp
 * (`go_at`), not as a delay each client applies locally. Both seats are told
 * the same instant on the same clock, so a slower connection costs nobody
 * anything — the countdown absorbs ordinary network latency before the first
 * legal move. Same principle as Speed Typing's `RACE_COUNTDOWN_MS`.
 *
 * The deal is revealed to both seats at the SAME moment (`playing`), which is
 * when this window opens: no move is accepted before `go_at`, so the window is
 * pure thinking time and both players get an identical slice of it.
 */
export const READY_COUNTDOWN_MS = 3_000;

/**
 * Inactivity alarm: with no accepted move from a seat for this long, that
 * seat's match view raises the "play now or you forfeit" alarm.
 *
 * Measured against the seat's OWN last accepted move (or GO when it has not
 * moved yet), so one player cannot alarm the other. Fifteen minutes.
 */
export const INACTIVITY_ALARM_MS = 900_000;

/**
 * Inactivity forfeit: with no accepted move for this long, the seat forfeits
 * and the opponent wins, with the standard settlement.
 *
 * The match is UNTIMED apart from this — there is no match clock, so a match
 * only ends by a completion, a concession, a long disconnect, or this
 * inactivity rule. Twenty minutes.
 */
export const INACTIVITY_FORFEIT_MS = 1_200_000;

/**
 * When the match clock switches from the UP-counting stopwatch to the forfeit
 * countdown: the last five minutes before the inactivity forfeit.
 *
 * The match is untimed, so the honest readout for almost all of it is elapsed
 * time counting UP; only in the final stretch does the time LEFT matter enough
 * to count down. This equals `INACTIVITY_FORFEIT_MS - INACTIVITY_ALARM_MS`.
 */
export const INACTIVITY_COUNTDOWN_MS = 300_000;

/**
 * Two completions closer together than this are a dead heat.
 *
 * This is only reachable on the reconciliation path: the FIRST verified
 * completion ends the match immediately, so in the normal flow the second seat
 * has no completion to report. It exists so that a replayed or back-filled pair
 * of completions still resolves deterministically instead of by arrival order.
 */
export const COMPLETION_DEAD_HEAT_MS = 200;

/**
 * The maximum accepted moves for one seat.
 *
 * A Klondike game is well under 500 moves even played wastefully with unlimited
 * redeals, so this is unreachable in honest play; it exists so a scripted client
 * cannot turn one match into unbounded row writes. The cap is per seat, so one
 * player's spam can never truncate the other's game.
 */
export const MAX_MOVES_PER_SEAT = 1_500;

/**
 * Minimum spacing between opponent-progress emissions (ms).
 *
 * Progress is broadcast when the primary metric changes, so this only coalesces
 * bursts — a foundation run landing several cards in a row. A client that misses
 * an emission is never left stale: every snapshot carries the authoritative
 * numbers and the match view re-derives from it.
 */
export const PROGRESS_BROADCAST_MIN_MS = 1_000;
