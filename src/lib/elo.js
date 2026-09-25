// src/lib/elo.js
//
// PURE ELO MATH — no database, no I/O, no imports.
//
// Every rating number that can ever move a player's Elo is produced here so
// the formula lives in exactly one place and is trivially unit-testable
// (`tests/elo-rating.test.mjs`). The server-authoritative caller is
// src/lib/rating.js, which owns the transactional read → compute → write
// flow; this module only answers "given these two ratings and this outcome,
// what are the two new ratings?".
//
// FORMULA (standard Elo, unchanged since Arpad Elo):
//
//   Expected score   E = 1 / (1 + 10^((OpponentRating - PlayerRating) / 400))
//   Rating change    Δ = K × (ActualScore - E)
//
//   ActualScore: win = 1, loss = 0, draw = 0.5
//
// Also exported (never inlined at call sites):
//   * the scale constant (400) and the rating floor used when clamping,
//   * every K-factor and the rule that selects between them.
//
// WHAT IS DELIBERATELY ABSENT
//   Nothing about tokens, winnings, XP, Battle Pass, Prestige, streaks,
//   cosmetics, streaks or membership may influence a rating change. The only
//   inputs are the two ratings, the two games-played counts (which select the
//   K-factor) and the outcome. This keeps Elo a measure of results only.
//
// PROVISIONAL RATINGS (see `kFactorFor` / `provisionalProgress` below)
//   A brand-new rating is anchored at STARTING_RATING, which is only a guess at
//   the player's true skill. Rather than leave them stuck near 1000 for dozens
//   of matches, the first `PROVISIONAL_GAMES` rated matches in a game are
//   "provisional": K steps down through `K_FACTORS.placement` →
//   `K_FACTORS.provisional` → the normal `default`/`high` band, so the rating
//   converges on the player's real level fast and then settles. Provisional
//   status is PER GAME and PER PLAYER — it is derived purely from that
//   player's own rated-games count in that one game, so a Chess provisional
//   window can never be advanced by Precision results.
//
// IMPORTANT: ratings are per-game and independent. A player's Chess rating
// and Precision rating are separate rows with separate arithmetic — nothing
// in this module is aware of any other game.

// ── Configurable constants ────────────────────────────────────────────────
//
// These are the ONLY tunables in the Elo system. Change them here; never
// hardcode a K-factor, a starting rating or a floor anywhere else.

/**
 * Rating every player starts at, per game. A rating row is created lazily
 * the first time a player completes an eligible ranked match in that game
 * (see `applyRatingResult` in src/lib/rating.js) — it is never created at
 * signup, so an unplayed game shows "Unrated" rather than a fake 1000.
 */
export const STARTING_RATING = 1000;

/**
 * Lowest rating a player can fall to. A pure Elo ladder has no floor, so a
 * catastrophic run could push a rating negative and make the ladder
 * meaningless. Clamping keeps the scale readable and bounds the maximum
 * upset a single match can create.
 */
export const RATING_FLOOR = 100;

/** Highest rating reachable by normal play (used only as a sanity clamp). */
export const RATING_CEILING = 3500;

/** The Elo divisor. 400 ⇒ a 400-point gap means the favourite scores 10/11. */
export const ELO_SCALE = 400;

/**
 * K-factor table.
 *
 * CHOICE OF DEFAULT (32) — reasoning:
 *   * Each GRYND game is scored on its OWN ladder, so a player needs roughly
 *     10–20 rated matches to reach a meaningful rating. FIDE uses K=40 for
 *     new players, K=20 once established and K=10 above 2400; Chess.com
 *     uses 40/20/10 on the same shape.
 *   * 32 is the USCF/standard default and the sweet spot for an online
 *     multi-game platform: a win against an equal opponent moves ~16 points
 *     (so ~10 matches to shake out, ~40 matches to stabilise), which is
 *     responsive enough to feel rewarding without letting one lucky match
 *     hand out a tier's worth of rating.
 *   * Because GRYND games are short and high-volume (a Precision duel is
 *     ~60s, a Mines Duel ~90s), a new player's rating is provisional for
 *     their first `PROVISIONAL_GAMES` matches and K decays across that
 *     window: `placement` (very responsive) for the first
 *     `PLACEMENT_GAMES`, then `provisional`, then the established bands.
 *     This is the platform's answer to "a new player must not be anchored
 *     near 1000 until GRYND has enough information about their skill".
 *   * Above 2400 the ladder is populated by the top of the board, so K falls
 *     to 16 to stop the leaderboard jittering.
 */
export const K_FACTORS = Object.freeze({
  /**
   * Rated matches 1–`PLACEMENT_GAMES` in a game ("placement"): the rating is
   * still essentially a guess, so it moves as far as the ladder allows — an
   * equal-opponent win is worth ±32. Deliberately the highest K in the system:
   * it exists to find the player's level in a handful of games, not to be
   * fair to the opponent's rating (whoever loses early loses more, exactly as
   * in chess.com / FIDE provisional play).
   */
  placement: 64,
  /**
   * Rest of the provisional window (matches `PLACEMENT_GAMES`+1 through
   * `PROVISIONAL_GAMES`) — still more responsive than an established player,
   * but closing in: an equal-opponent win is worth ±20.
   */
  provisional: 40,
  /** The default, established-player K-factor. */
  default: 32,
  /** Elites: ratings above `HIGH_RATING_THRESHOLD` move half as fast. */
  high: 16,
});

/**
 * A rating is "provisional" until the player has completed this many rated
 * matches **in that specific game**. Tracked per (player, game) via the
 * `games_rated` counter in `player_ratings` — never globally.
 */
export const PROVISIONAL_GAMES = 10;

/**
 * Of the `PROVISIONAL_GAMES` provisional matches, this many use the fastest
 * `placement` K. `PLACEMENT_GAMES` must be <= `PROVISIONAL_GAMES`.
 */
export const PLACEMENT_GAMES = 3;

/** The provisional stages, in order. */
export const RATING_STAGES = Object.freeze(["placement", "provisional", "established"]);

/** Rating at or above which the low (high-band) K-factor applies. */
export const HIGH_RATING_THRESHOLD = 2400;

/**
 * The default K-factor, surfaced as a named export so callers/tests can
 * reason about "the default" without reaching into the table.
 */
export const DEFAULT_K = K_FACTORS.default;

/** The three valid outcome tokens. Anything else is rejected. */
export const OUTCOMES = Object.freeze(["win", "loss", "draw"]);

// ── Small numeric helpers ──────────────────────────────────────────────────

/** Coerce anything to a finite number, falling back to `fallback`. */
function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Round to a whole rating point (ratings are stored as integers). */
function roundRating(value) {
  return Math.round(value);
}

/** Clamp a rating into the legal band. */
export function clampRating(rating) {
  const n = roundRating(toFiniteNumber(rating, STARTING_RATING));
  return Math.min(RATING_CEILING, Math.max(RATING_FLOOR, n));
}

// ── The formula ────────────────────────────────────────────────────────────

/**
 * Probability that `playerRating` beats `opponentRating`, per the standard
 * Elo expectation. Returns 0.5 for equal ratings, ~1 for a huge favourite,
 * ~0 for a huge underdog, and is always within (0, 1).
 *
 * @param {number} playerRating
 * @param {number} opponentRating
 * @returns {number} expected score in (0, 1)
 */
export function expectedScore(playerRating, opponentRating) {
  const player = toFiniteNumber(playerRating, STARTING_RATING);
  const opponent = toFiniteNumber(opponentRating, STARTING_RATING);
  return 1 / (1 + Math.pow(10, (opponent - player) / ELO_SCALE));
}

/** Actual score for an outcome, from that player's point of view. */
export function actualScore(outcome) {
  if (outcome === "win") return 1;
  if (outcome === "loss") return 0;
  if (outcome === "draw") return 0.5;
  // Unknown outcome — defensive: indistinguishable from a draw, and callers
  // validate before reaching here (see `computeMatchRatings`).
  return 0.5;
}

/** True when the outcome token is one of win/loss/draw. */
export function isValidOutcome(outcome) {
  return OUTCOMES.includes(outcome);
}

/**
 * Which K-factor applies to this player, from their own rating and their
 * own rated-games count in THIS game. (Standard Elo: each player uses their
 * own K, so the two deltas need not sum to exactly zero when one side is
 * provisional and the other is not.)
 *
 * @param {{ rating?: number, gamesRated?: number }} player
 * @returns {number} K
 */
export function kFactorFor({ rating = STARTING_RATING, gamesRated = 0 } = {}) {
  const games = Math.max(0, Math.floor(toFiniteNumber(gamesRated, 0)));
  const value = toFiniteNumber(rating, STARTING_RATING);
  // Provisional band first: a player who has not finished their provisional
  // window in this game is still being placed, regardless of their (possibly
  // already-high) provisional rating.
  if (games < PLACEMENT_GAMES) return K_FACTORS.placement;
  if (games < PROVISIONAL_GAMES) return K_FACTORS.provisional;
  if (value >= HIGH_RATING_THRESHOLD) return K_FACTORS.high;
  return K_FACTORS.default;
}

/**
 * The rating change for one side of a match.
 *
 * @param {object} params
 * @param {number} params.rating            player's current rating
 * @param {number} params.opponentRating    opponent's current rating
 * @param {"win"|"loss"|"draw"} params.outcome  from THIS player's point of view
 * @param {number} [params.gamesRated]      rated games already played in this game
 * @param {number} [params.k]               explicit K override (tests / tuning)
 * @returns {{ expected: number, actual: number, k: number, delta: number }}
 */
export function ratingDelta({
  rating,
  opponentRating,
  outcome,
  gamesRated = 0,
  k,
}) {
  const playerRating = toFiniteNumber(rating, STARTING_RATING);
  const expected = expectedScore(playerRating, opponentRating);
  const actual = actualScore(outcome);
  const kFactor = Number.isFinite(Number(k))
    ? Number(k)
    : kFactorFor({ rating: playerRating, gamesRated });
  return {
    expected,
    actual,
    k: kFactor,
    delta: roundRating(kFactor * (actual - expected)),
  };
}

/**
 * Compute the full result of one two-player ranked match: both players'
 * expected scores, K-factors, deltas and post-match ratings.
 *
 * `result` is `"win"` when `winner` genuinely won, or `"draw"` when the game
 * ended level (both players score 0.5). In a draw there is no winner/loser
 * distinction beyond seating, so pass either player as `winner`.
 *
 * This is the single function the rating writer calls — it never returns
 * anything that could be influenced by tokens, XP, wagers or cosmetics.
 *
 * @param {object} params
 * @param {number} params.winnerRating         winner's (or seat-A's) rating
 * @param {number} params.loserRating          loser's (or seat-B's) rating
 * @param {number} [params.winnerGamesRated]   winner's rated-games count
 * @param {number} [params.loserGamesRated]    loser's rated-games count
 * @param {"win"|"draw"} [params.result]       "win" (default) or "draw"
 * @param {number} [params.k]                  override both K-factors
 * @returns {{
 *   result: "win"|"draw",
 *   winner: { expected: number, actual: number, k: number, delta: number, rating: number, ratingAfter: number },
 *   loser:  { expected: number, actual: number, k: number, delta: number, rating: number, ratingAfter: number },
 * }}
 */
export function computeMatchRatings({
  winnerRating,
  loserRating,
  winnerGamesRated = 0,
  loserGamesRated = 0,
  result = "win",
  k,
}) {
  const outcome = result === "draw" ? "draw" : "win";
  const a = clampRating(winnerRating);
  const b = clampRating(loserRating);

  const winnerOutcome = outcome === "draw" ? "draw" : "win";
  const loserOutcome = outcome === "draw" ? "draw" : "loss";

  const aDelta = ratingDelta({
    rating: a,
    opponentRating: b,
    outcome: winnerOutcome,
    gamesRated: winnerGamesRated,
    k,
  });
  const bDelta = ratingDelta({
    rating: b,
    opponentRating: a,
    outcome: loserOutcome,
    gamesRated: loserGamesRated,
    k,
  });

  return {
    result: outcome,
    winner: {
      ...aDelta,
      rating: a,
      ratingAfter: clampRating(a + aDelta.delta),
    },
    loser: {
      ...bDelta,
      rating: b,
      ratingAfter: clampRating(b + bDelta.delta),
    },
  };
}

/**
 * Read-shape helper for APIs and UI: the true delta the writer applied,
 * derived from the before/after ratings. Never trust a client for this.
 */
export function deltaBetween(before, after) {
  return roundRating(toFiniteNumber(after, 0)) - roundRating(toFiniteNumber(before, 0));
}

/**
 * Which provisional stage a rated-games count is in: "placement" (first
 * `PLACEMENT_GAMES`), "provisional" (rest of the window) or "established".
 * Purely a function of THIS player's own count in THIS game.
 */
export function provisionalStage(gamesRated) {
  const games = Math.max(0, Math.floor(toFiniteNumber(gamesRated, 0)));
  if (games < PLACEMENT_GAMES) return "placement";
  if (games < PROVISIONAL_GAMES) return "provisional";
  return "established";
}

/**
 * Human-facing provisional flag: a rating is provisional until the player
 * has completed `PROVISIONAL_GAMES` rated matches in that game.
 */
export function isProvisional(gamesRated) {
  return provisionalStage(gamesRated) !== "established";
}

/**
 * The read-shape the UI/API uses to answer, for ONE game and ONE player:
 *
 *   * `rating`                       — current Elo for that game
 *   * `provisional`                  — is the player still being placed?
 *   * `provisionalGamesCompleted`    — how many provisional matches are done
 *   * `provisionalGamesRemaining`    — how many are left before established
 *   * `provisionalGamesTotal`        — the window size (PROVISIONAL_GAMES)
 *   * `provisionalProgressPercent`   — 0–100, for a progress bar
 *   * `provisionalStage`             — "placement" | "provisional" | "established"
 *   * `kFactor`                      — the K this player will use NEXT match
 *
 * Everything is derived from the single `games_rated` counter for that
 * (player, game) — nothing here aggregates across games, and nothing is
 * client-supplied.
 *
 * @param {number} gamesRated rated matches completed in this game
 * @param {number} [rating]   current rating (only used to pick the established K)
 */
export function provisionalProgress(gamesRated, rating = STARTING_RATING) {
  const played = Math.max(0, Math.floor(toFiniteNumber(gamesRated, 0)));
  const completed = Math.min(played, PROVISIONAL_GAMES);
  const remaining = Math.max(0, PROVISIONAL_GAMES - played);
  const stage = provisionalStage(played);
  return {
    provisional: stage !== "established",
    provisionalStage: stage,
    provisionalGamesCompleted: completed,
    provisionalGamesRemaining: remaining,
    provisionalGamesTotal: PROVISIONAL_GAMES,
    provisionalProgressPercent: Math.round((completed / PROVISIONAL_GAMES) * 100),
    gamesRated: played,
    kFactor: kFactorFor({ rating, gamesRated: played }),
  };
}

// ── Overall Elo (aggregate display metric) ────────────────────────────────
//
// Overall Elo is an AGGREGATE of a player's already-established per-game
// ratings, never a rating of its own. It has no K-factor, no wins/losses, no
// match results, no adjustments, no provisional window and no history —
// nothing can ever write it. It is derived on read, from the very same
// `player_ratings` rows each game-specific board ranks, so a change to a
// single game's Elo is reflected immediately with no second system.
//
// A game contributes only once its rating is ESTABLISHED, i.e. the player has
// completed the existing provisional requirement (`PROVISIONAL_GAMES` rated
// matches) in that game. A provisional game rating is therefore never counted
// and can never help a player qualify or inflate their overall value. A player
// needs OVERALL_MIN_GAMES different established games to have one at all.

/**
 * How many different games with an established rating a player needs before
 * an Overall Elo exists at all. Based on different GAMES, never on matches:
 * ten Chess matches still count as one game.
 */
export const OVERALL_MIN_GAMES = 3;

/**
 * The Overall Elo for a player, from their per-game rating entries.
 *
 * Each entry is the same read shape the game-specific boards and the profile
 * use (`{ rating, gamesRated, ... }`). Entries whose rating is still inside
 * its provisional window are ignored, so only established games count. The
 * arithmetic mean is returned rounded to the nearest whole number for
 * display; the underlying game ratings are never touched or rounded.
 *
 * @param {Array<{ rating?: number, gamesRated?: number }>} entries
 * @returns {{
 *   overallElo: number|null,
 *   eligibleGames: number,
 *   eligible: boolean,
 * }}
 */
export function overallEloFromRatings(entries) {
  const eligible = (Array.isArray(entries) ? entries : []).filter((entry) => {
    if (!entry) return false;
    const rating = Number(entry.rating);
    if (!Number.isFinite(rating)) return false;
    // Established only — reuse the one provisional definition rather than
    // inventing a second eligibility rule.
    return !isProvisional(entry.gamesRated ?? 0);
  });

  if (eligible.length < OVERALL_MIN_GAMES) {
    return { overallElo: null, eligibleGames: eligible.length, eligible: false };
  }

  const total = eligible.reduce((sum, entry) => sum + Number(entry.rating), 0);
  return {
    overallElo: roundRating(total / eligible.length),
    eligibleGames: eligible.length,
    eligible: true,
  };
}

/**
 * Config snapshot — exposed so tests can assert the tunables without
 * re-deriving them, and so a future admin surface has one object to read.
 */
export const ELO_CONFIG = Object.freeze({
  startingRating: STARTING_RATING,
  ratingFloor: RATING_FLOOR,
  ratingCeiling: RATING_CEILING,
  scale: ELO_SCALE,
  kFactors: K_FACTORS,
  defaultK: DEFAULT_K,
  provisionalGames: PROVISIONAL_GAMES,
  placementGames: PLACEMENT_GAMES,
  overallMinGames: OVERALL_MIN_GAMES,
  stages: RATING_STAGES,
  highRatingThreshold: HIGH_RATING_THRESHOLD,
});
