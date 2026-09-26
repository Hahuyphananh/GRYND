/**
 * elo-rating.test.mjs
 *
 * Tests for the per-game GRYND Elo rating system:
 *   * src/lib/elo.js     — the pure, configurable calculation
 *   * the provisional window (placement → provisional → established), which is
 *     tracked per (player, game) and never combined across games
 *   * src/lib/rating.js  — the server-authoritative writer + idempotency journal
 *   * the anti-reset identity ledger, which stops a re-created account from
 *     resetting its rating or restarting its provisional window
 *   * the settlement wiring (every rated game must feed the writer)
 *   * the security posture (nothing client-supplied can move a rating)
 *
 * The writer tests run against an in-memory fake transaction that emulates
 * exactly the statements applyRatingResult issues (create+lock the rating
 * row, restore from the identity ledger on creation, duplicate check, two
 * rating updates, two ledger mirrors, two journal inserts). That keeps the
 * suite hermetic — no DATABASE_URL, no Postgres — while still exercising the
 * real code path, argument validation and idempotency logic.
 *
 * Run:  node --import tsx --test tests/elo-rating.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  STARTING_RATING,
  RATING_FLOOR,
  ELO_SCALE,
  K_FACTORS,
  DEFAULT_K,
  PROVISIONAL_GAMES,
  PLACEMENT_GAMES,
  RATING_STAGES,
  HIGH_RATING_THRESHOLD,
  expectedScore,
  actualScore,
  isValidOutcome,
  kFactorFor,
  ratingDelta,
  computeMatchRatings,
  clampRating,
  isProvisional,
  provisionalStage,
  provisionalProgress,
  ELO_CONFIG,
} from "../src/lib/elo.js";

import {
  applyRatingResult,
  isRatedGame,
  RATED_GAMES,
  getRatingGameLabel,
  normalizeRatingGameKey,
  identityHashForEmail,
  normalizeRatingIdentity,
  toRatingShape,
} from "../src/lib/rating.js";

// ════════════════════════════════════════════════════════════════════════
// Fake transaction harness
// ════════════════════════════════════════════════════════════════════════

/**
 * Compile a drizzle `sql` template into { text, params } using drizzle's own
 * dialect, so the fake transaction sees exactly the SQL a real driver would.
 */
const dialect = new PgDialect();
function flatten(query) {
  const { sql, params } = dialect.sqlToQuery(query);
  return { text: sql, params };
}

const norm = (text) => text.replace(/\s+/g, " ").trim();

/**
 * A minimal in-memory stand-in for the drizzle transaction handle.
 * Records every statement so tests can assert that a rejected call wrote
 * nothing at all.
 */
function makeFakeDb({ users = [], seededEvents = [], seededIdentities = [] } = {}) {
  const state = {
    users,
    ratings: new Map(), // `${userId}:${gameKey}` -> row
    // The anti-reset ledger, `${identityHash}:${gameKey}` -> row. Survives
    // "account deletion" in tests simply by not being tied to a user id.
    identities: new Map(seededIdentities),
    events: [...seededEvents],
    statements: [],
  };

  const tx = {
    async execute(query) {
      const { text, params } = flatten(query);
      const sql = norm(text);
      state.statements.push({ sql, params });

      // ── user lookup ──────────────────────────────────────────────
      if (/^SELECT id, clerk_id AS "clerkId", email FROM users/i.test(sql)) {
        return { rows: state.users.filter((u) => params.includes(u.clerkId)) };
      }

      // ── create + lock a rating row ───────────────────────────────
      // Emulates INSERT ... SELECT ... LEFT JOIN rating_identities ...
      // ON CONFLICT DO UPDATE: a row that already exists is returned
      // untouched; a first-time row is seeded from the identity ledger when
      // this email has rated this game before (the re-registered account),
      // otherwise from the documented defaults.
      if (/^INSERT INTO player_ratings/i.test(sql)) {
        const [userId, gameKey, defaultRating] = params;
        // The identity key is rendered inside the LEFT JOIN, so its position
        // among the parameters depends on the statement's text layout. Pull
        // it out by shape instead — a 64-char sha256 hex, exactly what
        // identityHashForEmail produces (null when the account has no email).
        const identityHash =
          params.find((p) => typeof p === "string" && /^[0-9a-f]{64}$/.test(p)) ??
          null;
        const key = `${userId}:${gameKey}`;
        let row = state.ratings.get(key);
        if (!row) {
          const identity = identityHash
            ? state.identities.get(`${identityHash}:${gameKey}`)
            : null;
          row = identity
            ? { ...identity, user_id: userId, game_key: gameKey }
            : {
                user_id: userId,
                game_key: gameKey,
                rating: defaultRating,
                peak_rating: defaultRating,
                games_rated: 0,
                wins: 0,
                losses: 0,
                draws: 0,
                last_delta: 0,
                last_rated_at: null,
              };
          state.ratings.set(key, row);
        }
        return {
          rows: [
            {
              user_id: row.user_id,
              rating: row.rating,
              games_rated: row.games_rated,
              wins: row.wins,
              losses: row.losses,
              draws: row.draws,
            },
          ],
        };
      }

      // ── duplicate check ─────────────────────────────────────────
      if (/^SELECT 1 AS hit FROM rating_events/i.test(sql)) {
        const [gameKey, matchId, a, b] = params;
        const hit = state.events.some(
          (e) =>
            e.game_key === gameKey &&
            e.match_id === matchId &&
            (e.user_id === a || e.user_id === b),
        );
        return { rows: hit ? [{ hit: 1 }] : [] };
      }

      // ── rating updates ──────────────────────────────────────────
      if (/^UPDATE player_ratings/i.test(sql)) {
        const [rating, , inc1, inc2, delta, userId, gameKey] = params;
        const row = state.ratings.get(`${userId}:${gameKey}`);
        if (row) {
          row.rating = rating;
          row.peak_rating = Math.max(row.peak_rating ?? rating, rating);
          row.last_delta = delta;
          row.games_rated += 1;
          if (/wins = wins \+/.test(sql)) {
            row.wins += inc1;
            row.draws += inc2;
          } else {
            row.losses += inc1;
            row.draws += inc2;
          }
        }
        return { rows: [], rowCount: 1 };
      }

      // ── identity ledger mirror (anti-reset snapshot) ─────────────
      if (/^INSERT INTO rating_identities/i.test(sql)) {
        const [identityHash, userId, gameKey] = params;
        const row = state.ratings.get(`${userId}:${gameKey}`);
        if (row) {
          const prev = state.identities.get(`${identityHash}:${gameKey}`);
          state.identities.set(`${identityHash}:${gameKey}`, {
            rating: row.rating,
            peak_rating: Math.max(prev?.peak_rating ?? 0, row.peak_rating ?? row.rating),
            games_rated: row.games_rated,
            wins: row.wins,
            losses: row.losses,
            draws: row.draws,
            last_delta: row.last_delta,
            last_rated_at: null,
          });
        }
        return { rows: [], rowCount: row ? 1 : 0 };
      }

      // ── journal inserts (two rows per match) ─────────────────────
      if (/^INSERT INTO rating_events/i.test(sql)) {
        for (let i = 0; i < params.length; i += 9) {
          const [
            userId,
            gameKey,
            matchId,
            opponentId,
            outcome,
            before,
            after,
            delta,
            kFactor,
          ] = params.slice(i, i + 9);
          state.events.push({
            user_id: userId,
            game_key: gameKey,
            match_id: matchId,
            opponent_id: opponentId,
            outcome,
            rating_before: before,
            rating_after: after,
            delta,
            k_factor: kFactor,
          });
        }
        return { rows: [], rowCount: 2 };
      }

      throw new Error(`FakeDb: unrecognised statement -> ${sql}`);
    },
  };

  /** Statements that actually mutate a rating, the ledger or the journal. */
  const writes = () =>
    state.statements.filter(
      (s) =>
        /^UPDATE player_ratings/i.test(s.sql) ||
        /^INSERT INTO rating_identities/i.test(s.sql) ||
        /^INSERT INTO rating_events/i.test(s.sql),
    );

  const eventsFor = (gameKey) =>
    state.events.filter((e) => e.game_key === gameKey);

  return { tx, state, writes, eventsFor };
}

const TWO_USERS = [
  { id: 11, clerkId: "user_winner", email: "winner@grynd.test" },
  { id: 22, clerkId: "user_loser", email: "loser@grynd.test" },
];

const WIN_ARGS = {
  gameKey: "chess",
  matchId: "match-1",
  winnerClerkId: "user_winner",
  loserClerkId: "user_loser",
};

// ════════════════════════════════════════════════════════════════════════
// 1. Constants / configuration
// ════════════════════════════════════════════════════════════════════════

test("config: new players start at exactly 1000 Elo", () => {
  assert.equal(STARTING_RATING, 1000);
  assert.equal(ELO_CONFIG.startingRating, 1000);
});

test("config: K-factor is a single configurable table, default 32", () => {
  assert.equal(DEFAULT_K, 32);
  assert.equal(K_FACTORS.default, 32);
  assert.equal(K_FACTORS.provisional, 40);
  assert.equal(K_FACTORS.placement, 64);
  assert.equal(K_FACTORS.high, 16);
  assert.equal(ELO_CONFIG.kFactors.default, 32);
  assert.equal(ELO_CONFIG.kFactors.placement, 64);
  assert.equal(PROVISIONAL_GAMES, 10);
  assert.equal(PLACEMENT_GAMES, 3);
  assert.equal(ELO_CONFIG.provisionalGames, 10);
  assert.equal(ELO_CONFIG.placementGames, 3);
  assert.deepEqual([...RATING_STAGES], ["placement", "provisional", "established"]);
  assert.equal(HIGH_RATING_THRESHOLD, 2400);
  assert.equal(ELO_SCALE, 400);
  // The provisional window must contain the placement stage.
  assert.ok(PLACEMENT_GAMES > 0 && PLACEMENT_GAMES < PROVISIONAL_GAMES);
});

// ════════════════════════════════════════════════════════════════════════
// 2. The formula — 1 / (1 + 10^((opp - me) / 400))
// ════════════════════════════════════════════════════════════════════════

test("expectedScore: equal ratings ⇒ exactly 0.5", () => {
  assert.equal(expectedScore(1000, 1000), 0.5);
  assert.equal(expectedScore(1850, 1850), 0.5);
});

test("expectedScore: 400-point gap ⇒ the documented 1/11 vs 10/11", () => {
  assert.equal(expectedScore(1400, 1000), 10 / 11);
  assert.equal(expectedScore(1000, 1400), 1 / 11);
});

test("expectedScore: complementary — E(a,b) + E(b,a) = 1", () => {
  for (const [a, b] of [
    [1000, 1000],
    [1000, 1400],
    [1600, 950],
    [2400, 1200],
  ]) {
    assert.ok(Math.abs(expectedScore(a, b) + expectedScore(b, a) - 1) < 1e-12);
  }
});

test("expectedScore: always strictly inside (0, 1)", () => {
  for (const [a, b] of [
    [0, 5000],
    [5000, 0],
    [1, 99999],
  ]) {
    const e = expectedScore(a, b);
    assert.ok(e > 0 && e < 1, `E(${a},${b}) = ${e}`);
  }
});

test("actualScore: win = 1, loss = 0, draw = 0.5", () => {
  assert.equal(actualScore("win"), 1);
  assert.equal(actualScore("loss"), 0);
  assert.equal(actualScore("draw"), 0.5);
  assert.equal(isValidOutcome("win"), true);
  assert.equal(isValidOutcome("loss"), true);
  assert.equal(isValidOutcome("draw"), true);
  assert.equal(isValidOutcome("destroyed"), false);
});

// ════════════════════════════════════════════════════════════════════════
// 3. K-factor selection (configurable, never hardcoded at a call site)
// ════════════════════════════════════════════════════════════════════════

test("kFactorFor: K decays across the provisional window, then settles", () => {
  // Placement: rated matches 1–3.
  assert.equal(kFactorFor({ rating: 1000, gamesRated: 0 }), 64);
  assert.equal(kFactorFor({ rating: 1000, gamesRated: 1 }), 64);
  assert.equal(kFactorFor({ rating: 1000, gamesRated: 2 }), 64);
  // Provisional tail: matches 4–10.
  assert.equal(kFactorFor({ rating: 1000, gamesRated: 3 }), 40);
  assert.equal(kFactorFor({ rating: 1000, gamesRated: 9 }), 40);
  // Established: match 11 onwards.
  assert.equal(kFactorFor({ rating: 1000, gamesRated: 10 }), 32);
  assert.equal(kFactorFor({ rating: 1000, gamesRated: 250 }), 32);
});

test("kFactorFor: an elite rating drops to the high-band K", () => {
  assert.equal(kFactorFor({ rating: 2400, gamesRated: 50 }), 16);
  assert.equal(kFactorFor({ rating: 3000, gamesRated: 500 }), 16);
  assert.equal(kFactorFor({ rating: 2399, gamesRated: 50 }), 32);
  // Provisional always wins over the high band — a brand-new 2500 is impossible
  // in practice, but the ordering must be deterministic.
  assert.equal(kFactorFor({ rating: 2500, gamesRated: 1 }), 64);
  assert.equal(kFactorFor({ rating: 2500, gamesRated: 5 }), 40);
  assert.equal(kFactorFor({ rating: 2500, gamesRated: 50 }), 16);
});

// ════════════════════════════════════════════════════════════════════════
// 4. TEST: WIN / LOSS / DRAW at equal ratings
// ════════════════════════════════════════════════════════════════════════

test("TEST WIN: equal ratings, established K=32 ⇒ +16 / −16", () => {
  const r = computeMatchRatings({
    winnerRating: 1000,
    loserRating: 1000,
    winnerGamesRated: 50,
    loserGamesRated: 50,
  });
  assert.equal(r.result, "win");
  assert.equal(r.winner.expected, 0.5);
  assert.equal(r.winner.k, 32);
  assert.equal(r.winner.delta, 16);
  assert.equal(r.winner.ratingAfter, 1016);
  assert.equal(r.loser.delta, -16);
  assert.equal(r.loser.ratingAfter, 984);
});

test("TEST LOSS: the loser's own arithmetic is the exact mirror", () => {
  const r = computeMatchRatings({
    winnerRating: 1000,
    loserRating: 1000,
    winnerGamesRated: 50,
    loserGamesRated: 50,
  });
  assert.equal(r.loser.actual, 0);
  assert.equal(r.loser.expected, 0.5);
  assert.equal(r.loser.delta, -16);
  assert.ok(r.loser.delta < 0);
  // Equal K on both sides ⇒ the ladder is zero-sum for this match.
  assert.equal(r.winner.delta + r.loser.delta, 0);
});

test("TEST DRAW: equal ratings ⇒ zero movement, both score 0.5", () => {
  const r = computeMatchRatings({
    winnerRating: 1000,
    loserRating: 1000,
    winnerGamesRated: 50,
    loserGamesRated: 50,
    result: "draw",
  });
  assert.equal(r.result, "draw");
  assert.equal(r.winner.actual, 0.5);
  assert.equal(r.loser.actual, 0.5);
  assert.equal(r.winner.delta, 0);
  assert.equal(r.loser.delta, 0);
  assert.equal(r.winner.ratingAfter, 1000);
  assert.equal(r.loser.ratingAfter, 1000);
});

test("TEST DRAW: the underdog gains and the favourite loses", () => {
  const r = computeMatchRatings({
    winnerRating: 1000, // the weaker player
    loserRating: 1600, // the stronger player
    winnerGamesRated: 50,
    loserGamesRated: 50,
    result: "draw",
  });
  assert.ok(r.winner.delta > 0, `underdog draw delta = ${r.winner.delta}`);
  assert.ok(r.loser.delta < 0, `favourite draw delta = ${r.loser.delta}`);
  assert.equal(r.winner.ratingAfter, 1000 + r.winner.delta);
  assert.equal(r.loser.ratingAfter, 1600 + r.loser.delta);
});

test("TEST DRAW: provisional draw on an equal ladder moves nothing", () => {
  const r = computeMatchRatings({
    winnerRating: 1000,
    loserRating: 1000,
    winnerGamesRated: 0,
    loserGamesRated: 0,
    result: "draw",
  });
  assert.equal(r.winner.k, 64);
  assert.equal(r.winner.delta, 0); // 64 × (0.5 − 0.5)
  assert.equal(r.loser.delta, 0);
});

test("TEST PROVISIONAL: movement shrinks as the sample grows, then settles", () => {
  // A single equal-opponent win, measured at each stage of the window.
  const oneWin = (winnerGamesRated) =>
    computeMatchRatings({
      winnerRating: 1000,
      loserRating: 1000,
      winnerGamesRated,
      loserGamesRated: 50,
    }).winner;

  // Placement (matches 1–3): the biggest allowed swing.
  assert.equal(oneWin(0).k, 64);
  assert.equal(oneWin(0).delta, 32); // 64 × (1 − 0.5)
  // Provisional tail (matches 4–10): still above the established default.
  assert.equal(oneWin(3).k, 40);
  assert.equal(oneWin(3).delta, 20);
  // Established (match 11+): the normal configuration.
  const established = oneWin(40);
  assert.equal(established.k, 32);
  assert.equal(established.delta, 16);

  // Strictly non-increasing across the whole window ⇒ convergence is
  // monotonic, never a jump back up to a wild K after a bad run.
  const deltas = [0, 1, 2, 3, 5, 9].map((n) => oneWin(n).delta);
  for (let i = 1; i < deltas.length; i += 1) {
    assert.ok(
      deltas[i] <= deltas[i - 1],
      `delta must not grow: ${JSON.stringify(deltas)}`,
    );
  }
  assert.ok(established.delta < deltas[deltas.length - 1]);
});

// ════════════════════════════════════════════════════════════════════════
// 5. TEST: significantly different ratings
// ════════════════════════════════════════════════════════════════════════

test("TEST DIFFERENT RATINGS: favourite gains (almost) nothing, underdog gains a lot", () => {
  // Strong (1800) beats weak (1000) — expected outcome, tiny reward.
  const favouriteWins = computeMatchRatings({
    winnerRating: 1800,
    loserRating: 1000,
    winnerGamesRated: 50,
    loserGamesRated: 50,
  });
  // Weak (1000) beats strong (1800) — huge upset, big reward.
  const underdogWins = computeMatchRatings({
    winnerRating: 1000,
    loserRating: 1800,
    winnerGamesRated: 50,
    loserGamesRated: 50,
  });

  // An 800-point gap makes the win a near-certainty, so the favourite's reward
  // rounds to zero and their opponent barely moves on a loss.
  assert.ok(favouriteWins.winner.expected > 0.98);
  assert.ok(favouriteWins.winner.delta >= 0);
  assert.ok(favouriteWins.winner.delta < underdogWins.winner.delta);
  assert.ok(
    Math.abs(favouriteWins.loser.delta) < Math.abs(underdogWins.loser.delta),
  );
  // An 800-point gap is a near-certainty: the favourite gains ~1 point.
  assert.ok(favouriteWins.winner.delta <= 2, `got ${favouriteWins.winner.delta}`);
  assert.ok(underdogWins.winner.delta >= 30, `got ${underdogWins.winner.delta}`);
});

test("TEST DIFFERENT RATINGS: expected scores follow the 400-point scale", () => {
  const r = computeMatchRatings({
    winnerRating: 1400,
    loserRating: 1000,
    winnerGamesRated: 50,
    loserGamesRated: 50,
  });
  assert.ok(Math.abs(r.winner.expected - 10 / 11) < 1e-12);
  assert.equal(r.winner.delta, Math.round(32 * (1 - 10 / 11))); // 3
  assert.equal(r.loser.delta, Math.round(32 * (0 - 1 / 11))); // -3
});

// ════════════════════════════════════════════════════════════════════════
// 6. Configurable K + clamping
// ════════════════════════════════════════════════════════════════════════

test("EVERY match can be run at an explicit K (tuning knob, no hardcoding)", () => {
  const r = computeMatchRatings({
    winnerRating: 1000,
    loserRating: 1000,
    winnerGamesRated: 50,
    loserGamesRated: 50,
    k: 64,
  });
  assert.equal(r.winner.k, 64);
  assert.equal(r.winner.delta, 32); // 64 × (1 − 0.5)
  assert.equal(r.loser.delta, -32);
});

test("ratingDelta: K never comes from the ratings themselves", () => {
  const a = ratingDelta({ rating: 1000, opponentRating: 1000, outcome: "win" });
  const b = ratingDelta({
    rating: 1000,
    opponentRating: 1000,
    outcome: "win",
    k: 8,
  });
  assert.equal(a.k, 64); // placement default for a brand-new rating
  assert.equal(b.k, 8);
  assert.equal(b.delta, 4);
});

test("clampRating: never below the floor, never above the ceiling", () => {
  assert.equal(clampRating(-500), RATING_FLOOR);
  assert.equal(clampRating(0), RATING_FLOOR);
  assert.equal(clampRating(1234), 1234);
  assert.equal(clampRating(999999), ELO_CONFIG.ratingCeiling);
  assert.equal(clampRating("not-a-number"), STARTING_RATING);
});

test("isProvisional: true until PROVISIONAL_GAMES rated matches", () => {
  assert.equal(isProvisional(0), true);
  assert.equal(isProvisional(9), true);
  assert.equal(isProvisional(10), false);
});

test("provisionalStage: placement → provisional → established", () => {
  assert.equal(provisionalStage(0), "placement");
  assert.equal(provisionalStage(2), "placement");
  assert.equal(provisionalStage(3), "provisional");
  assert.equal(provisionalStage(9), "provisional");
  assert.equal(provisionalStage(10), "established");
  assert.equal(provisionalStage(999), "established");
});

test("provisionalProgress: the exact fields the UI reads, per game", () => {
  // A brand-new player in a game they have never rated.
  const fresh = provisionalProgress(0, 1000);
  assert.equal(fresh.provisional, true);
  assert.equal(fresh.provisionalStage, "placement");
  assert.equal(fresh.provisionalGamesCompleted, 0);
  assert.equal(fresh.provisionalGamesRemaining, 10);
  assert.equal(fresh.provisionalGamesTotal, 10);
  assert.equal(fresh.provisionalProgressPercent, 0);
  assert.equal(fresh.kFactor, 64);

  // Mid-window: 4 completed ⇒ 6 left, in the provisional tail.
  const mid = provisionalProgress(4, 1030);
  assert.equal(mid.provisional, true);
  assert.equal(mid.provisionalStage, "provisional");
  assert.equal(mid.provisionalGamesCompleted, 4);
  assert.equal(mid.provisionalGamesRemaining, 6);
  assert.equal(mid.provisionalProgressPercent, 40);
  assert.equal(mid.kFactor, 40);

  // Finished: established, nothing remaining, a full bar, normal K.
  const done = provisionalProgress(10, 1420);
  assert.equal(done.provisional, false);
  assert.equal(done.provisionalStage, "established");
  assert.equal(done.provisionalGamesCompleted, 10);
  assert.equal(done.provisionalGamesRemaining, 0);
  assert.equal(done.provisionalProgressPercent, 100);
  assert.equal(done.kFactor, 32);

  // Past the window the completed count stays capped, and an elite rating
  // picks up the high-band K.
  const veteran = provisionalProgress(80, 2500);
  assert.equal(veteran.provisionalGamesCompleted, 10);
  assert.equal(veteran.provisionalGamesRemaining, 0);
  assert.equal(veteran.kFactor, 16);

  // Defensive: garbage counts are treated as "no games yet", never NaN.
  for (const bad of [-5, null, undefined, "nope", NaN]) {
    const p = provisionalProgress(bad);
    assert.equal(p.gamesRated, 0);
    assert.equal(p.provisional, true);
    assert.equal(p.provisionalGamesRemaining, 10);
  }
});

// ════════════════════════════════════════════════════════════════════════
// 7. TEST: WIN through the authoritative writer
// ════════════════════════════════════════════════════════════════════════

test("WRITER WIN: creates both rows at 1000, applies placement +32/−32, journals both", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  const result = await applyRatingResult({ tx: db.tx, ...WIN_ARGS });

  assert.equal(result.applied, true);
  assert.equal(result.result, "win");
  assert.equal(result.winner.ratingBefore, 1000);
  assert.equal(result.winner.ratingAfter, 1032); // placement K=64, equal ratings
  assert.equal(result.winner.delta, 32);
  assert.equal(result.winner.k, 64);
  assert.equal(result.loser.ratingBefore, 1000);
  assert.equal(result.loser.ratingAfter, 968);
  assert.equal(result.loser.delta, -32);

  // Rows persisted (independent per game).
  assert.equal(db.state.ratings.get("11:chess").rating, 1032);
  assert.equal(db.state.ratings.get("11:chess").wins, 1);
  assert.equal(db.state.ratings.get("22:chess").rating, 968);
  assert.equal(db.state.ratings.get("22:chess").losses, 1);
  assert.equal(db.state.ratings.get("11:chess").games_rated, 1);

  // Two journal rows, one per player, with the correct outcomes.
  const events = db.eventsFor("chess");
  assert.equal(events.length, 2);
  assert.equal(events[0].outcome, "win");
  assert.equal(events[0].rating_before, 1000);
  assert.equal(events[0].rating_after, 1032);
  assert.equal(events[0].delta, 32);
  assert.equal(events[0].k_factor, 64);
  assert.equal(events[0].opponent_id, 22);
  assert.equal(events[1].outcome, "loss");
  assert.equal(events[1].delta, -32);
  assert.equal(events[1].opponent_id, 11);

  // The result carries the post-match provisional state, derived from the
  // per-game counter — match 1 of 10.
  assert.equal(result.winner.gamesRated, 1);
  assert.equal(result.winner.provisional, true);
  assert.equal(result.winner.provisionalStage, "placement");
  assert.equal(result.winner.provisionalGamesCompleted, 1);
  assert.equal(result.winner.provisionalGamesRemaining, 9);
  assert.equal(result.loser.provisionalGamesRemaining, 9);
});

test("WRITER LOSS: the loser's journal row is a loss and their rating falls", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  const result = await applyRatingResult({ tx: db.tx, ...WIN_ARGS });

  const loserEvent = db.eventsFor("chess").find((e) => e.user_id === 22);
  assert.equal(loserEvent.outcome, "loss");
  assert.ok(loserEvent.delta < 0);
  assert.ok(loserEvent.rating_after < loserEvent.rating_before);
  assert.equal(result.loser.ratingAfter, loserEvent.rating_after);
});

test("WRITER DRAW: both journal rows say draw and equal ratings do not move", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  const result = await applyRatingResult({
    tx: db.tx,
    ...WIN_ARGS,
    result: "draw",
  });

  assert.equal(result.applied, true);
  assert.equal(result.result, "draw");
  assert.equal(result.winner.delta, 0);
  assert.equal(result.loser.delta, 0);

  const events = db.eventsFor("chess");
  assert.equal(events.length, 2);
  assert.equal(events[0].outcome, "draw");
  assert.equal(events[1].outcome, "draw");
  // Counts: a draw is neither a win nor a loss.
  assert.equal(db.state.ratings.get("11:chess").wins, 0);
  assert.equal(db.state.ratings.get("11:chess").losses, 0);
  assert.equal(db.state.ratings.get("11:chess").draws, 1);
  assert.equal(db.state.ratings.get("22:chess").draws, 1);
});

test("WRITER: a second match uses the stored rating, not 1000 again", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  await applyRatingResult({ tx: db.tx, ...WIN_ARGS });
  const second = await applyRatingResult({
    tx: db.tx,
    ...WIN_ARGS,
    matchId: "match-2",
  });

  assert.equal(second.winner.ratingBefore, 1032);
  assert.ok(second.winner.ratingAfter > 1032);
  assert.equal(db.state.ratings.get("11:chess").games_rated, 2);
});

// ════════════════════════════════════════════════════════════════════════
// 8. TEST: duplicate result submission
// ════════════════════════════════════════════════════════════════════════

test("TEST DUPLICATE RESULT: the second settlement writes nothing at all", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  const first = await applyRatingResult({ tx: db.tx, ...WIN_ARGS });
  assert.equal(first.applied, true);

  const ratingAfterFirst = db.state.ratings.get("11:chess").rating;
  const eventsAfterFirst = db.eventsFor("chess").length;
  const writesAfterFirst = db.writes().length;
  // 2 rating UPDATEs + 2 identity-ledger mirrors + 1 journal INSERT.
  assert.equal(writesAfterFirst, 5);

  const second = await applyRatingResult({ tx: db.tx, ...WIN_ARGS });

  assert.equal(second.applied, false);
  assert.equal(second.reason, "duplicate");
  // Not a single rating UPDATE or journal INSERT was issued the second time;
  // the whole second call costs four reads (user lookup, two row locks, the
  // journal probe) and no writes.
  assert.equal(db.writes().length, writesAfterFirst);
  assert.equal(db.state.ratings.get("11:chess").rating, ratingAfterFirst);
  assert.equal(db.eventsFor("chess").length, eventsAfterFirst);
});

test("TEST DUPLICATE RESULT: an already-journaled match is refused before any lock-free write", async () => {
  const db = makeFakeDb({
    users: TWO_USERS,
    seededEvents: [
      {
        user_id: 11,
        game_key: "chess",
        match_id: "match-1",
        outcome: "win",
      },
    ],
  });

  const result = await applyRatingResult({ tx: db.tx, ...WIN_ARGS });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "duplicate");
  assert.equal(db.writes().length, 0);
});

test("TEST DUPLICATE RESULT: the journal key is (user, game, match) — a different match still rates", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  await applyRatingResult({ tx: db.tx, ...WIN_ARGS });
  const other = await applyRatingResult({
    tx: db.tx,
    ...WIN_ARGS,
    matchId: "match-2",
  });
  assert.equal(other.applied, true);
});

// ════════════════════════════════════════════════════════════════════════
// 9. TEST: unauthorized rating manipulation
// ════════════════════════════════════════════════════════════════════════

test("TEST UNAUTHORIZED: an unrated game can never move a rating", async () => {
  for (const gameKey of [
    "poker",
    "crash-arena",
    "uno",
    "tower-arena",
    "roulette-pvp",
    "hex-duel",
    "not-a-game",
    "",
  ]) {
    const db = makeFakeDb({ users: TWO_USERS });
    const result = await applyRatingResult({ tx: db.tx, ...WIN_ARGS, gameKey });
    assert.equal(result.applied, false, `game ${gameKey} must not be rated`);
    assert.equal(db.writes().length, 0);
  }
});

test("TEST UNAUTHORIZED: a player cannot rate themselves", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  const result = await applyRatingResult({
    tx: db.tx,
    ...WIN_ARGS,
    loserClerkId: "user_winner",
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "same-player");
  assert.equal(db.writes().length, 0);
});

test("TEST UNAUTHORIZED: half a match (missing participant) is refused", async () => {
  for (const bad of [
    { winnerClerkId: null },
    { loserClerkId: null },
    { winnerClerkId: "" },
    { loserClerkId: undefined },
  ]) {
    const db = makeFakeDb({ users: TWO_USERS });
    const result = await applyRatingResult({ tx: db.tx, ...WIN_ARGS, ...bad });
    assert.equal(result.applied, false);
    assert.equal(db.writes().length, 0);
  }
});

test("TEST UNAUTHORIZED: an unknown / unparseable match id is refused", async () => {
  for (const matchId of ["", null, undefined, "x".repeat(200)]) {
    const db = makeFakeDb({ users: TWO_USERS });
    const result = await applyRatingResult({ tx: db.tx, ...WIN_ARGS, matchId });
    assert.equal(result.applied, false);
    assert.equal(result.reason, "invalid-match-id");
    assert.equal(db.writes().length, 0);
  }
});

test("TEST UNAUTHORIZED: unknown players are refused (nothing to rate)", async () => {
  const db = makeFakeDb({ users: [{ id: 11, clerkId: "user_winner" }] });
  const result = await applyRatingResult({ tx: db.tx, ...WIN_ARGS });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "user-not-found");
  assert.equal(db.writes().length, 0);
});

test("TEST UNAUTHORIZED: ratings are never taken from arguments", async () => {
  // There is no accepted parameter for a rating, a delta or an outcome
  // beyond win/draw — smuggled extras must be ignored entirely.
  const db = makeFakeDb({ users: TWO_USERS });
  const result = await applyRatingResult({
    tx: db.tx,
    ...WIN_ARGS,
    rating: 9999,
    winnerRating: 9999,
    loserRating: 0,
    ratingAfter: 9999,
    delta: 500,
    outcome: "win",
  });
  assert.equal(result.applied, true);
  assert.equal(result.winner.ratingBefore, 1000); // not the smuggled 9999
  assert.equal(result.winner.ratingAfter, 1032); // not the smuggled 9999
  assert.equal(result.winner.delta, 32); // not the smuggled 500
});

test("TEST UNAUTHORIZED: win/draw are the only outcomes the writer accepts", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  // Anything that is not the exact string "draw" is treated as a win, so a
  // crafted value can never produce a third scoring branch.
  const result = await applyRatingResult({
    tx: db.tx,
    ...WIN_ARGS,
    result: "loss", // a "loss" for the winner is nonsense — normalised to a win
  });
  assert.equal(result.result, "win");
  assert.ok(result.winner.delta > 0);
});

test("SECURITY: no API route accepts a rating/delta from the request body", () => {
  const roots = ["src/app/api", "src/lib"];
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      const src = fs.readFileSync(full, "utf8");
      // A client-supplied rating or delta would have to be read off the body.
      if (/body\??\.(rating|elo|ratingDelta|delta)\b/.test(src)) {
        offenders.push(full);
      }
    }
  };
  for (const root of roots) walk(root);

  assert.deepEqual(offenders, [], `these files read a rating from the body: ${offenders.join(", ")}`);
});

test("SECURITY: only src/lib/rating.js writes the rating tables", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|sql)$/.test(entry.name)) continue;
      if (full === "src/lib/rating.js") continue;
      if (full === "src/db/schema.ts") continue;
      if (full.endsWith("_player_ratings.sql")) continue;
      if (full.endsWith("_rating_identities.sql")) continue;
      const src = fs.readFileSync(full, "utf8");
      if (
        /INSERT INTO player_ratings|UPDATE player_ratings|INSERT INTO rating_events|INSERT INTO rating_identities|UPDATE rating_identities/i.test(
          src,
        )
      ) {
        offenders.push(full);
      }
    }
  };
  for (const dir of ["src", "game-engine"]) walk(dir);

  assert.deepEqual(
    offenders,
    [],
    `rating tables must only be written by src/lib/rating.js; found: ${offenders.join(", ")}`,
  );

  // The anti-reset ledger must NOT be erased by account deletion — that is
  // the whole point of keying it by email identity instead of user id.
  // Comments are stripped first, because the purge deliberately DOCUMENTS
  // the omission in prose.
  const purgeCode = fs
    .readFileSync("src/lib/security/deleteUserData.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(
    purgeCode,
    /ratingIdentities|rating_identities/i,
    "the account purge must not delete the rating identity ledger",
  );
});

// ════════════════════════════════════════════════════════════════════════
// 10. TEST: each game has an independent rating
// ════════════════════════════════════════════════════════════════════════

test("TEST INDEPENDENT RATINGS: a Chess result cannot move a Precision rating", async () => {
  const db = makeFakeDb({ users: TWO_USERS });

  await applyRatingResult({ tx: db.tx, ...WIN_ARGS, gameKey: "chess" });

  // Only the chess row exists — nothing was created for any other game.
  assert.equal(db.state.ratings.size, 2);
  assert.equal(db.state.ratings.has("11:chess"), true);
  assert.equal(db.state.ratings.has("11:precision"), false);

  const precision = await applyRatingResult({
    tx: db.tx,
    ...WIN_ARGS,
    gameKey: "precision",
    matchId: "precision-1",
  });

  // Precision started at 1000 even though Chess is already at 1032: a fresh
  // ladder in a second game, fully independent of the first.
  assert.equal(precision.winner.ratingBefore, 1000);
  assert.equal(precision.winner.ratingAfter, 1032);

  // Precision's provisional window is its own: 1 of 10 played, while Chess
  // is also at 1 of 10 — the counters are per game.
  assert.equal(precision.winner.provisionalGamesCompleted, 1);

  const before11 = db.state.ratings.get("11:precision").rating;
  const before22 = db.state.ratings.get("22:precision").rating;

  // And the two ladders moved independently: the reverse result at precision
  // must not touch the chess rating.
  const reverse = await applyRatingResult({
    tx: db.tx,
    gameKey: "precision",
    matchId: "precision-2",
    winnerClerkId: "user_loser",
    loserClerkId: "user_winner",
  });

  // Chess is untouched by the Precision matches…
  assert.equal(db.state.ratings.get("11:chess").rating, 1032);
  // …while the Precision ladder moved on its own, and because the two players
  // had already drifted apart the swing is asymmetric rather than flat: the
  // math is applied per game, not shared.
  assert.ok(reverse.winner.delta > 0);
  assert.ok(reverse.loser.delta < 0);
  assert.equal(
    db.state.ratings.get("22:precision").rating,
    before22 + reverse.winner.delta,
  );
  assert.equal(
    db.state.ratings.get("11:precision").rating,
    before11 + reverse.loser.delta,
  );
});

test("TEST INDEPENDENT RATINGS: every rated game keeps its own row", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  for (const gameKey of RATED_GAMES) {
    await applyRatingResult({
      tx: db.tx,
      ...WIN_ARGS,
      gameKey,
      matchId: `${gameKey}-1`,
    });
  }
  for (const gameKey of RATED_GAMES) {
    assert.equal(
      db.state.ratings.has(`11:${gameKey}`),
      true,
      `missing rating row for ${gameKey}`,
    );
    assert.equal(
      db.eventsFor(gameKey).length,
      2,
      `expected two journal rows for ${gameKey}`,
    );
  }
  assert.equal(db.state.ratings.size, RATED_GAMES.length * 2);
});

test("RATED_GAMES: the registry is the audited 1v1/server-authoritative set", () => {
  assert.deepEqual([...RATED_GAMES], [
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
  assert.equal(isRatedGame("chess"), true);
  assert.equal(isRatedGame("hex-duel"), false); // client-supplied winner
  assert.equal(isRatedGame("tower-arena"), false); // 2–6 players
  assert.equal(isRatedGame("uno"), false); // 2–4 players
  assert.equal(isRatedGame("poker"), false); // no discrete verdict
  assert.equal(isRatedGame("crash-arena"), false); // per-hand economy
  assert.equal(normalizeRatingGameKey("nope"), RATED_GAMES[0]);
  assert.equal(getRatingGameLabel("pool"), "Pool Masters");
});

// ════════════════════════════════════════════════════════════════════════
// 11. Settlement wiring — every rated game must feed the writer
// ════════════════════════════════════════════════════════════════════════

const WIRING = [
  ["chess", "src/app/api/chess/move/route.js"],
  ["chess", "src/app/api/chess/game-state/route.js"],
  ["chess", "src/app/api/chess/end-game/route.js"],
  ["four-in-a-row", "src/lib/fourInARowServer.js"],
  ["dots-and-boxes", "src/lib/dotsAndBoxesServer.js"],
  ["pool", "src/app/api/pool/resign/route.ts"],
  ["memory-grid", "src/lib/memory-grid/serverStore.js"],
  ["precision", "src/lib/precision/finishMatch.ts"],
  ["mines-pvp", "src/lib/mines-pvp/serverStore.js"],
  ["keno-pvp", "src/lib/keno-pvp/serverStore.js"],
  ["plinko-pvp", "src/lib/plinko-pvp/serverStore.js"],
  ["lane-rush-duel", "src/lib/lane-rush-duel/serverStore.js"],
  ["blackjack-pvp", "src/lib/blackjack-pvp/serverStore.js"],
  ["dice-flush", "src/app/api/dice-flush/_lib.js"],
  ["rps-pvp", "src/lib/rps-pvp/serverStore.js"],
  ["odds-pvp", "src/app/api/odds/pvp/pick/route.ts"],
  ["odds-pvp", "src/app/api/odds/pvp/forfeit/route.ts"],
  ["odds-pvp", "src/app/api/odds/pvp/cleanup/route.ts"],
];

for (const [gameKey, file] of WIRING) {
  test(`WIRING: ${file} feeds the ${gameKey} rating`, () => {
    const src = fs.readFileSync(file, "utf8");
    assert.match(
      src,
      /import\s*\{[^}]*applyRatingResult[^}]*\}/,
      `${file} must import applyRatingResult`,
    );
    assert.match(
      src,
      new RegExp(`gameKey:\\s*"${gameKey}"`),
      `${file} must rate gameKey "${gameKey}"`,
    );
    assert.match(
      src,
      /applyRatingResult\(\{/,
      `${file} must call applyRatingResult`,
    );
  });
}

test("WIRING: hex-duel is deliberately NOT rated until its winner is server-derived", () => {
  const hexEnd = fs.readFileSync(
    "src/app/api/hex-duel/multiplayer/end/route.ts",
    "utf8",
  );
  // The endpoint still takes the winner from the request body — documented as
  // the blocker that keeps Hex Duel out of the rated set.
  assert.match(hexEnd, /body\.winner/);
  assert.equal(isRatedGame("hex-duel"), false);
});

// ════════════════════════════════════════════════════════════════════════
// 11b. TEST: the provisional-rating system (per player, per game)
// ════════════════════════════════════════════════════════════════════════

test("TEST NEW PLAYER: 1000 Elo, provisional, 0 of 10 completed", () => {
  assert.equal(STARTING_RATING, 1000);
  const p = provisionalProgress(0, STARTING_RATING);
  assert.equal(p.provisional, true);
  assert.equal(p.provisionalStage, "placement");
  assert.equal(p.provisionalGamesCompleted, 0);
  assert.equal(p.provisionalGamesRemaining, 10);
  assert.equal(p.provisionalProgressPercent, 0);
});

test("TEST FIRST RANKED MATCH: placement K=64 and progress becomes 1/10", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  const r = await applyRatingResult({ tx: db.tx, ...WIN_ARGS });
  assert.equal(r.applied, true);
  assert.equal(r.winner.k, K_FACTORS.placement);
  assert.equal(r.winner.delta, 32); // 64 × (1 − 0.5)
  assert.equal(r.winner.provisional, true);
  assert.equal(r.winner.provisionalStage, "placement");
  assert.equal(r.winner.provisionalGamesCompleted, 1);
  assert.equal(r.winner.provisionalGamesRemaining, 9);
  assert.equal(r.winner.provisionalProgressPercent, 10);
});

test("TEST PROVISIONAL PROGRESSION: K decays per match, normal from match 11", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  const ks = [];
  for (let i = 0; i < PROVISIONAL_GAMES; i += 1) {
    const r = await applyRatingResult({
      tx: db.tx,
      ...WIN_ARGS,
      matchId: `window-${i}`,
    });
    ks.push(r.winner.k);
  }
  assert.deepEqual(ks, [64, 64, 64, 40, 40, 40, 40, 40, 40, 40]);

  // The 11th rated match is the first settled under the normal configuration.
  const eleventh = await applyRatingResult({
    tx: db.tx,
    ...WIN_ARGS,
    matchId: "window-10",
  });
  assert.equal(eleventh.winner.k, DEFAULT_K);
  assert.equal(eleventh.winner.provisional, false);
  assert.equal(eleventh.winner.provisionalStage, "established");
  assert.equal(eleventh.winner.provisionalGamesCompleted, 10);
  assert.equal(eleventh.winner.provisionalGamesRemaining, 0);
  assert.equal(eleventh.winner.provisionalProgressPercent, 100);
  assert.equal(db.state.ratings.get("11:chess").games_rated, 11);
});

test("TEST PROVISIONAL: the 10-match window is not escapable by winning", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  // Six wins in a row: the rating climbs fast, but the window still has to be
  // played out — a high provisional rating does NOT switch off the window.
  let last;
  for (let i = 0; i < 6; i += 1) {
    last = await applyRatingResult({ tx: db.tx, ...WIN_ARGS, matchId: `w-${i}` });
  }
  assert.ok(last.winner.ratingAfter > 1100, `rating = ${last.winner.ratingAfter}`);
  assert.equal(last.winner.provisional, true);
  assert.equal(last.winner.provisionalGamesRemaining, 4);
  assert.equal(last.winner.k, K_FACTORS.provisional); // 40, not the elite K
});

test("TEST SEPARATE PROVISIONAL STATUS: finishing Chess leaves Precision provisional", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  for (let i = 0; i < PROVISIONAL_GAMES; i += 1) {
    await applyRatingResult({
      tx: db.tx,
      ...WIN_ARGS,
      gameKey: "chess",
      matchId: `chess-${i}`,
    });
  }
  // Chess: window complete.
  assert.equal(provisionalStage(db.state.ratings.get("11:chess").games_rated), "established");
  assert.equal(provisionalStage(db.state.ratings.get("22:chess").games_rated), "established");

  // Precision: untouched — placement 1 of 10, on a fresh 1000 ladder.
  const firstPrecision = await applyRatingResult({
    tx: db.tx,
    ...WIN_ARGS,
    gameKey: "precision",
    matchId: "precision-0",
  });
  assert.equal(firstPrecision.winner.ratingBefore, 1000);
  assert.equal(firstPrecision.winner.k, K_FACTORS.placement);
  assert.equal(firstPrecision.winner.provisional, true);
  assert.equal(firstPrecision.winner.provisionalStage, "placement");
  assert.equal(firstPrecision.winner.provisionalGamesCompleted, 1);
  assert.equal(firstPrecision.winner.provisionalGamesRemaining, 9);
  // …and Chess is still established and unmoved by it.
  assert.equal(
    provisionalStage(db.state.ratings.get("11:chess").games_rated),
    "established",
  );
  assert.equal(db.state.ratings.get("11:chess").games_rated, PROVISIONAL_GAMES);
});

// ════════════════════════════════════════════════════════════════════════
// 11c. TEST: provisional status cannot be reset by recreating an account
// ════════════════════════════════════════════════════════════════════════

test("IDENTITY: the key is deterministic, normalized and never the raw email", () => {
  const a = identityHashForEmail("Winner@Grynd.test");
  const b = identityHashForEmail("  winner@grynd.test  ");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(a, /winner|grynd/i);
  assert.notEqual(a, identityHashForEmail("loser@grynd.test"));
  // No usable address ⇒ no anchor (the player still rates normally).
  for (const bad of ["", "   ", null, undefined]) {
    assert.equal(identityHashForEmail(bad), null);
  }
  assert.equal(normalizeRatingIdentity("  A@B.CO "), "a@b.co");
});

test("TEST RESET PREVENTION: re-creating the account restores rating + provisional status", async () => {
  // Account 1 plays out its whole provisional window.
  const first = makeFakeDb({ users: TWO_USERS });
  for (let i = 0; i < PROVISIONAL_GAMES; i += 1) {
    await applyRatingResult({ tx: first.tx, ...WIN_ARGS, matchId: `first-${i}` });
  }
  const carried = first.state.ratings.get("11:chess").rating;
  assert.notEqual(carried, 1000);
  assert.equal(first.state.ratings.get("11:chess").games_rated, PROVISIONAL_GAMES);

  // The account is deleted — `player_ratings` cascades away with the users
  // row — and a NEW users row appears with the SAME email. Only the
  // email-keyed identity ledger survives.
  const rebound = makeFakeDb({
    users: [
      { id: 501, clerkId: "user_reborn", email: "winner@grynd.test" },
      { id: 502, clerkId: "user_reborn_loser", email: "loser@grynd.test" },
    ],
    seededIdentities: [...first.state.identities.entries()],
  });

  const r = await applyRatingResult({
    tx: rebound.tx,
    gameKey: "chess",
    matchId: "reborn-1",
    winnerClerkId: "user_reborn",
    loserClerkId: "user_reborn_loser",
  });

  // NOT reset to 1000 with a fresh 10-match provisional window.
  assert.equal(r.applied, true);
  assert.equal(r.winner.ratingBefore, carried);
  assert.equal(r.winner.provisional, false);
  assert.equal(r.winner.provisionalStage, "established");
  assert.equal(r.winner.provisionalGamesCompleted, 10);
  assert.equal(r.winner.provisionalGamesRemaining, 0);
  assert.equal(r.winner.k, DEFAULT_K); // normal configuration immediately
});

test("TEST RESET PREVENTION: the ledger is per game — Chess cannot seed Precision", async () => {
  const first = makeFakeDb({ users: TWO_USERS });
  for (let i = 0; i < PROVISIONAL_GAMES; i += 1) {
    await applyRatingResult({
      tx: first.tx,
      ...WIN_ARGS,
      gameKey: "chess",
      matchId: `c-${i}`,
    });
  }

  const rebound = makeFakeDb({
    users: [
      { id: 777, clerkId: "user_reborn", email: "winner@grynd.test" },
      { id: 888, clerkId: "user_reborn_loser", email: "loser@grynd.test" },
    ],
    seededIdentities: [...first.state.identities.entries()],
  });

  // Only the Chess snapshot exists, so an unplayed game is untouched by it.
  const p = await applyRatingResult({
    tx: rebound.tx,
    gameKey: "precision",
    matchId: "p-1",
    winnerClerkId: "user_reborn",
    loserClerkId: "user_reborn_loser",
  });
  assert.equal(p.winner.ratingBefore, 1000);
  assert.equal(p.winner.provisionalGamesCompleted, 1);
  assert.equal(p.winner.k, K_FACTORS.placement);
  assert.equal(rebound.state.ratings.has("777:chess"), false);
});

test("TEST RESET PREVENTION: an account with no email still rates normally", async () => {
  const db = makeFakeDb({
    users: [
      { id: 11, clerkId: "user_winner" },
      { id: 22, clerkId: "user_loser" },
    ],
  });
  const r = await applyRatingResult({ tx: db.tx, ...WIN_ARGS });
  assert.equal(r.applied, true);
  assert.equal(r.winner.ratingAfter, 1032);
  // No anchor ⇒ nothing written to the ledger, and no crash.
  assert.equal(db.state.identities.size, 0);
});

test("UI CONTRACT: the provisional fields reach the profile + stats APIs", () => {
  const stats = fs.readFileSync("src/app/api/user/stats/route.ts", "utf8");
  assert.match(stats, /provisionalProgress\(0\)/);
  assert.match(stats, /ratedGames: RATED_GAMES\.map/);
  const profile = fs.readFileSync("src/app/api/user/public-profile/route.ts", "utf8");
  assert.match(profile, /getRatingsForUser/);
  assert.match(profile, /ratings,/);
  // `toRatingShape` is the single read shape all of them funnel through.
  const rating = fs.readFileSync("src/lib/rating.js", "utf8");
  assert.match(rating, /\.\.\.provisionalProgress\(gamesRated, rating\)/);
});

// ════════════════════════════════════════════════════════════════════════
// 12. Database artifacts
// ════════════════════════════════════════════════════════════════════════

test("SCHEMA: player_ratings + rating_events exist with the right columns", () => {
  const schema = fs.readFileSync("src/db/schema.ts", "utf8");
  assert.match(schema, /pgTable\(\s*"player_ratings"/);
  assert.match(schema, /pgTable\(\s*"rating_events"/);
  for (const col of [
    "game_key",
    "rating",
    "peak_rating",
    "games_rated",
    "last_delta",
    "last_rated_at",
  ]) {
    assert.match(schema, new RegExp(`"${col}"`), `player_ratings.${col} missing`);
  }
  for (const col of [
    "match_id",
    "opponent_id",
    "outcome",
    "rating_before",
    "rating_after",
    "k_factor",
  ]) {
    assert.match(schema, new RegExp(`"${col}"`), `rating_events.${col} missing`);
  }
  // The idempotency key.
  assert.match(schema, /player_ratings_user_game_unique/);
  assert.match(schema, /rating_events_unique_event/);
});

test("MIGRATION: 0170 is present and registered in the drizzle journal", () => {
  const sql = fs.readFileSync(
    "src/db/migrations/0170_player_ratings.sql",
    "utf8",
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "player_ratings"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "rating_events"/);
  assert.match(sql, /UNIQUE \("user_id", "game_key", "match_id"\)/);
  assert.match(sql, /DEFAULT 1000/); // STARTING_RATING

  const journal = JSON.parse(
    fs.readFileSync("src/db/migrations/meta/_journal.json", "utf8"),
  );
  const idx = journal.entries.findIndex((e) => e.tag === "0170_player_ratings");
  assert.ok(idx > 0, "0170_player_ratings must be in _journal.json");
  const entry = journal.entries[idx];
  assert.equal(entry.idx, 151);
  assert.ok(
    entry.when > journal.entries[idx - 1].when,
    "journal timestamps must stay ordered",
  );
});

test("SCHEMA: rating_identities carries the anti-reset snapshot", () => {
  const schema = fs.readFileSync("src/db/schema.ts", "utf8");
  assert.match(schema, /pgTable\(\s*"rating_identities"/);
  for (const col of ["identity_hash", "game_key", "rating", "games_rated"]) {
    assert.match(schema, new RegExp(`"${col}"`), `rating_identities.${col} missing`);
  }
  assert.match(schema, /rating_identities_identity_game_unique/);
  // No FK to users — that is what makes it survive account deletion.
  const block = schema.slice(schema.indexOf('pgTable(\n  "rating_identities"'));
  const body = block.slice(0, block.indexOf("export const chatRoomTypeEnum"));
  assert.doesNotMatch(
    body,
    /references\(\(\) => users\.id/,
    "rating_identities must not cascade with the users row",
  );
});

test("MIGRATION: 0171 is present and registered in the drizzle journal", () => {
  const sql = fs.readFileSync(
    "src/db/migrations/0171_rating_identities.sql",
    "utf8",
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "rating_identities"/);
  assert.match(sql, /UNIQUE \("identity_hash", "game_key"\)/);
  // The doc comment is load-bearing: it explains why the table has no FK.
  assert.match(sql, /account deletion/i);
  assert.doesNotMatch(sql, /REFERENCES "users"/);

  const journal = JSON.parse(
    fs.readFileSync("src/db/migrations/meta/_journal.json", "utf8"),
  );
  const entry = journal.entries.find((e) => e.tag === "0171_rating_identities");
  assert.ok(entry, "0171_rating_identities must be in _journal.json");
  assert.equal(entry.idx, 152);
  // 0171 must be followed by the 0172 drop it was released with. (Later
  // migrations may be appended after it, so this must not assert "last".)
  const next = journal.entries.find((e) => e.tag === "0172_drop_big_wins");
  assert.ok(next, "0172_drop_big_wins must follow 0171");
  assert.equal(next.idx, 153);
});

test("MIGRATION: 0172 drops the obsolete big_wins table", () => {
  const sql = fs.readFileSync(
    "src/db/migrations/0172_drop_big_wins.sql",
    "utf8",
  );
  assert.match(sql, /DROP TABLE IF EXISTS "big_wins"/);
  // The drop is scoped to big_wins only — the economy tables are untouched.
  assert.doesNotMatch(sql, /DROP TABLE IF EXISTS "(users|token|battle)/i);

  const journal = JSON.parse(
    fs.readFileSync("src/db/migrations/meta/_journal.json", "utf8"),
  );
  const entry = journal.entries.find((e) => e.tag === "0172_drop_big_wins");
  assert.ok(entry, "0172_drop_big_wins must be in _journal.json");
  assert.equal(entry.idx, 153);
});

// ════════════════════════════════════════════════════════════════════════
// 13. Invariants: Elo is independent of the economy
// ════════════════════════════════════════════════════════════════════════

test("INVARIANT: the calculation never reads tokens, XP, Battle Pass or Prestige", () => {
  const elo = fs.readFileSync("src/lib/elo.js", "utf8");
  // Strip comments so explanatory prose can't trip the check.
  const code = elo
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const banned of [
    "balance",
    "token",
    "payout",
    "wager",
    "betAmount",
    "\\bxp\\b",
    "battlepass",
    "prestige",
    "streak",
    "cosmetic",
    "multiplier",
    "level",
  ]) {
    assert.doesNotMatch(
      code,
      new RegExp(banned, "i"),
      `elo.js must not reference ${banned}`,
    );
  }
});

test("INVARIANT: elo.js is pure — it imports nothing", () => {
  const elo = fs.readFileSync("src/lib/elo.js", "utf8");
  assert.doesNotMatch(elo, /^\s*import\s/m, "elo.js must have no imports");
});

test("INVARIANT: rating.js never touches the economy", () => {
  // Strip comments first — the prose deliberately explains that the economy
  // is NOT an input, which would otherwise trip the check.
  const code = fs
    .readFileSync("src/lib/rating.js", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  assert.doesNotMatch(code, /betAmount|payout|total_won|totalWagered/i);
  // The writer takes exactly the identifying + outcome arguments.
  const signature = code.match(/applyRatingResult\(\{([\s\S]*?)\}\)/);
  assert.ok(signature, "applyRatingResult signature not found");
  const destructured = signature[1]
    .split(",")
    .map((s) => s.trim().split("=")[0].trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(destructured, [
    "gameKey",
    "k",
    "loserClerkId",
    "matchId",
    "result",
    "tx",
    "winnerClerkId",
  ]);
});

console.log("\n✅ All Elo rating tests passed!\n");
