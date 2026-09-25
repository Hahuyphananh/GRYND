// src/lib/rating.js
//
// SERVER-AUTHORITATIVE ELO — one independent rating per game, per player.
//
// This is the ONLY module allowed to read or write `player_ratings` /
// `rating_events`. It is modelled directly on the Prestige hook
// (src/lib/prestige.js), which is the platform's existing pattern for
// "an authoritative match result happened — apply progression exactly once":
//
//   * Each game settles inside a row-locked transaction.
//   * That transaction calls `applyRatingResult` with BOTH competitors, the
//     authoritative match id, and the outcome.
//   * The (user_id, game_key, match_id) unique journal makes a duplicate,
//     replayed or concurrent settlement a guaranteed no-op.
//
// RATINGS ARE PER-GAME AND INDEPENDENT. A player's Chess rating lives in its
// own row and is only ever read/written by Chess settlements. The only
// cross-game value here is Overall Elo — an AGGREGATE (mean of a player's
// established ratings) computed on read, never stored and never written, so
// it is not a rating and cannot move an individual game's Elo.
//
// WHAT NEVER ENTERS THE CALCULATION (by construction — see src/lib/elo.js):
// token balance, winnings/payout, wagered amount, XP, Battle Pass level,
// Prestige, streaks, quests, cosmetics, membership. The only inputs are the
// two current ratings, the two rated-games counts, and the outcome.
//
// WHAT THE CLIENT CAN NEVER DO:
//   * submit a rating (there is no write path that accepts one),
//   * submit a rating delta,
//   * submit a match outcome (every caller derives it server-side),
//   * rate an AI / free-play / fun-mode match (callers guard before calling),
//   * reset provisional status by deleting and recreating an account (see the
//     identity ledger below).
//
// PROVISIONAL STATUS (see src/lib/elo.js)
//   A rating is *provisional* for the player's first PROVISIONAL_GAMES rated
//   matches IN THAT GAME, during which the K-factor is larger so the rating
//   converges on their real level quickly. It is derived from that player's own
//   `games_rated` counter in that one game — per game, never combined — and the
//   read shapes below expose `provisional`, `provisionalGamesCompleted`,
//   `provisionalGamesRemaining` and a progress percentage for the UI.
//
// ANTI-RESET (rating_identities)
//   `player_ratings` cascades away with the `users` row, so deleting an account
//   would otherwise hand back a fresh 1000 rating and a fresh provisional
//   window. Every settlement therefore also mirrors progress into
//   `rating_identities`, keyed by `identityHashForEmail` (a hash of the
//   account's normalized email — the durable anchor the account system already
//   enforces uniqueness on) with NO foreign key to `users`. A re-registered
//   account restores its rating and provisional progress instead of resetting.

import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  STARTING_RATING,
  OVERALL_MIN_GAMES,
  PROVISIONAL_GAMES,
  computeMatchRatings,
  isValidOutcome,
  overallEloFromRatings,
  provisionalProgress,
} from "./elo";

// ── Game registry ─────────────────────────────────────────────────────────
//
// Only 1v1 games with a SERVER-DERIVED winner are rated. The keys are
// deliberately identical to the Prestige `source` keys each settlement
// already passes, so one vocabulary covers both systems and the two
// journals line up row-for-row.
//
// DELIBERATELY EXCLUDED (see docs / audit §7):
//   * hex-duel            — /api/hex-duel/multiplayer/end accepts a
//                           client-supplied `winner`; unratable until that
//                           route derives the winner server-side.
//   * tower-arena, uno    — 3–6 / 2–4 player tables (no binary verdict).
//   * poker, crash-arena  — running bankroll / per-hand economy, no
//                           discrete match verdict.
//   * roulette-pvp        — elimination with per-round draws; no
//                           match-level win/loss/draw verdict.
//   * every solo/AI mode  — not competitive.
export const RATED_GAMES = Object.freeze([
  "chess",
  "four-in-a-row",
  "dots-and-boxes",
  "pool",
  "memory-grid",
  "precision",
  "mines-pvp",
  "keno-pvp",
  "plinko-pvp",
  "lane-rush-duel",
  "blackjack-pvp",
  "dice-flush",
  "rps-pvp",
  "odds-pvp",
]);

/** Display labels for the rating boards (mirrors the lobby names). */
export const RATING_GAME_LABELS = Object.freeze({
  chess: "Chess",
  "four-in-a-row": "Four In A Row",
  "dots-and-boxes": "Dots & Boxes",
  pool: "Pool Masters",
  "memory-grid": "Memory Grid",
  precision: "Precision",
  "mines-pvp": "Mines Duel",
  "keno-pvp": "Keno Duel",
  "plinko-pvp": "Plinko Duel",
  "lane-rush-duel": "Lane Rush Duel",
  "blackjack-pvp": "Blackjack",
  "dice-flush": "Dice Flush",
  "rps-pvp": "Rock Paper Scissors",
  "odds-pvp": "Odds",
});

/** True when a game key is eligible for Elo. */
export function isRatedGame(gameKey) {
  return RATED_GAMES.includes(String(gameKey ?? ""));
}

/** Coerce a ?game= value to a rated game key (defaults to the first). */
export function normalizeRatingGameKey(value) {
  return isRatedGame(value) ? String(value) : RATED_GAMES[0];
}

/** Display label for a rated game key. */
export function getRatingGameLabel(gameKey) {
  return RATING_GAME_LABELS[gameKey] ?? "Game";
}

/** Title of the aggregate cross-game board (never a per-game label). */
export const OVERALL_ELO_LABEL = "Overall Elo";

// ── Rating identity (the anti-reset anchor) ───────────────────────────────

/**
 * Domain separation for the identity digest, so this hash can never collide
 * with any other use of sha256 elsewhere in the platform.
 */
const IDENTITY_HASH_NAMESPACE = "grynd:rating-identity:";

/**
 * Normalize an email into the canonical form used for identity lookups.
 * Returns null when there is nothing usable — the caller then simply has no
 * anti-reset anchor (the match still rates normally).
 */
export function normalizeRatingIdentity(email) {
  const value = String(email ?? "").trim().toLowerCase();
  return value || null;
}

/**
 * The stable identity key for an account, derived from its email address.
 * Deterministic (the same address always produces the same key), and never
 * reversible into the address by a plain lookup — the ledger stores only this
 * digest, never the email itself.
 *
 * @param {string} email
 * @returns {string|null} 64-char sha256 hex, or null when unusable
 */
export function identityHashForEmail(email) {
  const normalized = normalizeRatingIdentity(email);
  if (!normalized) return null;
  return crypto
    .createHash("sha256")
    .update(IDENTITY_HASH_NAMESPACE + normalized)
    .digest("hex");
}

/** The journal/game-key shape guard (mirrors prestige's SOURCE_REGEX). */
const GAME_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Max length of a match id we will journal. */
const MAX_MATCH_ID_LENGTH = 128;

let _sql = null;
function getSql() {
  if (_sql) return _sql;
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Set it in your runtime environment (for example, Vercel Project Settings > Environment Variables).",
    );
  }
  _sql = db;
  return _sql;
}

// ── Read shapes ───────────────────────────────────────────────────────────

/**
 * The one read shape every rating surface uses. `gameKey` is always the
 * game the row belongs to, and the provisional fields come from that game's
 * own `gamesRated` — the UI never has to combine games or do arithmetic.
 *
 * @param {string} gameKey
 * @param {object} row raw row (snake_case or camelCase aliases both accepted)
 */
export function toRatingShape(gameKey, row) {
  const rating = Number(row.rating);
  const gamesRated = Number(row.gamesRated ?? row.games_rated ?? 0);
  const wins = Number(row.wins ?? 0);
  const losses = Number(row.losses ?? 0);
  const draws = Number(row.draws ?? 0);
  const decided = wins + losses;
  return {
    gameKey: String(gameKey),
    // Display label resolved server-side from RATING_GAME_LABELS, so the UI
    // never keeps its own copy of the game list that could drift.
    label: getRatingGameLabel(String(gameKey)),
    rating,
    peakRating: Number(row.peakRating ?? row.peak_rating ?? rating),
    gamesRated,
    wins,
    losses,
    draws,
    // The non-token record line for this game only. (`games` is the decided
    // count — wins + losses — not `gamesRated`, which also counts draws. The
    // board row additionally carries snake_case `win_rate`/`games` straight
    // from SQL because the shared RecordLine component reads those spellings.)
    winRate:
      decided > 0 ? Math.round((wins / decided) * 10000) / 100 : 0,
    games: decided,
    lastDelta: Number(row.lastDelta ?? row.last_delta ?? 0),
    lastRatedAt: row.lastRatedAt ?? row.last_rated_at ?? null,
    // provisional, provisionalStage, provisionalGamesCompleted,
    // provisionalGamesRemaining, provisionalGamesTotal,
    // provisionalProgressPercent, kFactor — derived in src/lib/elo.js.
    ...provisionalProgress(gamesRated, rating),
  };
}

/**
 * Read one player's rating for one game. Returns null when the player has
 * never completed a rated match in that game — an unrated player is NOT
 * given a fake 1000 rating (the row is created on first rated match).
 */
export async function getRatingForUser({ clerkId, gameKey }) {
  if (!clerkId || !isRatedGame(gameKey)) return null;
  const rows = await getSql().execute(sql`
    SELECT r.rating, r.peak_rating AS "peakRating", r.games_rated AS "gamesRated",
           r.wins, r.losses, r.draws, r.last_delta AS "lastDelta",
           r.last_rated_at AS "lastRatedAt"
      FROM player_ratings r
      INNER JOIN users u ON u.id = r.user_id
     WHERE u.clerk_id = ${clerkId}
       AND r.game_key = ${String(gameKey)}
     LIMIT 1
  `);
  const row = rows.rows?.[0] ?? rows[0];
  if (!row) return null;
  return toRatingShape(gameKey, row);
}

/**
 * Every rating a player owns, keyed by game. Missing games are simply
 * absent — the UI renders "Unrated" for them. Never creates rows.
 */
export async function getRatingsForUser(clerkId) {
  if (!clerkId) return {};
  const rows = await getSql().execute(sql`
    SELECT r.game_key AS "gameKey", r.rating, r.peak_rating AS "peakRating",
           r.games_rated AS "gamesRated", r.wins, r.losses, r.draws,
           r.last_delta AS "lastDelta", r.last_rated_at AS "lastRatedAt"
      FROM player_ratings r
      INNER JOIN users u ON u.id = r.user_id
     WHERE u.clerk_id = ${clerkId}
  `);
  const out = {};
  for (const row of rows.rows ?? rows) {
    const key = String(row.gameKey);
    out[key] = toRatingShape(key, row);
  }
  return out;
}

/**
 * Ranked board for one game: every rated player, highest rating first.
 * Ties break on fewer losses, then the older account id (deterministic).
 * Same `{ items, me }` contract as the win/loss leaderboards so the UI can
 * reuse its row rendering.
 */
export async function fetchRatingLeaderboard({
  gameKey = RATED_GAMES[0],
  limit = 50,
  offset = 0,
  clerkId = null,
} = {}) {
  if (!isRatedGame(gameKey)) return { items: [], me: null };
  const lim = Math.min(100, Math.max(1, Number(limit) || 20));
  const off = Math.max(0, Number(offset) || 0);

  const rows = await getSql().execute(sql`
    WITH ranked AS (
      SELECT
        ROW_NUMBER() OVER (
          ORDER BY r.rating DESC, r.losses ASC, u.id ASC
        )::int AS rank,
        u.clerk_id AS clerk_id,
        u.name AS name,
        u.selected_icon AS icon_key,
        r.rating,
        r.peak_rating AS peak_rating,
        r.games_rated AS games_rated,
        r.wins,
        r.losses,
        r.draws,
        r.last_delta AS last_delta,
        r.last_rated_at AS last_rated_at,
        -- Non-token W/L line for the board row (the leaderboard UI renders
        -- the same record line as every other board).
        CASE
          WHEN (r.wins + r.losses) > 0
            THEN ROUND((r.wins::numeric / (r.wins + r.losses)) * 100, 2)
          ELSE 0
        END AS win_rate,
        (r.wins + r.losses) AS games,
        -- The Overall Elo badge — an independent cross-game aggregate, not a
        -- merge of game ratings into this ranking. Absent until the player
        -- has enough different established games, so the badge auto-hides.
        o2.overall_elo AS overall_elo,
        COALESCE(o2.overall_games, 0) AS overall_games,
        json_build_object('name', u.name, 'icon_key', u.selected_icon) AS "user"
      FROM player_ratings r
      INNER JOIN users u ON u.id = r.user_id
      LEFT JOIN (
        SELECT r2.user_id,
               ROUND(AVG(r2.rating))::int AS overall_elo,
               COUNT(*)::int AS overall_games
        FROM player_ratings r2
        WHERE r2.games_rated >= ${PROVISIONAL_GAMES}
        GROUP BY r2.user_id
        HAVING COUNT(*) >= ${OVERALL_MIN_GAMES}
      ) o2 ON o2.user_id = r.user_id
      WHERE r.game_key = ${String(gameKey)}
    ),
    paged AS (
      SELECT * FROM ranked ORDER BY rank ASC LIMIT ${lim} OFFSET ${off}
    )
    SELECT
      COALESCE(json_agg(paged ORDER BY rank ASC), '[]'::json) AS items,
      (SELECT row_to_json(ranked) FROM ranked WHERE clerk_id = ${clerkId} LIMIT 1) AS me
    FROM paged
  `);

  const row = rows.rows?.[0] ?? rows[0] ?? {};
  const items = Array.isArray(row.items) ? row.items : [];
  const me = row.me ?? null;
  // Same shape as a profile rating, so a board row and a profile row render
  // with the same component (including the provisional badge/progress). The
  // raw Overall badge columns are normalized to camelCase and dropped when
  // absent, so a client never sees the internal SQL aliases.
  const shape = (item) => {
    const { overall_elo, overall_games, ...rest } = item;
    const elo = Number(overall_elo);
    return {
      ...rest,
      ...toRatingShape(gameKey, item),
      ...(Number.isFinite(elo) && elo > 0
        ? { overallElo: elo, overallGames: Number(overall_games) || 0 }
        : {}),
    };
  };
  return {
    items: items.map(shape),
    me: me ? shape(me) : null,
  };
}

// ── Overall Elo (aggregate read-only metric) ─────────────────────────────
//
// Overall Elo is NOT a rating. It has no row, no K-factor, no results and no
// writer — `applyRatingResult` never touches it and there is no route that
// accepts one. It is computed on read from the player's own established
// game-specific ratings (see `overallEloFromRatings` in src/lib/elo.js), so
// editing a single game's Elo changes the aggregate automatically.

/**
 * Overall Elo from an already-loaded `gameKey → rating` map (the shape
 * `getRatingsForUser` returns). Lets the profile APIs compute the aggregate
 * from the ratings they already fetched instead of issuing a second query.
 */
export function overallEloFromRatingsMap(ratings) {
  return overallEloFromRatings(Object.values(ratings || {}));
}

/**
 * Read one player's Overall Elo. Returns `{ overallElo: null, eligible: false }`
 * until they have an established rating in at least `OVERALL_MIN_GAMES`
 * different games — a provisional game rating never counts.
 */
export async function getOverallEloForUser(clerkId) {
  return overallEloFromRatingsMap(await getRatingsForUser(clerkId));
}

/**
 * The movement of a player's Overall Elo across their MOST RECENT rated match
 * — derived entirely on read, never stored.
 *
 * Overall Elo has no history of its own (it is not a rating), so the "before"
 * value is reconstructed from the one existing record of the last rated
 * match: the `rating_events` journal row already written by
 * `applyRatingResult`. That row holds the game's authoritative `rating_before`
 * and `rating_after`, so rolling the just-rated game back by one match (and
 * one rated game) yields the pre-match set of ratings; the current set yields
 * the post-match value. Both are aggregated with the same eligibility rule, so
 * a match that flips a player into qualification shows the change correctly.
 *
 * This is a DISPLAY helper only: it cannot write anything, cannot move a
 * rating, and is never fed back into the calculation. Because it derives from
 * the journal, the result screen can show a real before → after without a
 * dedicated overall column (which would give Overall Elo a rating history its
 * design deliberately avoids).
 *
 * @returns {Promise<null | {
 *   overallElo: number|null,
 *   previousOverallElo: number|null,
 *   overallDelta: number|null,
 *   eligibleGames: number,
 *   previousEligibleGames: number,
 *   eligible: boolean,
 *   previousEligible: boolean,
 *   gameKey: string,
 *   outcome: "win"|"loss"|"draw",
 *   at: string|null,
 * }>}
 */
export async function getOverallEloMovementForUser(clerkId, preloadedRatings = null) {
  if (!clerkId) return null;

  // Callers that already fetched the ratings map pass it in, so the profile
  // APIs don't pay for a second read of the same rows.
  const ratings = preloadedRatings || (await getRatingsForUser(clerkId));
  const current = overallEloFromRatingsMap(ratings);

  const rows = await getSql().execute(sql`
    SELECT e.game_key AS "gameKey", e.rating_before AS "ratingBefore",
           e.rating_after AS "ratingAfter", e.delta, e.outcome,
           e.created_at AS "createdAt"
      FROM rating_events e
      INNER JOIN users u ON u.id = e.user_id
     WHERE u.clerk_id = ${clerkId}
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT 1
  `);
  const event = rows.rows?.[0] ?? rows[0];
  if (!event) return null;

  const gameKey = String(event.gameKey);
  // Pre-match ratings: the player's current map, with the just-rated game
  // rolled back to the journal's authoritative `rating_before` and one fewer
  // rated match. Every other game is untouched.
  const previousRatings = { ...ratings };
  const currentEntry = previousRatings[gameKey];
  previousRatings[gameKey] = {
    ...(currentEntry || { gameKey }),
    rating: Number(event.ratingBefore),
    gamesRated: Math.max(0, Number(currentEntry?.gamesRated ?? 1) - 1),
  };
  const previous = overallEloFromRatingsMap(previousRatings);

  const overallDelta =
    current.overallElo != null && previous.overallElo != null
      ? current.overallElo - previous.overallElo
      : null;

  return {
    overallElo: current.overallElo,
    previousOverallElo: previous.overallElo,
    overallDelta,
    eligibleGames: current.eligibleGames,
    previousEligibleGames: previous.eligibleGames,
    eligible: current.eligible,
    previousEligible: previous.eligible,
    gameKey,
    outcome: String(event.outcome),
    at: event.createdAt ?? null,
  };
}

/**
 * The cross-game OVERALL ELO board.
 *
 * Ranks players by the arithmetic mean of their ESTABLISHED game ratings
 * (`games_rated >= PROVISIONAL_GAMES`) and only returns players with at least
 * `OVERALL_MIN_GAMES` such games. It is a pure aggregate of the same
 * `player_ratings` rows the per-game boards read — nothing is stored, so a
 * game rating change is reflected on the next read. No token/winnings column
 * is selected or returned anywhere.
 *
 * Shape mirrors `fetchRatingLeaderboard` (`{ items, me }`) so the UI reuses
 * its row rendering; rows additionally carry `overallElo` and `eligibleGames`.
 *
 * @param {object} [params]
 * @param {number} [params.limit]
 * @param {number} [params.offset]
 * @param {string|null} [params.clerkId]  resolve `me` (rank even off-page)
 */
export async function fetchOverallEloLeaderboard({
  limit = 50,
  offset = 0,
  clerkId = null,
} = {}) {
  const lim = Math.min(100, Math.max(1, Number(limit) || 20));
  const off = Math.max(0, Number(offset) || 0);

  const rows = await getSql().execute(sql`
    WITH eligible AS (
      SELECT
        r.user_id,
        AVG(r.rating)::numeric AS overall_rating,
        COUNT(*)::int AS eligible_games
      FROM player_ratings r
      WHERE r.games_rated >= ${PROVISIONAL_GAMES}
      GROUP BY r.user_id
      HAVING COUNT(*) >= ${OVERALL_MIN_GAMES}
    ),
    ranked AS (
      SELECT
        ROW_NUMBER() OVER (
          ORDER BY e.overall_rating DESC, u.id ASC
        )::int AS rank,
        u.clerk_id AS clerk_id,
        u.name AS name,
        u.selected_icon AS icon_key,
        ROUND(e.overall_rating)::int AS overall_elo,
        e.eligible_games AS eligible_games,
        json_build_object('name', u.name, 'icon_key', u.selected_icon) AS "user"
      FROM eligible e
      INNER JOIN users u ON u.id = e.user_id
    ),
    paged AS (
      SELECT * FROM ranked ORDER BY rank ASC LIMIT ${lim} OFFSET ${off}
    )
    SELECT
      COALESCE(json_agg(paged ORDER BY rank ASC), '[]'::json) AS items,
      (SELECT row_to_json(ranked) FROM ranked WHERE clerk_id = ${clerkId} LIMIT 1) AS me
    FROM paged
  `);

  const row = rows.rows?.[0] ?? rows[0] ?? {};
  const items = Array.isArray(row.items) ? row.items : [];
  return {
    items: items.map(toOverallShape),
    me: row.me ? toOverallShape(row.me) : null,
  };
}

/**
 * Normalize an Overall board row for the UI. `overallElo`/`eligibleGames`
 * are server-computed; the client can never supply them.
 */
export function toOverallShape(row) {
  return {
    ...row,
    label: OVERALL_ELO_LABEL,
    overallElo: Number(row.overallElo ?? row.overall_elo ?? 0),
    eligibleGames: Number(row.eligibleGames ?? row.eligible_games ?? 0),
  };
}

// ── The authoritative writer ──────────────────────────────────────────────

/**
 * Apply one authoritative ranked result to both players' game-specific Elo.
 *
 * The caller MUST already have determined the winner server-side from match
 * state — this function never inspects or trusts a client for the outcome,
 * and it re-validates every argument before touching a row.
 *
 * Flow (all inside one transaction — the caller's when supplied):
 *   1. validate the game key, match id, participants and outcome,
 *   2. resolve both `users.id`s from the Clerk ids,
 *   3. lock/create both `player_ratings` rows in ascending user-id order
 *      (deterministic lock order ⇒ no deadlock between two match results
 *      that involve the same pair in opposite order),
 *   4. bail out if this match already rated either player (journal check),
 *   5. compute both deltas with the pure Elo math,
 *   6. update both ratings,
 *   6b. mirror the new progress into the anti-reset identity ledger,
 *   7. journal both events.
 *
 * The returned winner/loser objects also carry the post-match provisional
 * state (see `provisionalProgress` in src/lib/elo.js) so a result screen can
 * say "placement match 4 of 10" without a second round-trip.
 *
 * @param {object} params
 * @param {string} params.gameKey       rated game key (see RATED_GAMES)
 * @param {string} params.matchId       authoritative id in the game's own table
 * @param {string} params.winnerClerkId Clerk id of the winning (or seat-A) player
 * @param {string} params.loserClerkId  Clerk id of the losing (or seat-B) player
 * @param {"win"|"draw"} [params.result] "win" (default) or "draw"
 * @param {any} [params.tx]             the caller's settlement transaction
 * @param {number} [params.k]           K override (tests / tuning only)
 *
 * @returns {Promise<{
 *   applied: boolean,
 *   reason?: string,
 *   result?: "win"|"draw",
 *   winner?: object,
 *   loser?: object,
 * }>}
 * Never throws for expected inputs — callers run it as a best-effort side
 * effect of settlement, exactly like applyPrestigeResult.
 */
export async function applyRatingResult({
  tx,
  gameKey,
  matchId,
  winnerClerkId,
  loserClerkId,
  result = "win",
  k,
}) {
  const key = String(gameKey ?? "");
  const eventId = String(matchId ?? "");
  const outcome = result === "draw" ? "draw" : "win";

  // ── 1. Validate ────────────────────────────────────────────────────
  if (!isRatedGame(key)) return { applied: false, reason: "game-not-rated" };
  if (!GAME_KEY_RE.test(key)) return { applied: false, reason: "invalid-game-key" };
  if (!eventId || eventId.length > MAX_MATCH_ID_LENGTH) {
    return { applied: false, reason: "invalid-match-id" };
  }
  if (!winnerClerkId || !loserClerkId) {
    return { applied: false, reason: "missing-player" };
  }
  if (String(winnerClerkId) === String(loserClerkId)) {
    return { applied: false, reason: "same-player" };
  }
  if (!isValidOutcome(outcome)) return { applied: false, reason: "invalid-outcome" };

  const run = async (txc) => {
    // ── 2. Resolve both app users ────────────────────────────────────
    // `email` is read ONLY to derive the anti-reset identity key below; it is
    // never stored on a rating row and never leaves this function.
    const userRows = await txc.execute(sql`
      SELECT id, clerk_id AS "clerkId", email
        FROM users
       WHERE clerk_id IN (${String(winnerClerkId)}, ${String(loserClerkId)})
    `);
    const users = userRows.rows ?? userRows;
    if (users.length !== 2) return { applied: false, reason: "user-not-found" };

    const winnerRow = users.find((u) => String(u.clerkId) === String(winnerClerkId));
    const loserRow = users.find((u) => String(u.clerkId) === String(loserClerkId));
    if (!winnerRow || !loserRow) return { applied: false, reason: "user-not-found" };

    // ── 3. Lock both rating rows in ASCENDING user-id order ──────────
    // (locking in a fixed order is what stops two settlements involving the
    // same pair from deadlocking on each other.)
    const ordered = [winnerRow, loserRow].sort((a, b) => Number(a.id) - Number(b.id));

    const winnerIdentity = identityHashForEmail(winnerRow.email);
    const loserIdentity = identityHashForEmail(loserRow.email);
    const identityFor = (user) =>
      Number(user.id) === Number(winnerRow.id) ? winnerIdentity : loserIdentity;

    let winnerRatingRow = null;
    let loserRatingRow = null;

    for (const user of ordered) {
      // The INSERT creates the rating on first rated match; the no-op DO
      // UPDATE makes the statement return — and lock — the existing row.
      //
      // On creation the values are seeded from the identity ledger when this
      // email has rated this game before (a re-registered account), so the
      // rating and the provisional window carry over instead of resetting to
      // 1000 / 0. A null identity hash simply joins nothing, leaving the
      // documented defaults.
      const locked = await txc.execute(sql`
        INSERT INTO player_ratings
          (user_id, game_key, rating, peak_rating, games_rated,
           wins, losses, draws, last_delta, last_rated_at)
        SELECT
          ${user.id}, ${key},
          COALESCE(i.rating, ${STARTING_RATING}),
          COALESCE(i.peak_rating, ${STARTING_RATING}),
          COALESCE(i.games_rated, 0),
          COALESCE(i.wins, 0),
          COALESCE(i.losses, 0),
          COALESCE(i.draws, 0),
          COALESCE(i.last_delta, 0),
          i.last_rated_at
          FROM (SELECT 1) AS anchor
          LEFT JOIN rating_identities i
            ON i.identity_hash = ${identityFor(user)}
           AND i.game_key = ${key}
        ON CONFLICT (user_id, game_key)
        DO UPDATE SET updated_at = player_ratings.updated_at
        RETURNING user_id, rating, games_rated, wins, losses, draws
      `);
      const ratingRow = (locked.rows ?? locked)[0];
      if (!ratingRow) return { applied: false, reason: "rating-lock-failed" };
      if (Number(user.id) === Number(winnerRow.id)) winnerRatingRow = ratingRow;
      else loserRatingRow = ratingRow;
    }

    if (!winnerRatingRow || !loserRatingRow) {
      return { applied: false, reason: "rating-lock-failed" };
    }

    // ── 4. Duplicate guard (inside the lock) ─────────────────────────
    // Both player_ratings rows are locked, so a concurrent settlement of
    // this same match is serialized behind us and will see the journal row
    // written below.
    const dupe = await txc.execute(sql`
      SELECT 1 AS hit
        FROM rating_events
       WHERE game_key = ${key}
         AND match_id = ${eventId}
         AND user_id IN (${winnerRow.id}, ${loserRow.id})
       LIMIT 1
    `);
    if ((dupe.rows ?? dupe).length > 0) {
      return { applied: false, reason: "duplicate" };
    }

    // ── 5. Pure Elo math ─────────────────────────────────────────────
    const computed = computeMatchRatings({
      winnerRating: Number(winnerRatingRow.rating),
      loserRating: Number(loserRatingRow.rating),
      winnerGamesRated: Number(winnerRatingRow.games_rated ?? 0),
      loserGamesRated: Number(loserRatingRow.games_rated ?? 0),
      result: outcome,
      k,
    });

    const isDraw = outcome === "draw";

    // ── 6. Update both ratings ───────────────────────────────────────
    await txc.execute(sql`
      UPDATE player_ratings
         SET rating = ${computed.winner.ratingAfter},
             peak_rating = GREATEST(peak_rating, ${computed.winner.ratingAfter}),
             games_rated = games_rated + 1,
             wins = wins + ${isDraw ? 0 : 1},
             draws = draws + ${isDraw ? 1 : 0},
             last_delta = ${computed.winner.delta},
             last_rated_at = NOW(),
             updated_at = NOW()
       WHERE user_id = ${winnerRow.id} AND game_key = ${key}
    `);
    await txc.execute(sql`
      UPDATE player_ratings
         SET rating = ${computed.loser.ratingAfter},
             peak_rating = GREATEST(peak_rating, ${computed.loser.ratingAfter}),
             games_rated = games_rated + 1,
             losses = losses + ${isDraw ? 0 : 1},
             draws = draws + ${isDraw ? 1 : 0},
             last_delta = ${computed.loser.delta},
             last_rated_at = NOW(),
             updated_at = NOW()
       WHERE user_id = ${loserRow.id} AND game_key = ${key}
    `);

    // ── 6b. Mirror the new progress into the identity ledger ─────────
    // Keyed by the EMAIL identity, not the user row, so it survives account
    // deletion and a re-registered account restores (rather than resets) its
    // rating and provisional window. It reads back the row we just updated,
    // so `player_ratings` stays the single source of truth.
    for (const user of [winnerRow, loserRow]) {
      const identityHash = identityFor(user);
      if (!identityHash) continue;
      await txc.execute(sql`
        INSERT INTO rating_identities
          (identity_hash, game_key, rating, peak_rating, games_rated,
           wins, losses, draws, last_delta, last_rated_at, updated_at)
        SELECT
          ${identityHash}, r.game_key, r.rating, r.peak_rating, r.games_rated,
          r.wins, r.losses, r.draws, r.last_delta, r.last_rated_at, NOW()
          FROM player_ratings r
         WHERE r.user_id = ${user.id}
           AND r.game_key = ${key}
        ON CONFLICT (identity_hash, game_key) DO UPDATE SET
          rating = EXCLUDED.rating,
          peak_rating = GREATEST(rating_identities.peak_rating, EXCLUDED.peak_rating),
          games_rated = EXCLUDED.games_rated,
          wins = EXCLUDED.wins,
          losses = EXCLUDED.losses,
          draws = EXCLUDED.draws,
          last_delta = EXCLUDED.last_delta,
          last_rated_at = EXCLUDED.last_rated_at,
          updated_at = NOW()
      `);
    }

    // ── 7. Journal both events (idempotency + match history) ─────────
    // rating_events doubles as the per-match rating history: it records the
    // opponent, both ratings, the delta and the K actually used, for both
    // sides of the match.
    await txc.execute(sql`
      INSERT INTO rating_events
        (user_id, game_key, match_id, opponent_id, outcome,
         rating_before, rating_after, delta, k_factor)
      VALUES
        (${winnerRow.id}, ${key}, ${eventId}, ${loserRow.id},
         ${isDraw ? "draw" : "win"}, ${computed.winner.rating},
         ${computed.winner.ratingAfter}, ${computed.winner.delta},
         ${computed.winner.k}),
        (${loserRow.id}, ${key}, ${eventId}, ${winnerRow.id},
         ${isDraw ? "draw" : "loss"}, ${computed.loser.rating},
         ${computed.loser.ratingAfter}, ${computed.loser.delta},
         ${computed.loser.k})
      ON CONFLICT (user_id, game_key, match_id) DO NOTHING
    `);

    // Post-match provisional status for the result screens, derived from the
    // same per-game counter the next settlement will read.
    const winnerAfter = provisionalProgress(
      Number(winnerRatingRow.games_rated ?? 0) + 1,
      computed.winner.ratingAfter,
    );
    const loserAfter = provisionalProgress(
      Number(loserRatingRow.games_rated ?? 0) + 1,
      computed.loser.ratingAfter,
    );

    return {
      applied: true,
      result: outcome,
      gameKey: key,
      matchId: eventId,
      winner: {
        userId: winnerRow.id,
        ratingBefore: computed.winner.rating,
        ratingAfter: computed.winner.ratingAfter,
        delta: computed.winner.delta,
        k: computed.winner.k,
        expected: computed.winner.expected,
        ...winnerAfter,
      },
      loser: {
        userId: loserRow.id,
        ratingBefore: computed.loser.rating,
        ratingAfter: computed.loser.ratingAfter,
        delta: computed.loser.delta,
        k: computed.loser.k,
        expected: computed.loser.expected,
        ...loserAfter,
      },
    };
  };

  return tx ? run(tx) : db.transaction(run);
}
