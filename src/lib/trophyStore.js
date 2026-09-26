// src/lib/trophyStore.js
//
// SERVER-AUTHORITATIVE TROPHIES — one independent trophy count per game, per
// player.
//
// This is the ONLY module allowed to read or write `player_trophies` /
// `trophy_events` / `trophy_identities`. It is modelled directly on the Elo
// hook (src/lib/rating.js), which is the platform's pattern for "an
// authoritative match result happened — apply progression exactly once":
//
//   * Each game settles inside a row-locked transaction.
//   * That transaction calls `applyTrophyResult` with BOTH competitors, the
//     authoritative match id, and the outcome.
//   * The (user_id, game_key, match_id) unique journal makes a duplicate,
//     replayed or concurrent settlement a guaranteed no-op.
//
// TROPHIES ARE PER-GAME AND INDEPENDENT. A player's Chess trophies live in
// their own row and are only ever read/written by Chess settlements.
//
// THE RULE (see src/lib/trophies.js — the single source of truth):
//   win = +30, loss = −30, draw = 0, clamped to [0, 1000] per game.
//   At a multi-seat table the ±30 becomes a symmetric placement LADDER
//   (applyPlacementTrophies): 1st +30, last −30, even shares between,
//   zero-sum, with tied seats averaging the ranks they span.
//
// WHAT NEVER ENTERS THE CALCULATION (by construction):
// token balance, winnings/payout, wagered amount, XP, Battle Pass, Prestige,
// streaks, cosmetics, membership. The only inputs are the two current
// trophy counts and the outcome.
//
// WHAT THE CLIENT CAN NEVER DO:
//   * submit a trophy count or a delta (there is no write path that accepts
//     one),
//   * submit a match outcome (every caller derives it server-side),
//   * earn trophies from an AI / free-play / fun-mode match (callers guard, and
//     the game key must be in the Elo registry),
//   * reset progress by deleting and recreating an account (see the identity
//     ledger below).
//
// GAME ELIGIBILITY
//   Exactly the Elo registry (`RATED_GAMES` via `isTrophyGame`), so trophies
//   and Elo can never disagree about which games are competitive.
//
// ANTI-RESET (trophy_identities)
//   `player_trophies` cascades away with the `users` row, so deleting an
//   account would otherwise hand back a fresh 0 and a fresh ladder. Every
//   settlement therefore also mirrors progress into `trophy_identities`, keyed
//   by the SAME email identity digest the Elo ledger uses
//   (`identityHashForEmail`) with NO foreign key to `users`. A re-registered
//   account restores its trophies instead of restarting.

import { sql } from "drizzle-orm";
import { db } from "../db";
import { identityHashForEmail } from "./rating";
import {
  OVERALL_TROPHIES_LABEL,
  OVERALL_TROPHY_MIN_GAMES,
  TROPHY_GAMES,
  TROPHY_START,
  applyTrophyChange,
  clampTrophies,
  computePlacementTrophies,
  trophyDeltaForOutcome,
  getTrophyGameLabel,
  isTrophyGame,
  isValidTrophyOutcome,
  normalizeTrophyGameKey,
  toTrophyShape,
  trophyProgress,
} from "./trophies";

/** The journal/game-key shape guard (mirrors rating.js's GAME_KEY_RE). */
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
 * Read one player's trophies for one game. Returns null when the player has
 * never completed a ranked match in that game — an unplayed game is NOT given
 * a fabricated 0 row (the row is created on the first ranked match).
 */
export async function getTrophyForUser({ clerkId, gameKey }) {
  if (!clerkId || !isTrophyGame(gameKey)) return null;
  const rows = await getSql().execute(sql`
    SELECT t.trophies, t.peak_trophies AS "peakTrophies",
           t.games_rated AS "gamesRated", t.wins, t.losses, t.draws,
           t.last_delta AS "lastDelta", t.last_trophy_at AS "lastTrophyAt"
      FROM player_trophies t
      INNER JOIN users u ON u.id = t.user_id
     WHERE u.clerk_id = ${clerkId}
       AND t.game_key = ${String(gameKey)}
     LIMIT 1
  `);
  const row = rows.rows?.[0] ?? rows[0];
  if (!row) return null;
  return toTrophyShape(gameKey, row);
}

/**
 * Every trophy count a player owns, keyed by game. Missing games are simply
 * absent. Never creates rows.
 */
export async function getTrophiesForUser(clerkId) {
  if (!clerkId) return {};
  const rows = await getSql().execute(sql`
    SELECT t.game_key AS "gameKey", t.trophies, t.peak_trophies AS "peakTrophies",
           t.games_rated AS "gamesRated", t.wins, t.losses, t.draws,
           t.last_delta AS "lastDelta", t.last_trophy_at AS "lastTrophyAt"
      FROM player_trophies t
      INNER JOIN users u ON u.id = t.user_id
     WHERE u.clerk_id = ${clerkId}
  `);
  const out = {};
  for (const row of rows.rows ?? rows) {
    const key = String(row.gameKey);
    out[key] = toTrophyShape(key, row);
  }
  return out;
}

// ── Aggregate read ────────────────────────────────────────────────────────

/**
 * A player's TOTAL trophies — the SUM of their per-game trophy counts.
 *
 * This is the value the Battle Pass level is derived from (see
 * `getLevelFromTrophies` in src/lib/battlepass.js), and the value the navbar
 * chip shows. It is computed on read; nothing is stored. Returns 0 for a
 * player who has not earned trophies in any game.
 */
export async function getTotalTrophiesForUser(clerkId) {
  if (!clerkId) return 0;
  const rows = await getSql().execute(sql`
    SELECT COALESCE(SUM(t.trophies), 0)::int AS total
      FROM player_trophies t
      INNER JOIN users u ON u.id = t.user_id
     WHERE u.clerk_id = ${clerkId}
  `);
  const row = rows.rows?.[0] ?? rows[0];
  return Number(row?.total) || 0;
}

// ── Bulk read (matchmaking) ───────────────────────────────────────────────

/**
 * The trophy maps for MANY players at once, keyed by Clerk id, for the
 * quick-queue matcher. One query instead of one per queued request.
 *
 * Returns `{ [clerkId]: { [gameKey]: trophies } }`. A player with no trophy
 * rows is simply absent, which the matcher treats as "no skill signal".
 */
export async function getTrophyMapsForUsers(clerkIds) {
  const ids = [
    ...new Set(
      (Array.isArray(clerkIds) ? clerkIds : [])
        .filter(Boolean)
        .map((id) => String(id)),
    ),
  ];
  if (ids.length === 0) return {};

  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await getSql().execute(sql`
    SELECT u.clerk_id AS "clerkId", t.game_key AS "gameKey", t.trophies
      FROM player_trophies t
      INNER JOIN users u ON u.id = t.user_id
     WHERE u.clerk_id IN (${list})
  `);

  const out = {};
  for (const row of rows.rows ?? rows) {
    const clerkId = String(row.clerkId);
    if (!out[clerkId]) out[clerkId] = {};
    out[clerkId][String(row.gameKey)] = clampTrophies(row.trophies);
  }
  return out;
}

// ── Leaderboards (read-only) ──────────────────────────────────────────────
//
// Trophy boards are pure reads of the same `player_trophies` rows the writer
// maintains. Nothing here can move a count.

/**
 * Ranked board for one game: every player with trophies in that game, highest
 * count first. Ties break on fewer losses, then the older account id
 * (deterministic). Same `{ items, me }` contract as the Elo boards so the UI
 * can reuse its row rendering; rows also carry the player's Overall Trophies
 * badge when they qualify.
 */
export async function fetchTrophyLeaderboard({
  gameKey = TROPHY_GAMES[0],
  limit = 50,
  offset = 0,
  clerkId = null,
} = {}) {
  if (!isTrophyGame(gameKey)) return { items: [], me: null };
  const lim = Math.min(100, Math.max(1, Number(limit) || 20));
  const off = Math.max(0, Number(offset) || 0);

  const rows = await getSql().execute(sql`
    WITH ranked AS (
      SELECT
        ROW_NUMBER() OVER (
          ORDER BY t.trophies DESC, t.losses ASC, u.id ASC
        )::int AS rank,
        u.clerk_id AS clerk_id,
        u.name AS name,
        u.selected_icon AS icon_key,
        t.trophies,
        t.peak_trophies AS peak_trophies,
        t.games_rated AS games_rated,
        t.wins,
        t.losses,
        t.draws,
        t.last_delta AS last_delta,
        t.last_trophy_at AS last_trophy_at,
        CASE
          WHEN (t.wins + t.losses) > 0
            THEN ROUND((t.wins::numeric / (t.wins + t.losses)) * 100, 2)
          ELSE 0
        END AS win_rate,
        (t.wins + t.losses) AS games,
        -- The Overall Trophies badge — an independent cross-game aggregate,
        -- not a merge of game counts into this ranking. Absent until the
        -- player has played enough different games, so it auto-hides.
        o2.overall_trophies AS overall_trophies,
        COALESCE(o2.overall_games, 0) AS overall_games,
        json_build_object('name', u.name, 'icon_key', u.selected_icon) AS "user"
      FROM player_trophies t
      INNER JOIN users u ON u.id = t.user_id
      LEFT JOIN (
        SELECT t2.user_id,
               SUM(t2.trophies)::int AS overall_trophies,
               COUNT(*)::int AS overall_games
        FROM player_trophies t2
        GROUP BY t2.user_id
        HAVING COUNT(*) >= ${OVERALL_TROPHY_MIN_GAMES}
      ) o2 ON o2.user_id = t.user_id
      WHERE t.game_key = ${String(gameKey)}
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
  // Same shape as a profile trophy row, plus the normalised Overall badge.
  // Raw snake_case aggregate columns never leave the server.
  const shape = (item) => {
    const { overall_trophies, overall_games, ...rest } = item;
    const overall = Number(overall_trophies);
    return {
      ...rest,
      ...toTrophyShape(gameKey, item),
      ...(Number.isFinite(overall) && overall > 0
        ? { overallTrophies: overall, overallGames: Number(overall_games) || 0 }
        : {}),
    };
  };
  return {
    items: items.map(shape),
    me: me ? shape(me) : null,
  };
}

/**
 * The cross-game OVERALL TROPHIES board.
 *
 * Ranks players by the SUM of their per-game trophy counts and only returns
 * players with a trophy row in at least `OVERALL_TROPHY_MIN_GAMES` games. It
 * is a pure aggregate of the same `player_trophies` rows the per-game boards
 * read — nothing is stored, so a trophy change is reflected on the next read.
 *
 * Shape mirrors `fetchTrophyLeaderboard` (`{ items, me }`).
 */
export async function fetchOverallTrophyLeaderboard({
  limit = 50,
  offset = 0,
  clerkId = null,
} = {}) {
  const lim = Math.min(100, Math.max(1, Number(limit) || 20));
  const off = Math.max(0, Number(offset) || 0);

  const rows = await getSql().execute(sql`
    WITH eligible AS (
      SELECT
        t.user_id,
        SUM(t.trophies)::int AS overall_trophies,
        COUNT(*)::int AS games_played
      FROM player_trophies t
      GROUP BY t.user_id
      HAVING COUNT(*) >= ${OVERALL_TROPHY_MIN_GAMES}
    ),
    ranked AS (
      SELECT
        ROW_NUMBER() OVER (
          ORDER BY e.overall_trophies DESC, u.id ASC
        )::int AS rank,
        u.clerk_id AS clerk_id,
        u.name AS name,
        u.selected_icon AS icon_key,
        e.overall_trophies AS overall_trophies,
        e.games_played AS games_played,
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
    items: items.map(toOverallTrophyShape),
    me: row.me ? toOverallTrophyShape(row.me) : null,
  };
}

/**
 * Normalize an Overall Trophies board row for the UI. `overallTrophies` /
 * `gamesPlayed` are server-computed; the client can never supply them.
 */
export function toOverallTrophyShape(row) {
  return {
    ...row,
    label: OVERALL_TROPHIES_LABEL,
    overallTrophies: Number(row.overallTrophies ?? row.overall_trophies ?? 0),
    gamesPlayed: Number(row.gamesPlayed ?? row.games_played ?? 0),
  };
}

/**
 * The full set of trophy games as `{ key, label }`, so the UI never hardcodes
 * a list that could drift from the Elo registry.
 */
export function listTrophyGames() {
  return TROPHY_GAMES.map((key) => ({ key, label: getTrophyGameLabel(key) }));
}

/** Re-exported so routes/tests read one normalizer. */
export { normalizeTrophyGameKey };

// ── The authoritative writer ──────────────────────────────────────────────

/**
 * Apply one authoritative ranked result to both players' game-specific
 * trophies.
 *
 * The caller MUST already have determined the winner server-side from match
 * state — this function never inspects or trusts a client for the outcome, and
 * it re-validates every argument before touching a row.
 *
 * Flow (all inside one transaction — the caller's when supplied):
 *   1. validate the game key, match id, participants and outcome,
 *   2. resolve both `users.id`s from the Clerk ids,
 *   3. lock/create both `player_trophies` rows in ascending user-id order
 *      (deterministic lock order ⇒ no deadlock between two match results that
 *      involve the same pair in opposite order),
 *   4. bail out if this match already moved either player's trophies,
 *   5. compute both deltas with the pure trophy rule (clamped to 0..10000),
 *   6. update both rows,
 *   6b. mirror the new progress into the anti-reset identity ledger,
 *   7. journal both events.
 *
 * The returned winner/loser objects carry the applied delta and the post-match
 * progression (`trophies`, `complete`, `phase`) so a result screen can show
 * "+30 → 4,320 / 1,000" without a second round-trip.
 *
 * @param {object} params
 * @param {string} params.gameKey       eligible game key (see TROPHY_GAMES)
 * @param {string} params.matchId       authoritative id in the game's own table
 * @param {string} params.winnerClerkId Clerk id of the winning (or seat-A) player
 * @param {string} params.loserClerkId  Clerk id of the losing (or seat-B) player
 * @param {"win"|"draw"} [params.result] "win" (default) or "draw"
 * @param {any} [params.tx]             the caller's settlement transaction
 *
 * @returns {Promise<{
 *   applied: boolean,
 *   reason?: string,
 *   result?: "win"|"draw",
 *   gameKey?: string,
 *   matchId?: string,
 *   winner?: object,
 *   loser?: object,
 * }>}
 * Never throws for expected inputs — callers run it as a best-effort side
 * effect of settlement, exactly like applyRatingResult.
 */
/**
 * The shared settlement internals behind BOTH writers below.
 *
 * `seats` is one entry per participating HUMAN account:
 * `{ clerkId, outcome: "win" | "loss" | "draw", nominalDelta?, place?, placeTo? }`.
 * Everything from here on is identical for a 1v1 duel and for a multi-seat
 * table, which is the point — one locking order, one duplicate guard, one
 * identity ledger, one journal.
 *
 * A seat's `nominalDelta` is its share of the trophy movement (+30 for a duel
 * win, −10 for fourth of six, 0 for a draw). A duel's caller knows it up front;
 * a placement caller cannot, because the ladder is computed from the players'
 * CURRENT counts, which are only known once their rows are locked. Those
 * callers pass `nominalDeltasFor` instead, and it runs here — inside the lock,
 * before any write — so a ladder can never be built from a stale read.
 *
 * @param {object} params
 * @param {any} [params.tx]               the caller's transaction, when it has one
 * @param {string} params.gameKey
 * @param {string} params.matchId
 * @param {Array<{ clerkId: string, outcome: "win"|"loss"|"draw",
 *   nominalDelta?: number, place?: number, placeTo?: number }>} params.seats
 * @param {(clerkId: string, userIds: Record<string, number>) => number|null} params.opponentIdFor
 *        Which participant to journal as each seat's opponent. `userIds` maps
 *        clerk id → resolved `users.id`.
 * @param {(locked: Array<{ clerkId: string, trophies: number, outcome: string }>) => number[]}
 *        [params.nominalDeltasFor]
 *        Aligned with `seats`: the ladder share for each seat, computed from the
 *        locked counts.
 * @returns {Promise<{
 *   applied: boolean,
 *   reason?: string,
 *   results?: Array<{ clerkId: string, userId: number, outcome: string,
 *     before: number, after: number, delta: number,
 *     nominalDelta: number, clamped: boolean }>,
 * }>}
 */
/**
 * The read shape both writers return for one settled seat. `trophiesBefore` /
 * `trophiesAfter` / `delta` are what every result screen renders; `clamped`
 * reports that the bounds cut the nominal ±30 short (a seat floored at 0, or a
 * winner already at the cap), and the progress fields come from the game's own
 * numbers.
 */
function toSettledSeatShape(entry) {
  return {
    userId: entry.userId,
    // A placement seat also reports where it finished (1-based, best first);
    // `placeTo` is its last tied rank, so a 3-way tie for 2nd reads 2..4.
    ...(entry.place ? { place: entry.place, placeTo: entry.placeTo } : {}),
    trophiesBefore: entry.before,
    trophiesAfter: entry.after,
    delta: entry.delta,
    nominalDelta: entry.nominalDelta,
    clamped: entry.clamped,
    ...trophyProgress(entry.after),
  };
}

async function settleTrophies({
  tx,
  gameKey,
  matchId,
  seats,
  opponentIdFor,
  nominalDeltasFor,
}) {
  const key = String(gameKey ?? "");
  const eventId = String(matchId ?? "");

  const run = async (txc) => {
    // ── 2. Resolve every participating app user ──────────────────────
    // `email` is read ONLY to derive the anti-reset identity key below; it is
    // never stored on a trophy row and never leaves this function.
    const clerkIds = seats.map((seat) => String(seat.clerkId));
    const listed = sql.join(
      clerkIds.map((clerkId) => sql`${clerkId}`),
      sql`, `,
    );
    const userRows = await txc.execute(sql`
      SELECT id, clerk_id AS "clerkId", email
        FROM users
       WHERE clerk_id IN (${listed})
    `);
    const users = userRows.rows ?? userRows;
    if (users.length !== seats.length) {
      return { applied: false, reason: "user-not-found" };
    }

    const seatRows = seats.map((seat) => {
      const row = users.find((u) => String(u.clerkId) === String(seat.clerkId));
      return row ? { ...seat, row } : null;
    });
    if (seatRows.some((seat) => !seat)) {
      return { applied: false, reason: "user-not-found" };
    }

    const userIds = {};
    for (const seat of seatRows) userIds[String(seat.clerkId)] = Number(seat.row.id);

    // ── 3. Lock every trophy row in ASCENDING user-id order ──────────
    // (locking in a fixed order is what stops two settlements involving the
    // same players from deadlocking on each other.)
    const ordered = [...seatRows].sort(
      (a, b) => Number(a.row.id) - Number(b.row.id),
    );

    const trophyRows = new Map();

    for (const seat of ordered) {
      const user = seat.row;
      const identityHash = identityHashForEmail(user.email);
      // The INSERT creates the row on the first ranked match; the no-op DO
      // UPDATE makes the statement return — and lock — the existing row.
      //
      // On creation the values are seeded from the identity ledger when this
      // email has earned trophies in this game before (a re-registered
      // account), so the count carries over instead of resetting to 0. A null
      // identity hash simply joins nothing, leaving the documented defaults.
      const locked = await txc.execute(sql`
        INSERT INTO player_trophies
          (user_id, game_key, trophies, peak_trophies, games_rated,
           wins, losses, draws, last_delta, last_trophy_at)
        SELECT
          ${user.id}, ${key},
          COALESCE(i.trophies, ${TROPHY_START}),
          COALESCE(i.peak_trophies, ${TROPHY_START}),
          COALESCE(i.games_rated, 0),
          COALESCE(i.wins, 0),
          COALESCE(i.losses, 0),
          COALESCE(i.draws, 0),
          COALESCE(i.last_delta, 0),
          i.last_trophy_at
          FROM (SELECT 1) AS anchor
          LEFT JOIN trophy_identities i
            ON i.identity_hash = ${identityHash}
           AND i.game_key = ${key}
        ON CONFLICT (user_id, game_key)
        DO UPDATE SET updated_at = player_trophies.updated_at
        RETURNING user_id, trophies, games_rated, wins, losses, draws
      `);
      const trophyRow = (locked.rows ?? locked)[0];
      if (!trophyRow) return { applied: false, reason: "trophy-lock-failed" };
      trophyRows.set(String(seat.clerkId), trophyRow);
    }

    if (trophyRows.size !== seats.length) {
      return { applied: false, reason: "trophy-lock-failed" };
    }

    // ── 4. Duplicate guard (inside the lock) ─────────────────────────
    // Every participating trophy row is locked, so a concurrent settlement of
    // this same match is serialized behind us and will see the journal rows
    // written below.
    const participantIds = sql.join(
      ordered.map((seat) => sql`${Number(seat.row.id)}`),
      sql`, `,
    );
    const dupe = await txc.execute(sql`
      SELECT 1 AS hit
        FROM trophy_events
       WHERE game_key = ${key}
         AND match_id = ${eventId}
         AND user_id IN (${participantIds})
       LIMIT 1
    `);
    if ((dupe.rows ?? dupe).length > 0) {
      return { applied: false, reason: "duplicate" };
    }

    // ── 5. Pure trophy math, per seat ────────────────────────────────
    // The nominal share comes either from the caller (a duel knows it up front)
    // or from the placement ladder, which needs the locked counts and therefore
    // runs HERE — inside the lock, before anything is written.
    //
    // Each seat's own bound still clamps its own delta, so a seat on the floor
    // loses nothing and a winner already at the cap gains nothing: a table can
    // move less than the nominal ladder when seats sit at the bounds.
    const lockedSeats = ordered.map((seat) => ({
      clerkId: String(seat.clerkId),
      trophies: trophyRows.get(String(seat.clerkId)).trophies,
      outcome: seat.outcome,
    }));
    const ladderShares = nominalDeltasFor ? nominalDeltasFor(lockedSeats) : null;

    const results = ordered.map((seat, index) => {
      const row = trophyRows.get(String(seat.clerkId));
      const nominalDelta = Number.isFinite(Number(ladderShares?.[index]))
        ? Math.trunc(Number(ladderShares[index]))
        : Number.isFinite(Number(seat.nominalDelta))
          ? Math.trunc(Number(seat.nominalDelta))
          : trophyDeltaForOutcome(seat.outcome);
      const computed = applyTrophyChange(row.trophies, nominalDelta);
      // games_rated/wins/losses/draws are separate counters from the trophy
      // count; draws count as neither a win nor a loss.
      const isWin = seat.outcome === "win";
      const isDraw = seat.outcome === "draw";
      return {
        clerkId: String(seat.clerkId),
        userId: Number(seat.row.id),
        identityHash: identityHashForEmail(seat.row.email),
        outcome: seat.outcome,
        isWin,
        isDraw,
        place: Number.isFinite(Number(seat.place)) ? Number(seat.place) : null,
        placeTo: Number.isFinite(Number(seat.placeTo))
          ? Number(seat.placeTo)
          : null,
        before: computed.before,
        after: computed.after,
        delta: computed.delta,
        nominalDelta: computed.nominalDelta,
        clamped: computed.clamped,
      };
    });

    // ── 6. Update every seat's trophy counters ───────────────────────
    // The UPDATE shape is intentionally identical for every seat (the caller
    // only picks the win or loss column), so nothing here can drift between
    // the 1v1 and the multi-seat path.
    for (const result of results) {
      if (result.isWin) {
        await txc.execute(sql`
          UPDATE player_trophies
             SET trophies = ${result.after},
                 peak_trophies = GREATEST(peak_trophies, ${result.after}),
                 games_rated = games_rated + 1,
                 wins = wins + ${result.isDraw ? 0 : 1},
                 draws = draws + ${result.isDraw ? 1 : 0},
                 last_delta = ${result.delta},
                 last_trophy_at = NOW(),
                 updated_at = NOW()
           WHERE user_id = ${result.userId} AND game_key = ${key}
        `);
      } else {
        await txc.execute(sql`
          UPDATE player_trophies
             SET trophies = ${result.after},
                 peak_trophies = GREATEST(peak_trophies, ${result.after}),
                 games_rated = games_rated + 1,
                 losses = losses + ${result.isDraw ? 0 : 1},
                 draws = draws + ${result.isDraw ? 1 : 0},
                 last_delta = ${result.delta},
                 last_trophy_at = NOW(),
                 updated_at = NOW()
           WHERE user_id = ${result.userId} AND game_key = ${key}
        `);
      }
    }

    // ── 6b. Mirror each seat into the identity ledger ────────────────
    // Keyed by the EMAIL identity, not the user row, so it survives account
    // deletion and a re-registered account restores (rather than resets) its
    // trophies. It reads back the rows we just updated, so `player_trophies`
    // stays the single source of truth.
    for (const result of results) {
      if (!result.identityHash) continue;
      await txc.execute(sql`
        INSERT INTO trophy_identities
          (identity_hash, game_key, trophies, peak_trophies, games_rated,
           wins, losses, draws, last_delta, last_trophy_at, updated_at)
        SELECT
          ${result.identityHash}, t.game_key, t.trophies, t.peak_trophies,
          t.games_rated, t.wins, t.losses, t.draws, t.last_delta,
          t.last_trophy_at, NOW()
          FROM player_trophies t
         WHERE t.user_id = ${result.userId}
           AND t.game_key = ${key}
        ON CONFLICT (identity_hash, game_key) DO UPDATE SET
          trophies = EXCLUDED.trophies,
          peak_trophies = GREATEST(trophy_identities.peak_trophies, EXCLUDED.peak_trophies),
          games_rated = EXCLUDED.games_rated,
          wins = EXCLUDED.wins,
          losses = EXCLUDED.losses,
          draws = EXCLUDED.draws,
          last_delta = EXCLUDED.last_delta,
          last_trophy_at = EXCLUDED.last_trophy_at,
          updated_at = NOW()
      `);
    }

    // ── 7. Journal every seat (idempotency + trophy history) ─────────
    // One row per seat, all carrying the same match id, so the unique
    // (user_id, game_key, match_id) index makes a replayed settlement a no-op
    // for the whole table at once.
    const journalRows = sql.join(
      results.map(
        (result) => sql`(${result.userId}, ${key}, ${eventId}, ${opponentIdFor(
          result.clerkId,
          userIds,
        )}, ${result.outcome}, ${result.before}, ${result.after}, ${result.delta})`,
      ),
      sql`, `,
    );
    await txc.execute(sql`
      INSERT INTO trophy_events
        (user_id, game_key, match_id, opponent_id, outcome,
         trophies_before, trophies_after, delta)
      VALUES ${journalRows}
      ON CONFLICT (user_id, game_key, match_id) DO NOTHING
    `);

    return { applied: true, results };
  };

  return tx ? run(tx) : db.transaction(run);
}

/**
 * Apply one authoritative ranked result to both players' game-specific
 * trophies.
 *
 * The caller MUST already have determined the winner server-side from match
 * state — this function never inspects or trusts a client for the outcome,
 * and it re-validates every argument before touching a row.
 *
 * @param {object} params
 * @param {string} params.gameKey       eligible game key (see TROPHY_GAMES)
 * @param {string} params.matchId       authoritative id in the game's own table
 * @param {string} params.winnerClerkId Clerk id of the winning (or seat-A) player
 * @param {string} params.loserClerkId  Clerk id of the losing (or seat-B) player
 * @param {"win"|"draw"} [params.result] "win" (default) or "draw"
 * @param {any} [params.tx]             the caller's settlement transaction
 *
 * @returns {Promise<{
 *   applied: boolean,
 *   reason?: string,
 *   result?: "win"|"draw",
 *   gameKey?: string,
 *   matchId?: string,
 *   winner?: object,
 *   loser?: object,
 * }>}
 * Never throws for expected inputs — callers run it as a best-effort side
 * effect of settlement, exactly like applyRatingResult.
 */
export async function applyTrophyResult({
  tx,
  gameKey,
  matchId,
  winnerClerkId,
  loserClerkId,
  result = "win",
}) {
  const key = String(gameKey ?? "");
  const eventId = String(matchId ?? "");
  const outcome = result === "draw" ? "draw" : "win";

  // ── 1. Validate ────────────────────────────────────────────────────
  if (!isTrophyGame(key)) return { applied: false, reason: "game-not-rated" };
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
  if (!isValidTrophyOutcome(outcome)) {
    return { applied: false, reason: "invalid-outcome" };
  }

  const winnerSeat = { clerkId: String(winnerClerkId), outcome };
  const loserSeat = {
    clerkId: String(loserClerkId),
    outcome: outcome === "draw" ? "draw" : "loss",
  };

  const settled = await settleTrophies({
    tx,
    gameKey: key,
    matchId: eventId,
    seats: [winnerSeat, loserSeat],
    // A duel's opponent is simply the other seat, whichever way the result
    // went (including a draw, where neither seat is a winner).
    opponentIdFor: (clerkId, userIds) =>
      userIds[String(clerkId) === String(winnerClerkId)
        ? String(loserClerkId)
        : String(winnerClerkId)] ?? null,
  });
  if (!settled.applied) return settled;

  // Identified by SEAT, not by outcome: in a draw neither seat's outcome is a
  // "loss", and the read shape still has to report both sides.
  const winnerEntry = settled.results.find(
    (r) => r.clerkId === String(winnerClerkId),
  );
  const loserEntry = settled.results.find(
    (r) => r.clerkId === String(loserClerkId),
  );

  return {
    applied: true,
    result: outcome,
    gameKey: key,
    matchId: eventId,
    winner: toSettledSeatShape(winnerEntry),
    loser: toSettledSeatShape(loserEntry),
  };
}

/**
 * Apply one authoritative MULTI-SEAT ranked result (a table game) to every
 * human seat, on the SYMMETRIC LINEAR PLACEMENT LADDER.
 *
 * THE RULE — one ladder, read by placement:
 *   * first place → +30 (a win),
 *   * last place  → −30 (a loss),
 *   * in between  → that seat's even share (a 4-seat table pays +30/+10/−10/−30,
 *                   a 6-seat table +30/+18/+6/−6/−18/−30),
 *   * seats level on the same placement share the average of the ranks they
 *     span, so ties can never be settled by whichever id the server listed
 *     first,
 *   * the ladder is zero-sum, so a table redistributes rather than mints.
 *
 * `placements` is the WHOLE finishing order, best first: an array of groups, and
 * each group an array of Clerk ids that finished level. A table with a clean
 * 1..N order passes one id per group (`[[first], [second], ...]`); the seats that
 * tie pass together (`[[winner], [a, b, c]]`).
 *
 * AI / practice seats are NEVER passed in by the caller: they hold no account,
 * and a table whose first place is a bot must not settle at all.
 *
 * The ladder is built from the players' CURRENT trophy counts, and those counts
 * are only trustworthy once the rows are locked — so the ladder is computed
 * inside the settlement transaction (`nominalDeltasFor`), between locking and
 * writing. Two seats that reach a table with different counts therefore get the
 * same nominal share, applied to their own count.
 *
 * Idempotency is per table, not per pair: all participants' rows are locked in
 * ascending user-id order and the journal is written for every seat in one
 * statement, so a replayed settlement of the same match is a no-op for the
 * whole table at once.
 *
 * @param {object} params
 * @param {string} params.gameKey     eligible game key (see TROPHY_GAMES)
 * @param {string} params.matchId     authoritative id in the game's own table
 * @param {string[][]} params.placements every human seat, best placement first
 * @param {any} [params.tx]           the caller's settlement transaction
 *
 * @returns {Promise<{
 *   applied: boolean,
 *   reason?: string,
 *   result?: "placement",
 *   gameKey?: string,
 *   matchId?: string,
 *   winner?: object,
 *   places?: object[],
 * }>}
 */
export async function applyPlacementTrophies({
  tx,
  gameKey,
  matchId,
  placements,
}) {
  const key = String(gameKey ?? "");
  const eventId = String(matchId ?? "");

  // ── 1. Validate ────────────────────────────────────────────────────
  if (!isTrophyGame(key)) return { applied: false, reason: "game-not-rated" };
  if (!GAME_KEY_RE.test(key)) return { applied: false, reason: "invalid-game-key" };
  if (!eventId || eventId.length > MAX_MATCH_ID_LENGTH) {
    return { applied: false, reason: "invalid-match-id" };
  }

  // A group may be passed bare (`placements: ["a", "b"]`) or as a group
  // (`[["a"], ["b"]]`); both describe a clean 1..N order.
  const groups = (Array.isArray(placements) ? placements : [])
    .map((group) => (Array.isArray(group) ? group : [group]))
    .map((group) =>
      group.map((clerkId) => String(clerkId ?? "")).filter(Boolean),
    )
    .filter((group) => group.length > 0);

  const order = groups.flat();
  if (order.length < 2) return { applied: false, reason: "missing-player" };
  // A duplicate seat would move one player's trophies twice for one result.
  if (new Set(order).size !== order.length) {
    return { applied: false, reason: "same-player" };
  }

  // ── 2. Build the seats and their placement spans ───────────────────
  // Placement is structural (it does not depend on the counts), so the ranks a
  // group spans are known before the lock; only the ladder share is not.
  const seats = [];
  let cursor = 0;
  groups.forEach((group, groupIndex) => {
    const place = cursor + 1;
    cursor += group.length;
    for (const clerkId of group) {
      seats.push({
        clerkId,
        // First place is the table's win; every other seat lost the table even
        // when the ladder still banked it a few trophies for placing 2nd.
        outcome: groupIndex === 0 ? "win" : "loss",
        place,
        placeTo: cursor,
      });
    }
  });

  const seatIndexByClerk = new Map(order.map((clerkId, index) => [clerkId, index]));
  const winnerClerkId = order[0];

  const settled = await settleTrophies({
    tx,
    gameKey: key,
    matchId: eventId,
    seats,
    // The ladder share for each seat, from the counts read inside the lock.
    nominalDeltasFor: (locked) => {
      const trophiesByClerk = new Map(
        locked.map((seat) => [String(seat.clerkId), seat.trophies]),
      );
      const shares = computePlacementTrophies({
        groups: groups.map((group) =>
          group.map((clerkId) => trophiesByClerk.get(clerkId) ?? TROPHY_START),
        ),
      }).nominalDeltas;
      // `settleTrophies` asks in ITS ordering (ascending user id); translate.
      return locked.map((seat) => {
        const index = seatIndexByClerk.get(String(seat.clerkId));
        return Number.isFinite(index) ? shares[index] : 0;
      });
    },
    // A table's opponent reference is the first-place seat for every loser, and
    // the runner-up for the winner (there is no single "opponent" at a table,
    // so the journal records the seat that beat them, or the one they beat).
    opponentIdFor: (clerkId, userIds) =>
      String(clerkId) === String(winnerClerkId)
        ? userIds[String(order[1])] ?? null
        : userIds[String(winnerClerkId)] ?? null,
  });
  if (!settled.applied) return settled;

  const byClerk = new Map(settled.results.map((r) => [String(r.clerkId), r]));
  const winnerResult = byClerk.get(String(winnerClerkId));

  return {
    applied: true,
    result: "placement",
    gameKey: key,
    matchId: eventId,
    // `places` is the full finishing order (best first) so a result screen can
    // render every seat's swing from one response.
    winner: winnerResult ? toSettledSeatShape(winnerResult) : null,
    places: order
      .map((clerkId) => byClerk.get(String(clerkId)))
      .filter(Boolean)
      .map(toSettledSeatShape),
  };
}
