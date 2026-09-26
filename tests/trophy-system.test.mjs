/**
 * trophy-system.test.mjs
 *
 * Tests for the per-game GRYND trophy system:
 *   * src/lib/trophies.js    — the pure, configurable rule (+30 / −30 / 0) and
 *                              the derived Prestige view of Elo
 *   * the floor (0) and cap (1,000) behaviour
 *   * src/lib/trophyStore.js — the server-authoritative writer + idempotency
 *                              journal + anti-reset identity ledger
 *   * the security posture (nothing client-supplied can move a trophy count,
 *     and only src/lib/trophyStore.js writes the trophy tables)
 *
 * The writer tests run against an in-memory fake transaction that emulates
 * exactly the statements applyTrophyResult issues (create+lock the trophy row,
 * restore from the identity ledger on creation, duplicate check, two trophy
 * updates, two ledger mirrors, two journal inserts). That keeps the suite
 * hermetic — no DATABASE_URL, no Postgres — while still exercising the real
 * code path, argument validation and idempotency logic.
 *
 * Run:  node --import tsx --test tests/trophy-system.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  TROPHY_START,
  TROPHY_WIN,
  TROPHY_LOSS,
  TROPHY_DRAW,
  TROPHY_MIN,
  TROPHY_MAX,
  TROPHY_GAMES,
  TROPHY_OUTCOMES,
  TROPHY_CONFIG,
  clampTrophies,
  trophyDeltaForOutcome,
  isValidTrophyOutcome,
  applyTrophyDelta,
  applyTrophyChange,
  computeMatchTrophies,
  computePlacementTrophies,
  placementLadder,
  placementDeltaForRank,
  PLACEMENT_TOP,
  PLACEMENT_BOTTOM,
  isTrophyComplete,
  trophyPhase,
  prestigeFromRating,
  trophyProgress,
  toTrophyShape,
  isTrophyGame,
  normalizeTrophyGameKey,
  getTrophyGameLabel,
} from "../src/lib/trophies.js";

import {
  applyPlacementTrophies,
  applyTrophyResult,
  getTrophyForUser,
  getTrophiesForUser,
} from "../src/lib/trophyStore.js";

import { RATED_GAMES, identityHashForEmail } from "../src/lib/rating.js";

// ════════════════════════════════════════════════════════════════════════
// Fake transaction harness
// ════════════════════════════════════════════════════════════════════════

const dialect = new PgDialect();
function flatten(query) {
  const { sql, params } = dialect.sqlToQuery(query);
  return { text: sql, params };
}

const norm = (text) => text.replace(/\s+/g, " ").trim();

function makeFakeDb({ users = [], seededEvents = [], seededIdentities = [] } = {}) {
  const state = {
    users,
    trophies: new Map(), // `${userId}:${gameKey}` -> row
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

      // ── create + lock a trophy row ───────────────────────────────
      if (/^INSERT INTO player_trophies/i.test(sql)) {
        const userId = params[0];
        const gameKey = params[1];
        const start = params[2];
        const identityHash =
          params.find((p) => typeof p === "string" && /^[0-9a-f]{64}$/.test(p)) ??
          null;
        const key = `${userId}:${gameKey}`;
        let row = state.trophies.get(key);
        if (!row) {
          const identity = identityHash
            ? state.identities.get(`${identityHash}:${gameKey}`)
            : null;
          row = identity
            ? { ...identity, user_id: userId, game_key: gameKey }
            : {
                user_id: userId,
                game_key: gameKey,
                trophies: start,
                peak_trophies: start,
                games_rated: 0,
                wins: 0,
                losses: 0,
                draws: 0,
                last_delta: 0,
                last_trophy_at: null,
              };
          state.trophies.set(key, row);
        }
        return {
          rows: [
            {
              user_id: row.user_id,
              trophies: row.trophies,
              games_rated: row.games_rated,
              wins: row.wins,
              losses: row.losses,
              draws: row.draws,
            },
          ],
        };
      }

      // ── duplicate check ─────────────────────────────────────────
      // Works for a duel (2 participants) and a table (N participants):
      // everything after the game key and match id is a participant id.
      if (/^SELECT 1 AS hit FROM trophy_events/i.test(sql)) {
        const [gameKey, matchId, ...participantIds] = params;
        const hit = state.events.some(
          (e) =>
            e.game_key === gameKey &&
            e.match_id === matchId &&
            participantIds.includes(e.user_id),
        );
        return { rows: hit ? [{ hit: 1 }] : [] };
      }

      // ── trophy updates ──────────────────────────────────────────
      if (/^UPDATE player_trophies/i.test(sql)) {
        const [trophies, , winInc, drawInc, delta, userId, gameKey] = params;
        const row = state.trophies.get(`${userId}:${gameKey}`);
        if (row) {
          row.trophies = trophies;
          row.peak_trophies = Math.max(row.peak_trophies ?? trophies, trophies);
          row.last_delta = delta;
          row.games_rated += 1;
          if (/wins = wins \+/.test(sql)) {
            row.wins += winInc;
            row.draws += drawInc;
          } else {
            row.losses += winInc;
            row.draws += drawInc;
          }
        }
        return { rows: [], rowCount: 1 };
      }

      // ── identity ledger mirror (anti-reset snapshot) ─────────────
      if (/^INSERT INTO trophy_identities/i.test(sql)) {
        const [identityHash, userId, gameKey] = params;
        const row = state.trophies.get(`${userId}:${gameKey}`);
        if (row) {
          const prev = state.identities.get(`${identityHash}:${gameKey}`);
          state.identities.set(`${identityHash}:${gameKey}`, {
            trophies: row.trophies,
            peak_trophies: Math.max(
              prev?.peak_trophies ?? 0,
              row.peak_trophies ?? row.trophies,
            ),
            games_rated: row.games_rated,
            wins: row.wins,
            losses: row.losses,
            draws: row.draws,
            last_delta: row.last_delta,
            last_trophy_at: null,
          });
        }
        return { rows: [], rowCount: row ? 1 : 0 };
      }

      // ── journal inserts (one row per participating seat) ─────────
      if (/^INSERT INTO trophy_events/i.test(sql)) {
        for (let i = 0; i < params.length; i += 8) {
          const [
            userId,
            gameKey,
            matchId,
            opponentId,
            outcome,
            before,
            after,
            delta,
          ] = params.slice(i, i + 8);
          state.events.push({
            user_id: userId,
            game_key: gameKey,
            match_id: matchId,
            opponent_id: opponentId,
            outcome,
            trophies_before: before,
            trophies_after: after,
            delta,
          });
        }
        return { rows: [], rowCount: 2 };
      }

      throw new Error(`FakeDb: unrecognised statement -> ${sql}`);
    },
  };

  const writes = () =>
    state.statements.filter(
      (s) =>
        /^UPDATE player_trophies/i.test(s.sql) ||
        /^INSERT INTO trophy_identities/i.test(s.sql) ||
        /^INSERT INTO trophy_events/i.test(s.sql),
    );

  const eventsFor = (gameKey) => state.events.filter((e) => e.game_key === gameKey);

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

test("config: a ranked win is +30, a loss −30, a draw 0", () => {
  assert.equal(TROPHY_WIN, 30);
  assert.equal(TROPHY_LOSS, -30);
  assert.equal(TROPHY_DRAW, 0);
  assert.equal(TROPHY_START, 0);
  assert.equal(TROPHY_MIN, 0);
  assert.equal(TROPHY_MAX, 1000);
  assert.equal(TROPHY_CONFIG.win, 30);
  assert.equal(TROPHY_CONFIG.loss, -30);
  assert.equal(TROPHY_CONFIG.max, 1000);
  // 19 rated games × 1,000 = 19,000 additive overall maximum (Poker's removal
  // took the 20th game out, and the Battle Pass is derived from this value).
  assert.equal(TROPHY_CONFIG.overallMax, 19000);
  assert.equal(TROPHY_CONFIG.gameCount, 19);
  assert.deepEqual([...TROPHY_OUTCOMES], ["win", "loss", "draw"]);
});

test("registry: trophies use EXACTLY the Elo game set (no drift)", () => {
  assert.deepEqual([...TROPHY_GAMES], [...RATED_GAMES]);
  assert.equal(TROPHY_GAMES.length, 19);
  assert.equal(isTrophyGame("chess"), true);
  assert.equal(isTrophyGame("precision"), true);
  // The 6 formerly-excluded games are now REGISTERED (their trophy/rating
  // distribution is wired later), so they are trophy games here too.
  assert.equal(isTrophyGame("hex-duel"), true);
  assert.equal(isTrophyGame("uno"), true);
  // Poker was removed from the game entirely — it must no longer be a trophy
  // game, which is also what keeps OVERALL_TROPHY_MAX honest.
  assert.equal(isTrophyGame("poker"), false);
  assert.equal(normalizeTrophyGameKey("nope"), RATED_GAMES[0]);
  assert.equal(getTrophyGameLabel("pool"), "Pool Masters");
});

// ════════════════════════════════════════════════════════════════════════
// 2. The rule
// ════════════════════════════════════════════════════════════════════════

test("trophyDeltaForOutcome: win +30, loss −30, draw 0, unknown 0", () => {
  assert.equal(trophyDeltaForOutcome("win"), 30);
  assert.equal(trophyDeltaForOutcome("loss"), -30);
  assert.equal(trophyDeltaForOutcome("draw"), 0);
  assert.equal(trophyDeltaForOutcome("destroyed"), 0);
  assert.equal(isValidTrophyOutcome("win"), true);
  assert.equal(isValidTrophyOutcome("loss"), true);
  assert.equal(isValidTrophyOutcome("draw"), true);
  assert.equal(isValidTrophyOutcome("destroyed"), false);
});

test("applyTrophyDelta: a win adds 30 from 0", () => {
  const r = applyTrophyDelta(0, "win");
  assert.equal(r.before, 0);
  assert.equal(r.after, 30);
  assert.equal(r.delta, 30);
  assert.equal(r.clamped, false);
});

test("applyTrophyDelta: a loss subtracts 30", () => {
  const r = applyTrophyDelta(100, "loss");
  assert.equal(r.after, 70);
  assert.equal(r.delta, -30);
  assert.equal(r.clamped, false);
});

test("applyTrophyDelta: a draw never moves the count", () => {
  for (const start of [0, 30, 500, 1000]) {
    const r = applyTrophyDelta(start, "draw");
    assert.equal(r.before, start);
    assert.equal(r.after, start);
    assert.equal(r.delta, 0);
    assert.equal(r.clamped, false);
  }
});

test("applyTrophyDelta: the count can never go below 0", () => {
  const atZero = applyTrophyDelta(0, "loss");
  assert.equal(atZero.before, 0);
  assert.equal(atZero.after, 0);
  assert.equal(atZero.delta, 0); // the real applied delta, not the nominal −30
  assert.equal(atZero.nominalDelta, -30);
  assert.equal(atZero.clamped, true);

  // 10 trophies minus 30 floors at 0, applying only −10.
  const nearZero = applyTrophyDelta(10, "loss");
  assert.equal(nearZero.after, 0);
  assert.equal(nearZero.delta, -10);
  assert.equal(nearZero.clamped, true);
});

test("applyTrophyDelta: the count can never exceed 1,000", () => {
  const atCap = applyTrophyDelta(1000, "win");
  assert.equal(atCap.before, 1000);
  assert.equal(atCap.after, 1000);
  assert.equal(atCap.delta, 0);
  assert.equal(atCap.nominalDelta, 30);
  assert.equal(atCap.clamped, true);

  // 990 plus 30 caps at 1,000, applying only +10.
  const nearCap = applyTrophyDelta(990, "win");
  assert.equal(nearCap.after, 1000);
  assert.equal(nearCap.delta, 10);
  assert.equal(nearCap.clamped, true);
});

test("clampTrophies: floor, cap and garbage input", () => {
  assert.equal(clampTrophies(-500), 0);
  assert.equal(clampTrophies(0), 0);
  assert.equal(clampTrophies(432), 432);
  assert.equal(clampTrophies(999999), 1000);
  assert.equal(clampTrophies("nope"), 0); // never NaN
  assert.equal(clampTrophies(undefined), 0);
});

// ════════════════════════════════════════════════════════════════════════
// 3. A whole match
// ════════════════════════════════════════════════════════════════════════

test("computeMatchTrophies: a win moves +30 / −30 independently of the gap", () => {
  const r = computeMatchTrophies({ winnerTrophies: 100, loserTrophies: 300 });
  assert.equal(r.result, "win");
  assert.equal(r.winner.delta, 30);
  assert.equal(r.winner.after, 130);
  assert.equal(r.loser.delta, -30);
  assert.equal(r.loser.after, 270);
  // A flat rule ignores the size of the gap — unlike Elo. A 9000-gap win still
  // pays exactly +30, and a loser already at 0 cannot go negative.
  const lopsided = computeMatchTrophies({ winnerTrophies: 900, loserTrophies: 0 });
  assert.equal(lopsided.winner.delta, 30);
  assert.equal(lopsided.winner.after, 930);
  assert.equal(lopsided.loser.delta, 0);
  assert.equal(lopsided.loser.after, 0);
});

test("computeMatchTrophies: a draw moves neither side", () => {
  const r = computeMatchTrophies({
    winnerTrophies: 600,
    loserTrophies: 600,
    result: "draw",
  });
  assert.equal(r.result, "draw");
  assert.equal(r.winner.delta, 0);
  assert.equal(r.loser.delta, 0);
  assert.equal(r.winner.after, 600);
  assert.equal(r.loser.after, 600);
});

// ════════════════════════════════════════════════════════════════════════
// 4. Phase + derived Prestige
// ════════════════════════════════════════════════════════════════════════

test("phase: below the cap trophies lead; at the cap Elo leads", () => {
  assert.equal(isTrophyComplete(999), false);
  assert.equal(isTrophyComplete(1000), true);
  assert.equal(trophyPhase(0), "trophies");
  assert.equal(trophyPhase(999), "trophies");
  assert.equal(trophyPhase(1000), "elo");
});

test("prestigeFromRating: prestige IS the Elo value (starts at 1000)", () => {
  assert.equal(prestigeFromRating(1000), 1000);
  assert.equal(prestigeFromRating(1100), 1100);
  assert.equal(prestigeFromRating(1500), 1500);
  assert.equal(prestigeFromRating(2000), 2000);
  assert.equal(prestigeFromRating(900), 900);
  assert.equal(prestigeFromRating(0), 0);
  // Non-finite falls back to the 1000 baseline.
  assert.equal(prestigeFromRating(undefined), 1000);
});

test("trophyProgress: the exact fields the UI reads", () => {
  const fresh = trophyProgress(0);
  assert.equal(fresh.trophies, 0);
  assert.equal(fresh.maxTrophies, 1000);
  assert.equal(fresh.remaining, 1000);
  assert.equal(fresh.progressPercent, 0);
  assert.equal(fresh.complete, false);
  assert.equal(fresh.phase, "trophies");

  const mid = trophyProgress(250);
  assert.equal(mid.remaining, 750);
  assert.equal(mid.progressPercent, 25);
  assert.equal(mid.phase, "trophies");

  const done = trophyProgress(1000);
  assert.equal(done.remaining, 0);
  assert.equal(done.progressPercent, 100);
  assert.equal(done.complete, true);
  assert.equal(done.phase, "elo");
});

test("toTrophyShape: normalizes a row (camelCase and snake_case)", () => {
  const shape = toTrophyShape("chess", {
    trophies: 700,
    peak_trophies: 900,
    games_rated: 12,
    wins: 6,
    losses: 5,
    draws: 1,
    lastDelta: 30,
    last_trophy_at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(shape.gameKey, "chess");
  assert.equal(shape.label, "Chess");
  assert.equal(shape.trophies, 700);
  assert.equal(shape.peakTrophies, 900);
  assert.equal(shape.gamesRated, 12);
  assert.equal(shape.games, 11); // decided = wins + losses
  assert.equal(shape.winRate, 54.55);
  assert.equal(shape.lastDelta, 30);
  assert.equal(shape.maxTrophies, 1000);
  assert.equal(shape.phase, "trophies");
});

// ════════════════════════════════════════════════════════════════════════
// 5. Writer: the happy paths
// ════════════════════════════════════════════════════════════════════════

test("WRITER WIN: creates both rows at 0, applies +30 / −30, journals both", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  const result = await applyTrophyResult({ tx: db.tx, ...WIN_ARGS });

  assert.equal(result.applied, true);
  assert.equal(result.result, "win");
  assert.equal(result.winner.trophiesBefore, 0);
  assert.equal(result.winner.trophiesAfter, 30);
  assert.equal(result.winner.delta, 30);
  assert.equal(result.loser.trophiesBefore, 0);
  assert.equal(result.loser.trophiesAfter, 0);
  assert.equal(result.loser.delta, 0); // floored at 0

  assert.equal(db.state.trophies.get("11:chess").trophies, 30);
  assert.equal(db.state.trophies.get("11:chess").wins, 1);
  assert.equal(db.state.trophies.get("22:chess").trophies, 0);
  assert.equal(db.state.trophies.get("22:chess").losses, 1);

  const events = db.eventsFor("chess");
  assert.equal(events.length, 2);
  assert.equal(events[0].outcome, "win");
  assert.equal(events[0].trophies_after, 30);
  assert.equal(events[0].delta, 30);
  assert.equal(events[0].opponent_id, 22);
  assert.equal(events[1].outcome, "loss");
  assert.equal(events[1].delta, 0);
  assert.equal(events[1].opponent_id, 11);
});

test("WRITER DRAW: both journal rows say draw and neither count moves", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  const result = await applyTrophyResult({
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
  assert.equal(db.state.trophies.get("11:chess").wins, 0);
  assert.equal(db.state.trophies.get("11:chess").losses, 0);
  assert.equal(db.state.trophies.get("11:chess").draws, 1);
  assert.equal(db.state.trophies.get("22:chess").draws, 1);
});

test("WRITER: a second match uses the stored count, not 0 again", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  await applyTrophyResult({ tx: db.tx, ...WIN_ARGS });
  const second = await applyTrophyResult({
    tx: db.tx,
    ...WIN_ARGS,
    matchId: "match-2",
  });
  assert.equal(second.winner.trophiesBefore, 30);
  assert.equal(second.winner.trophiesAfter, 60);
  assert.equal(db.state.trophies.get("11:chess").games_rated, 2);
});

test("WRITER: independent games keep independent counts", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  await applyTrophyResult({ tx: db.tx, ...WIN_ARGS, gameKey: "chess" });
  assert.equal(db.state.trophies.has("11:chess"), true);
  assert.equal(db.state.trophies.has("11:precision"), false);

  const precision = await applyTrophyResult({
    tx: db.tx,
    ...WIN_ARGS,
    gameKey: "precision",
    matchId: "precision-1",
  });
  assert.equal(precision.winner.trophiesBefore, 0); // a fresh ladder
  assert.equal(db.state.trophies.get("11:chess").trophies, 30); // untouched
});

// ════════════════════════════════════════════════════════════════════════
// 6. Writer: duplicate protection
// ════════════════════════════════════════════════════════════════════════

test("TEST DUPLICATE RESULT: the second settlement writes nothing at all", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  const first = await applyTrophyResult({ tx: db.tx, ...WIN_ARGS });
  assert.equal(first.applied, true);

  const afterFirst = db.state.trophies.get("11:chess").trophies;
  const eventsAfterFirst = db.eventsFor("chess").length;
  const writesAfterFirst = db.writes().length;
  // 2 trophy UPDATEs + 2 identity mirrors + 1 journal INSERT.
  assert.equal(writesAfterFirst, 5);

  const second = await applyTrophyResult({ tx: db.tx, ...WIN_ARGS });
  assert.equal(second.applied, false);
  assert.equal(second.reason, "duplicate");
  assert.equal(db.writes().length, writesAfterFirst);
  assert.equal(db.state.trophies.get("11:chess").trophies, afterFirst);
  assert.equal(db.eventsFor("chess").length, eventsAfterFirst);
});

test("TEST DUPLICATE RESULT: an already-journaled match is refused before any write", async () => {
  const db = makeFakeDb({
    users: TWO_USERS,
    seededEvents: [
      { user_id: 11, game_key: "chess", match_id: "match-1", outcome: "win" },
    ],
  });
  const result = await applyTrophyResult({ tx: db.tx, ...WIN_ARGS });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "duplicate");
  assert.equal(db.writes().length, 0);
});

test("TEST DUPLICATE RESULT: a different match still moves trophies", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  await applyTrophyResult({ tx: db.tx, ...WIN_ARGS });
  const other = await applyTrophyResult({
    tx: db.tx,
    ...WIN_ARGS,
    matchId: "match-2",
  });
  assert.equal(other.applied, true);
});

// ════════════════════════════════════════════════════════════════════════
// 6b. The placement form of the rule (multi-seat tables)
// ════════════════════════════════════════════════════════════════════════

test("the placement ladder descends from +30 to −30 by rank", () => {
  assert.equal(placementDeltaForRank(1, 4), 30);
  assert.equal(placementDeltaForRank(2, 4), 10);
  assert.equal(placementDeltaForRank(3, 4), -10);
  assert.equal(placementDeltaForRank(4, 4), -30);
  // The bounds are the duel values, whichever way the table is read.
  assert.equal(PLACEMENT_TOP, TROPHY_WIN);
  assert.equal(PLACEMENT_BOTTOM, TROPHY_LOSS);
  assert.equal(placementDeltaForRank(1, 6), PLACEMENT_TOP);
  assert.equal(placementDeltaForRank(6, 6), PLACEMENT_BOTTOM);
  // A one-seat table has nothing to trade against.
  assert.equal(placementDeltaForRank(1, 1), 0);
  assert.deepEqual(placementLadder(1), []);
});

test("every table size yields a descending, zero-sum integer ladder", () => {
  // A table redistributes trophies: it must never mint or burn them.
  assert.deepEqual(placementLadder(2), [30, -30]);
  assert.deepEqual(placementLadder(3), [30, 0, -30]);
  assert.deepEqual(placementLadder(4), [30, 10, -10, -30]);
  assert.deepEqual(placementLadder(5), [30, 15, 0, -15, -30]);
  assert.deepEqual(placementLadder(6), [30, 18, 6, -6, -18, -30]);

  for (let seats = 2; seats <= 12; seats += 1) {
    const ladder = placementLadder(seats);
    assert.equal(ladder.length, seats);
    assert.equal(
      ladder.reduce((sum, delta) => sum + delta, 0),
      0,
      `${seats}-seat ladder must be zero-sum`,
    );
    assert.equal(ladder[0], PLACEMENT_TOP);
    assert.equal(ladder[seats - 1], PLACEMENT_BOTTOM);
    for (let i = 1; i < seats; i += 1) {
      assert.ok(
        ladder[i] < ladder[i - 1],
        `${seats}-seat ladder must descend at rank ${i + 1}`,
      );
    }
  }
});

test("computePlacementTrophies: each seat gets its rung of the ladder", () => {
  const r = computePlacementTrophies({ groups: [[500], [500], [40], [0]] });
  assert.equal(r.result, "placement");
  assert.equal(r.seatCount, 4);
  assert.deepEqual(r.ladder, [30, 10, -10, -30]);
  assert.deepEqual(r.nominalDeltas, [30, 10, -10, -30]);
  assert.deepEqual(
    r.seats.map((s) => s.delta),
    [30, 10, -10, 0],
  );
  assert.deepEqual(
    r.seats.map((s) => s.after),
    [530, 510, 30, 0],
  );
  assert.deepEqual(r.seats.map((s) => s.clamped), [false, false, false, true]);
  // The bottom seat was on the floor: it is still given the −30 rung, but the
  // clamp means it actually moves nothing.
  assert.equal(r.seats[3].nominalDelta, -30);
  assert.equal(r.seats[3].delta, 0);
  // Placements are 1-based, best first.
  assert.deepEqual(r.seats.map((s) => s.place), [1, 2, 3, 4]);
});

test("computePlacementTrophies: tied seats share the ranks they span", () => {
  // 2nd and 3rd of four are level → each reads the mean of +10 and −10.
  const r = computePlacementTrophies({ groups: [[100], [100, 100], [100]] });
  assert.deepEqual(r.nominalDeltas, [30, 0, 0, -30]);
  assert.deepEqual(r.seats.map((s) => s.place), [1, 2, 2, 4]);
  assert.deepEqual(r.seats.map((s) => s.placeTo), [1, 3, 3, 4]);
  // Ties never break the zero sum, whichever seats are level.
  assert.equal(r.nominalDeltas.reduce((sum, d) => sum + d, 0), 0);

  // Crash Arena: one survivor and three players who crashed. The victims are
  // all level for last, so they share ranks 2..4: (10 − 10 − 30) / 3 = −10.
  const crash = computePlacementTrophies({ groups: [[100], [100, 100, 100]] });
  assert.deepEqual(crash.nominalDeltas, [30, -10, -10, -10]);
  assert.equal(crash.nominalDeltas.reduce((sum, d) => sum + d, 0), 0);
  assert.equal(crash.seats[1].place, 2);
  assert.equal(crash.seats[3].placeTo, 4);
});

test("computePlacementTrophies: a lone seat settles nothing", () => {
  const r = computePlacementTrophies({ groups: [[500]] });
  assert.equal(r.seatCount, 1);
  assert.deepEqual(r.seats, []);
  assert.deepEqual(r.nominalDeltas, []);
});

test("applyTrophyChange: an explicit delta clamps at the bounds like a duel", () => {
  // The ladder share is applied to the seat's OWN count, so a 2nd place at the
  // floor loses nothing and a 2nd place at the cap gains nothing.
  const floored = applyTrophyChange(0, -30);
  assert.equal(floored.delta, 0);
  assert.equal(floored.nominalDelta, -30);
  assert.equal(floored.clamped, true);
  const capped = applyTrophyChange(TROPHY_MAX, 30);
  assert.equal(capped.delta, 0);
  assert.equal(capped.clamped, true);
  const middle = applyTrophyChange(500, -10);
  assert.equal(middle.after, 490);
  assert.equal(middle.clamped, false);
});

const TABLE_USERS = [
  { id: 11, clerkId: "user_first", email: "first@grynd.test" },
  { id: 22, clerkId: "user_second", email: "second@grynd.test" },
  { id: 33, clerkId: "user_third", email: "third@grynd.test" },
  { id: 44, clerkId: "user_fourth", email: "fourth@grynd.test" },
];

const TABLE_ARGS = {
  gameKey: "crash-arena",
  matchId: "hand-1",
  placements: ["user_first", "user_second", "user_third", "user_fourth"],
};

/** Seed a player's trophy row for one game so a negative swing is observable. */
function seedTrophyRow(db, userId, gameKey, trophies) {
  db.state.trophies.set(`${userId}:${gameKey}`, {
    user_id: userId,
    game_key: gameKey,
    trophies,
    peak_trophies: trophies,
    games_rated: 1,
    wins: 0,
    losses: 0,
    draws: 0,
    last_delta: 0,
    last_trophy_at: null,
  });
}

test("PLACEMENT WRITER: the ladder pays +30/+10/−10/−30 across a 4-seat table", async () => {
  const db = makeFakeDb({ users: TABLE_USERS });
  // Seed distinct counts so every rung of the ladder is observable — a seat on
  // the floor legitimately moves 0, which would hide the share it was given.
  seedTrophyRow(db, 11, "crash-arena", 500);
  seedTrophyRow(db, 22, "crash-arena", 500);
  seedTrophyRow(db, 33, "crash-arena", 140);
  seedTrophyRow(db, 44, "crash-arena", 20);

  const result = await applyPlacementTrophies({ tx: db.tx, ...TABLE_ARGS });
  assert.equal(result.applied, true);
  assert.equal(result.result, "placement");
  assert.equal(result.winner.userId, 11);
  assert.equal(result.winner.delta, 30);
  assert.equal(result.winner.trophiesAfter, 530);

  // `places` is the whole finishing order, best first.
  assert.equal(result.places.length, 4);
  assert.deepEqual(result.places.map((p) => p.userId), [11, 22, 33, 44]);
  assert.deepEqual(result.places.map((p) => p.place), [1, 2, 3, 4]);
  assert.deepEqual(result.places.map((p) => p.nominalDelta), [30, 10, -10, -30]);
  // The bottom seat only had 20, so its −30 is cut short to −20 (and flagged).
  assert.deepEqual(result.places.map((p) => p.delta), [30, 10, -10, -20]);
  assert.deepEqual(result.places.map((p) => p.clamped), [false, false, false, true]);
  assert.deepEqual(result.places.map((p) => p.trophiesAfter), [530, 510, 130, 0]);

  // Only first place is a WIN; every other seat lost the table, even the one
  // the ladder still paid for placing 2nd.
  assert.equal(db.state.trophies.get("11:crash-arena").wins, 1);
  assert.equal(db.state.trophies.get("11:crash-arena").losses, 0);
  for (const userId of [22, 33, 44]) {
    assert.equal(db.state.trophies.get(`${userId}:crash-arena`).losses, 1);
    assert.equal(db.state.trophies.get(`${userId}:crash-arena`).wins, 0);
  }

  // One journal row per human seat, all on the same match id.
  const events = db.eventsFor("crash-arena").filter((e) => e.match_id === "hand-1");
  assert.equal(events.length, 4);
  assert.equal(events.filter((e) => e.outcome === "win").length, 1);
  assert.equal(events.filter((e) => e.outcome === "loss").length, 3);
  assert.deepEqual(
    events.map((e) => e.delta),
    [30, 10, -10, -20],
  );
  // The winner's opponent reference is the runner-up; every loser points at the
  // seat that beat them.
  assert.equal(events.find((e) => e.outcome === "win").opponent_id, 22);
  for (const loss of events.filter((e) => e.outcome === "loss")) {
    assert.equal(loss.opponent_id, 11);
  }
});

test("PLACEMENT WRITER: tied seats share the average of the ranks they span", async () => {
  const db = makeFakeDb({ users: TABLE_USERS });
  for (const user of TABLE_USERS) seedTrophyRow(db, user.id, "crash-arena", 100);

  // One survivor (rank 1) and the three players who crashed, all level for
  // last: they share ranks 2..4 → (10 − 10 − 30) / 3 = −10 each.
  const result = await applyPlacementTrophies({
    tx: db.tx,
    ...TABLE_ARGS,
    placements: [["user_first"], ["user_second", "user_third", "user_fourth"]],
  });
  assert.equal(result.applied, true);
  assert.deepEqual(result.places.map((p) => p.nominalDelta), [30, -10, -10, -10]);
  assert.deepEqual(result.places.map((p) => p.place), [1, 2, 2, 2]);
  assert.deepEqual(result.places.map((p) => p.placeTo), [1, 4, 4, 4]);
  assert.deepEqual(result.places.map((p) => p.delta), [30, -10, -10, -10]);
  // The tied group banked nothing collectively: the ladder still sums to zero.
  assert.equal(result.places.reduce((sum, p) => sum + p.nominalDelta, 0), 0);
});

test("PLACEMENT WRITER: a bare id list is read as a clean 1..N order", async () => {
  const db = makeFakeDb({ users: TABLE_USERS });
  const result = await applyPlacementTrophies({
    tx: db.tx,
    ...TABLE_ARGS,
    placements: ["user_fourth", "user_third", "user_second", "user_first"],
  });
  assert.equal(result.applied, true);
  assert.deepEqual(result.places.map((p) => p.userId), [44, 33, 22, 11]);
  assert.equal(result.places[0].nominalDelta, 30);
  assert.equal(result.places[3].nominalDelta, -30);
});

test("PLACEMENT WRITER: replaying the same table writes nothing", async () => {
  const db = makeFakeDb({ users: TABLE_USERS });
  await applyPlacementTrophies({ tx: db.tx, ...TABLE_ARGS });
  const writesAfterFirst = db.writes().length;

  const second = await applyPlacementTrophies({ tx: db.tx, ...TABLE_ARGS });
  assert.equal(second.applied, false);
  assert.equal(second.reason, "duplicate");
  assert.equal(db.writes().length, writesAfterFirst);
  assert.equal(db.eventsFor("crash-arena").length, 4);
});

test("PLACEMENT WRITER: a partial replay is refused for the whole table", async () => {
  const db = makeFakeDb({ users: TABLE_USERS });
  await applyPlacementTrophies({ tx: db.tx, ...TABLE_ARGS });
  const writesAfterFirst = db.writes().length;

  // One seat already journaled this match → the others must NOT be moved
  // again either, or a table could be settled twice for three players.
  const replay = await applyPlacementTrophies({
    tx: db.tx,
    ...TABLE_ARGS,
    placements: ["user_first", "user_second"],
  });
  assert.equal(replay.applied, false);
  assert.equal(replay.reason, "duplicate");
  assert.equal(db.writes().length, writesAfterFirst);
});

test("PLACEMENT WRITER: malformed tables are refused before any write", async () => {
  const cases = [
    [{ placements: [] }, "missing-player"],
    [{ placements: undefined }, "missing-player"],
    [{ placements: ["user_first"] }, "missing-player"],
    [{ placements: ["user_first", ""] }, "missing-player"],
    [{ placements: [["user_first"], []] }, "missing-player"],
    [{ placements: ["user_first", "user_first"] }, "same-player"],
    [{ placements: [["user_first", "user_second"], ["user_second"]] }, "same-player"],
    [{ gameKey: "not-a-game" }, "game-not-rated"],
    [{ matchId: "" }, "invalid-match-id"],
    [{ placements: ["user_first", "user_ghost"] }, "user-not-found"],
  ];
  for (const [override, reason] of cases) {
    const db = makeFakeDb({ users: TABLE_USERS });
    const result = await applyPlacementTrophies({
      tx: db.tx,
      ...TABLE_ARGS,
      ...override,
    });
    assert.equal(result.applied, false, `${reason} case must be refused`);
    assert.equal(result.reason, reason);
    assert.equal(db.writes().length, 0);
  }
});

test("PLACEMENT WRITER: the ladder share can never come from the caller", async () => {
  const db = makeFakeDb({ users: TABLE_USERS });
  // A forged delta/nominalDelta on the args object must change nothing: the
  // ladder is built from the counts read inside the lock.
  const result = await applyPlacementTrophies({
    tx: db.tx,
    ...TABLE_ARGS,
    winnerTrophies: 9999,
    loserTrophies: 9999,
    delta: 500,
    nominalDelta: 500,
  });
  assert.equal(result.applied, true);
  assert.deepEqual(result.places.map((p) => p.nominalDelta), [30, 10, -10, -30]);
  assert.equal(db.state.trophies.get("11:crash-arena").trophies, 30);
  // The unseeded seats start at 0, so both losses clamp to nothing.
  assert.equal(db.state.trophies.get("33:crash-arena").trophies, 0);
  assert.equal(db.state.trophies.get("44:crash-arena").trophies, 0);
});

// ════════════════════════════════════════════════════════════════════════
// 7. Writer: unauthorized / malformed input
// ════════════════════════════════════════════════════════════════════════

test("TEST UNAUTHORIZED: a non-rated game can never move trophies", async () => {
  for (const gameKey of ["not-a-game", ""]) {
    const db = makeFakeDb({ users: TWO_USERS });
    const result = await applyTrophyResult({ tx: db.tx, ...WIN_ARGS, gameKey });
    assert.equal(result.applied, false, `game ${gameKey} must not award trophies`);
    assert.equal(db.writes().length, 0);
  }
});

test("TEST UNAUTHORIZED: a player cannot award themselves trophies", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  const result = await applyTrophyResult({
    tx: db.tx,
    ...WIN_ARGS,
    loserClerkId: "user_winner",
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "same-player");
  assert.equal(db.writes().length, 0);
});

test("TEST UNAUTHORIZED: a half match is refused", async () => {
  for (const bad of [
    { winnerClerkId: null },
    { loserClerkId: null },
    { winnerClerkId: "" },
    { loserClerkId: undefined },
  ]) {
    const db = makeFakeDb({ users: TWO_USERS });
    const result = await applyTrophyResult({ tx: db.tx, ...WIN_ARGS, ...bad });
    assert.equal(result.applied, false);
    assert.equal(db.writes().length, 0);
  }
});

test("TEST UNAUTHORIZED: a bad match id is refused", async () => {
  for (const matchId of ["", null, undefined, "x".repeat(200)]) {
    const db = makeFakeDb({ users: TWO_USERS });
    const result = await applyTrophyResult({ tx: db.tx, ...WIN_ARGS, matchId });
    assert.equal(result.applied, false);
    assert.equal(result.reason, "invalid-match-id");
    assert.equal(db.writes().length, 0);
  }
});

test("TEST UNAUTHORIZED: unknown players are refused", async () => {
  const db = makeFakeDb({ users: [{ id: 11, clerkId: "user_winner" }] });
  const result = await applyTrophyResult({ tx: db.tx, ...WIN_ARGS });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "user-not-found");
  assert.equal(db.writes().length, 0);
});

test("TEST UNAUTHORIZED: trophy values are never taken from arguments", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  const result = await applyTrophyResult({
    tx: db.tx,
    ...WIN_ARGS,
    trophies: 9999,
    winnerTrophies: 9999,
    loserTrophies: 9999,
    delta: 500,
    outcome: "win",
  });
  assert.equal(result.applied, true);
  assert.equal(result.winner.trophiesBefore, 0); // not the smuggled value
  assert.equal(result.winner.trophiesAfter, 30); // +30, not 9999
  assert.equal(result.winner.delta, 30); // not the smuggled 500
});

test("TEST UNAUTHORIZED: win/draw are the only outcomes the writer accepts", async () => {
  const db = makeFakeDb({ users: TWO_USERS });
  const result = await applyTrophyResult({
    tx: db.tx,
    ...WIN_ARGS,
    result: "loss", // nonsense for the winner — normalized to a win
  });
  assert.equal(result.result, "win");
  assert.equal(result.winner.delta, 30);
});

// ════════════════════════════════════════════════════════════════════════
// 8. Writer: cap behaviour
// ════════════════════════════════════════════════════════════════════════

test("WRITER CAP: a win at 1,000 stays at 1,000 and reports the cap", async () => {
  const db = makeFakeDb({
    users: TWO_USERS,
    seededEvents: [],
  });
  // Seed a near-cap row directly through the fake state.
  db.state.trophies.set("11:chess", {
    user_id: 11,
    game_key: "chess",
    trophies: 1000,
    peak_trophies: 1000,
    games_rated: 400,
    wins: 350,
    losses: 50,
    draws: 0,
    last_delta: 0,
    last_trophy_at: null,
  });

  const result = await applyTrophyResult({ tx: db.tx, ...WIN_ARGS });
  assert.equal(result.applied, true);
  assert.equal(result.winner.trophiesBefore, 1000);
  assert.equal(result.winner.trophiesAfter, 1000);
  assert.equal(result.winner.delta, 0);
  assert.equal(result.winner.complete, true);
  assert.equal(result.winner.phase, "elo");
});

// ════════════════════════════════════════════════════════════════════════
// 9. Anti-reset identity ledger
// ════════════════════════════════════════════════════════════════════════

test("TEST RESET PREVENTION: re-registering restores the trophy count", async () => {
  const first = makeFakeDb({ users: TWO_USERS });
  for (let i = 0; i < 5; i += 1) {
    await applyTrophyResult({
      tx: first.tx,
      ...WIN_ARGS,
      matchId: `m-${i}`,
    });
  }
  assert.equal(first.state.trophies.get("11:chess").trophies, 150);

  // The identity ledger holds the snapshot keyed by the email digest.
  const winnerHash = identityHashForEmail("winner@grynd.test");
  assert.equal(first.state.identities.get(`${winnerHash}:chess`).trophies, 150);

  // "Delete + re-register": a brand-new users row, same email (the opponent
  // is a fresh account too, since the match still needs two distinct users).
  const second = makeFakeDb({
    users: [
      { id: 99, clerkId: "user_new", email: "winner@grynd.test" },
      { id: 100, clerkId: "user_rival", email: "rival@grynd.test" },
    ],
    seededIdentities: [...first.state.identities.entries()],
  });
  const restored = await applyTrophyResult({
    tx: second.tx,
    gameKey: "chess",
    matchId: "re-1",
    winnerClerkId: "user_new",
    loserClerkId: "user_rival",
  });
  assert.equal(restored.applied, true);
  assert.equal(restored.winner.trophiesBefore, 150); // restored, not 0
  assert.equal(restored.winner.trophiesAfter, 180);
});

// ════════════════════════════════════════════════════════════════════════
// 10. Schema, migrations, invariants
// ════════════════════════════════════════════════════════════════════════

test("SCHEMA: player_trophies + trophy_events + trophy_identities are declared", () => {
  const schema = fs.readFileSync("src/db/schema.ts", "utf8");
  assert.match(schema, /export const playerTrophies = pgTable\(\s*"player_trophies"/);
  assert.match(schema, /export const trophyEvents = pgTable\(\s*"trophy_events"/);
  assert.match(schema, /export const trophyIdentities = pgTable\(\s*"trophy_identities"/);
});

test("MIGRATION: 0173/0174/0175 are present and registered in the drizzle journal", () => {
  const journal = JSON.parse(
    fs.readFileSync("src/db/migrations/meta/_journal.json", "utf8"),
  );
  const tags = journal.entries.map((e) => e.tag);
  assert.ok(tags.includes("0173_player_trophies"), "0173 must be journaled");
  assert.ok(tags.includes("0174_trophy_events"), "0174 must be journaled");
  assert.ok(tags.includes("0175_trophy_identities"), "0175 must be journaled");

  for (const file of [
    "src/db/migrations/0173_player_trophies.sql",
    "src/db/migrations/0174_trophy_events.sql",
    "src/db/migrations/0175_trophy_identities.sql",
  ]) {
    assert.ok(fs.existsSync(file), `${file} must exist`);
  }
  // The cap must be enforced at the database level too. 0177 lowers it to 1,000.
  const table = fs.readFileSync(
    "src/db/migrations/0177_trophy_cap_and_prestige_regate.sql",
    "utf8",
  );
  assert.match(table, /trophies.*<= 1000|<= 1000.*trophies/s);
});

test("INVARIANT: trophies.js never imports the economy/XP/battlepass modules", () => {
  // Strip comments first — the prose deliberately NAMES these systems to
  // document that they are excluded, which would otherwise trip the scan.
  const src = fs
    .readFileSync("src/lib/trophies.js", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /battlepass|shopItems|tokens|stripe|vipLevels/i);
  // It must reuse the Elo registry rather than define its own game list.
  assert.match(src, /from "\.\/rating"/);
  assert.match(src, /RATED_GAMES/);
});

test("SECURITY: only src/lib/trophyStore.js writes the trophy tables", () => {
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
      if (full === "src/lib/trophyStore.js") continue;
      if (full === "src/db/schema.ts") continue;
      if (/_(player_trophies|trophy_events|trophy_identities)\.sql$/.test(full)) continue;
      const src = fs.readFileSync(full, "utf8");
      if (
        /INSERT INTO player_trophies|UPDATE player_trophies|INSERT INTO trophy_events|INSERT INTO trophy_identities|UPDATE trophy_identities/i.test(
          src,
        )
      ) {
        offenders.push(full);
      }
    }
  };
  for (const dir of ["src"]) walk(dir);

  assert.deepEqual(
    offenders,
    [],
    `trophy tables must only be written by src/lib/trophyStore.js; found: ${offenders.join(", ")}`,
  );

  // The anti-reset ledger must NOT be erased by account deletion.
  const purgeCode = fs
    .readFileSync("src/lib/security/deleteUserData.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(
    purgeCode,
    /trophyIdentities|trophy_identities/i,
    "the account purge must not delete the trophy identity ledger",
  );
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
  // The multi-seat tables use the placement form of the SAME ±30 (first place
  // wins, every other human seat loses), which is a separate writer because it
  // settles N seats in one idempotent journal write.
  ["crash-arena", "src/lib/crash-poker/settleHand.ts", "applyPlacementTrophies"],
  ["tower-arena", "src/lib/tower-arena/serverStore.ts", "applyPlacementTrophies"],
  ["uno", "src/app/api/uno/multiplayer/route.js", "applyPlacementTrophies"],
  // Roulette is a duel (two seats), so it uses the original 1v1 writer.
  ["roulette-pvp", "src/lib/roulette-pvp/serverStore.js"],
];

for (const [gameKey, file, writer = "applyTrophyResult"] of WIRING) {
  test(`WIRING: ${file} feeds the ${gameKey} trophies`, () => {
    const src = fs.readFileSync(file, "utf8");
    assert.match(
      src,
      new RegExp(`import\\s*\\{[^}]*${writer}[^}]*\\}`),
      `${file} must import ${writer}`,
    );
    assert.match(
      src,
      new RegExp(`${writer}\\(\\{`),
      `${file} must call ${writer}`,
    );
    assert.match(
      src,
      new RegExp(`gameKey:\\s*"${gameKey}"`),
      `${file} must award trophies for gameKey "${gameKey}"`,
    );
  });
}

test("WIRING: trophies are wired into exactly the rated settlements", () => {
  const files = new Set(WIRING.map(([, file]) => file));
  // A file that rates must also award trophies, and vice-versa.
  for (const [gameKey, file] of WIRING) {
    const src = fs.readFileSync(file, "utf8");
    assert.match(
      src,
      new RegExp(`gameKey:\\s*"${gameKey}"`),
      `${file} must still rate ${gameKey}`,
    );
  }
  // Nothing may award trophies for a game that is not rated.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      if (files.has(full)) continue;
      if (full === "src/lib/trophyStore.js" || full === "src/lib/trophies.js") continue;
      const src = fs.readFileSync(full, "utf8");
      // BOTH writers: a settlement that is not in the list above is drift, and
      // a game can only be settled by one of the two.
      if (/applyTrophyResult\(\{|applyPlacementTrophies\(\{/.test(src)) {
        offenders.push(full);
      }
    }
  };
  walk("src");
  assert.deepEqual(offenders, [], `unexpected applyTrophyResult callers: ${offenders.join(", ")}`);
});

test("REGRESSION: the trophy writer never writes the Elo tables", () => {
  // Strip comments (the module prose names the Elo tables to explain that the
  // identity digest is shared, which is not a write).
  const src = fs
    .readFileSync("src/lib/trophyStore.js", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /(INSERT INTO|UPDATE) (player_ratings|rating_events|rating_identities)/i);
});
