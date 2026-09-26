/**
 * trophy-system.test.mjs
 *
 * Tests for the per-game GRYND trophy system:
 *   * src/lib/trophies.js    — the pure, configurable rule (+30 / −30 / 0) and
 *                              the derived Prestige view of Elo
 *   * the floor (0) and cap (10,000) behaviour
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
  computeMatchTrophies,
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
      if (/^SELECT 1 AS hit FROM trophy_events/i.test(sql)) {
        const [gameKey, matchId, a, b] = params;
        const hit = state.events.some(
          (e) =>
            e.game_key === gameKey &&
            e.match_id === matchId &&
            (e.user_id === a || e.user_id === b),
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

      // ── journal inserts (two rows per match) ─────────────────────
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
  assert.equal(TROPHY_MAX, 10000);
  assert.equal(TROPHY_CONFIG.win, 30);
  assert.equal(TROPHY_CONFIG.loss, -30);
  assert.equal(TROPHY_CONFIG.max, 10000);
  assert.deepEqual([...TROPHY_OUTCOMES], ["win", "loss", "draw"]);
});

test("registry: trophies use EXACTLY the Elo game set (no drift)", () => {
  assert.deepEqual([...TROPHY_GAMES], [...RATED_GAMES]);
  assert.equal(TROPHY_GAMES.length, 14);
  assert.equal(isTrophyGame("chess"), true);
  assert.equal(isTrophyGame("precision"), true);
  assert.equal(isTrophyGame("hex-duel"), false); // client-supplied winner
  assert.equal(isTrophyGame("uno"), false); // multi-player
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
  for (const start of [0, 30, 5000, 10000]) {
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

test("applyTrophyDelta: the count can never exceed 10,000", () => {
  const atCap = applyTrophyDelta(10000, "win");
  assert.equal(atCap.before, 10000);
  assert.equal(atCap.after, 10000);
  assert.equal(atCap.delta, 0);
  assert.equal(atCap.nominalDelta, 30);
  assert.equal(atCap.clamped, true);

  // 9,990 plus 30 caps at 10,000, applying only +10.
  const nearCap = applyTrophyDelta(9990, "win");
  assert.equal(nearCap.after, 10000);
  assert.equal(nearCap.delta, 10);
  assert.equal(nearCap.clamped, true);
});

test("clampTrophies: floor, cap and garbage input", () => {
  assert.equal(clampTrophies(-500), 0);
  assert.equal(clampTrophies(0), 0);
  assert.equal(clampTrophies(4321), 4321);
  assert.equal(clampTrophies(999999), 10000);
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
  const lopsided = computeMatchTrophies({ winnerTrophies: 9000, loserTrophies: 0 });
  assert.equal(lopsided.winner.delta, 30);
  assert.equal(lopsided.winner.after, 9030);
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
  assert.equal(isTrophyComplete(9999), false);
  assert.equal(isTrophyComplete(10000), true);
  assert.equal(trophyPhase(0), "trophies");
  assert.equal(trophyPhase(9999), "trophies");
  assert.equal(trophyPhase(10000), "elo");
});

test("prestigeFromRating: prestige = max(0, elo − 1000)", () => {
  assert.equal(prestigeFromRating(1000), 0);
  assert.equal(prestigeFromRating(1100), 100);
  assert.equal(prestigeFromRating(1500), 500);
  assert.equal(prestigeFromRating(2000), 1000);
  // Defensive: below the starting rating or non-finite never goes negative.
  assert.equal(prestigeFromRating(900), 0);
  assert.equal(prestigeFromRating(0), 0);
  assert.equal(prestigeFromRating(undefined), 0);
});

test("trophyProgress: the exact fields the UI reads", () => {
  const fresh = trophyProgress(0);
  assert.equal(fresh.trophies, 0);
  assert.equal(fresh.maxTrophies, 10000);
  assert.equal(fresh.remaining, 10000);
  assert.equal(fresh.progressPercent, 0);
  assert.equal(fresh.complete, false);
  assert.equal(fresh.phase, "trophies");

  const mid = trophyProgress(2500);
  assert.equal(mid.remaining, 7500);
  assert.equal(mid.progressPercent, 25);
  assert.equal(mid.phase, "trophies");

  const done = trophyProgress(10000);
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
  assert.equal(shape.maxTrophies, 10000);
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
// 7. Writer: unauthorized / malformed input
// ════════════════════════════════════════════════════════════════════════

test("TEST UNAUTHORIZED: a non-rated game can never move trophies", async () => {
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

test("WRITER CAP: a win at 10,000 stays at 10,000 and reports the cap", async () => {
  const db = makeFakeDb({
    users: TWO_USERS,
    seededEvents: [],
  });
  // Seed a near-cap row directly through the fake state.
  db.state.trophies.set("11:chess", {
    user_id: 11,
    game_key: "chess",
    trophies: 10000,
    peak_trophies: 10000,
    games_rated: 400,
    wins: 350,
    losses: 50,
    draws: 0,
    last_delta: 0,
    last_trophy_at: null,
  });

  const result = await applyTrophyResult({ tx: db.tx, ...WIN_ARGS });
  assert.equal(result.applied, true);
  assert.equal(result.winner.trophiesBefore, 10000);
  assert.equal(result.winner.trophiesAfter, 10000);
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
  // The cap must be enforced at the database level too.
  const table = fs.readFileSync("src/db/migrations/0173_player_trophies.sql", "utf8");
  assert.match(table, /trophies.*<= 10000|<= 10000.*trophies/s);
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
];

for (const [gameKey, file] of WIRING) {
  test(`WIRING: ${file} feeds the ${gameKey} trophies`, () => {
    const src = fs.readFileSync(file, "utf8");
    assert.match(
      src,
      /import\s*\{[^}]*applyTrophyResult[^}]*\}/,
      `${file} must import applyTrophyResult`,
    );
    assert.match(src, /applyTrophyResult\(\{/, `${file} must call applyTrophyResult`);
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
      if (/applyTrophyResult\(\{/.test(src)) offenders.push(full);
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
