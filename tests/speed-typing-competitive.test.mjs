/**
 * speed-typing-competitive.test.mjs
 *
 * Speed Typing's integration into the EXISTING GRYND competitive systems:
 *
 *   * the rated-game registry (`RATED_GAMES` in src/lib/rating.js) — Speed
 *     Typing must be a normal member, with no second registry of its own
 *   * the trophy registry, which IS that same list (`TROPHY_GAMES`) — proving
 *     the game is a trophy game without a single speed-typing-specific rule
 *   * the shared Elo writer (`applyRatingResult`) and trophy writer
 *     (`applyTrophyResult`) — behaviour tests for the writers themselves live
 *     beside their own harnesses (tests/elo-rating.test.mjs /
 *     tests/trophy-system.test.mjs); this file pins the WIRING and drives the
 *     game's own settlement seam
 *   * the leaderboard infrastructure, which derives its game list from the one
 *     registry and must never special-case a game
 *   * match history (`/api/get-bet-history`), which requires explicit
 *     per-game registration
 *   * the absence of a second Elo/trophy implementation: the game module must
 *     contain no rating maths, no trophy maths and no game list of its own
 *
 * Run:  node --import tsx --test tests/speed-typing-competitive.test.mjs
 * (the settlement-seam behaviour test needs --experimental-test-module-mocks;
 *  without the flag that ONE test skips instead of failing, matching the
 *  precedent in tests/precision-due-transitions.test.mjs)
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mock } from "node:test";

import {
  RATED_GAMES,
  RATING_GAME_LABELS,
  isRatedGame,
  getRatingGameLabel,
  normalizeRatingGameKey,
} from "../src/lib/rating.js";
import {
  TROPHY_GAMES,
  isTrophyGame,
  getTrophyGameLabel,
  normalizeTrophyGameKey,
} from "../src/lib/trophies.js";
import { listTrophyGames } from "../src/lib/trophyStore.js";
import {
  GAME_KEY,
  MATCH_STATUS,
  RESULT,
  SETTLEMENT_RESULT,
  SPEED_TYPING_LOCK_NAMESPACE,
  SEAT_COUNT,
} from "../src/lib/speed-typing/constants.ts";

const KEY = "speed-typing";

const read = (rel) => fs.readFileSync(rel, "utf8");
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

const STORE = "src/lib/speed-typing/serverStore.ts";
const STORE_SRC = read(STORE);

/**
 * The store is loaded LAZILY, never with a static import.
 *
 * A static import would instantiate the module — binding its REAL
 * `applyRatingResult` / `applyTrophyResult` — before the module-mocking tests
 * below ever run, so `t.mock.module` could no longer intercept them and those
 * tests would silently drive the real writers against a fake transaction
 * instead of asserting on the mocked calls.
 */
const loadStore = () => import("../src/lib/speed-typing/serverStore.ts");

// ════════════════════════════════════════════════════════════════════════
// 1. Rated-game registry — Speed Typing is a normal member
// ════════════════════════════════════════════════════════════════════════

test("registry: speed-typing is a rated game under the canonical key", () => {
  assert.equal(GAME_KEY, KEY);
  assert.equal(isRatedGame(KEY), true);
  assert.equal(normalizeRatingGameKey(KEY), KEY);
});

test("registry: the display name is exactly \"Speed Typing\"", () => {
  assert.equal(getRatingGameLabel(KEY), "Speed Typing");
  assert.equal(RATING_GAME_LABELS[KEY], "Speed Typing");
});

test("registry: speed-typing appears exactly once (no duplicate entry)", () => {
  assert.equal(RATED_GAMES.filter((key) => key === KEY).length, 1);
});

test("registry: speed-typing is NOT registered by any second list", () => {
  // A Speed Typing-specific registry would be drift. The store must speak the
  // shared game key, and nothing may declare a competing rated-games list.
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
      const src = read(full);
      if (/SPEED_TYPING_RATED_GAMES|RATED_GAMES_SPEED_TYPING|speedTypingRatedGames/.test(src)) {
        offenders.push(full);
      }
    }
  };
  walk("src");
  assert.deepEqual(offenders, []);
});

test("registry: the game key is a valid journal key shape", () => {
  // The shared writers validate the key against this shape before journaling,
  // so a key that fails it would silently never rate or award anything.
  assert.match(KEY, /^[a-z0-9][a-z0-9._-]{0,63}$/);
});

// ════════════════════════════════════════════════════════════════════════
// 2. Trophy registry — derived, never a second list
// ════════════════════════════════════════════════════════════════════════

test("trophies reuse the SAME game set as Elo (no drift)", () => {
  assert.deepEqual([...TROPHY_GAMES], [...RATED_GAMES]);
  assert.equal(isTrophyGame(KEY), true);
  assert.equal(normalizeTrophyGameKey(KEY), KEY);
  assert.equal(getTrophyGameLabel(KEY), "Speed Typing");
});

test("trophies: the game appears once in the trophy picker, correctly labelled", () => {
  const games = listTrophyGames();
  const entry = games.find((game) => game.key === KEY);
  assert.ok(entry, "Speed Typing must appear in the trophy game picker");
  assert.equal(entry.label, "Speed Typing");
  assert.equal(games.filter((game) => game.key === KEY).length, 1);
});

// ════════════════════════════════════════════════════════════════════════
// 3. Leaderboards / game statistics — derived, never special-cased
// ════════════════════════════════════════════════════════════════════════

test("leaderboard: the per-game Elo board derives its game list from RATED_GAMES", () => {
  const src = read("src/app/api/leaderboard/game/route.js");
  assert.match(src, /RATED_GAMES/);
  assert.match(src, /games: RATED_GAMES\.map\(/);
  assert.match(src, /getRatingGameLabel/);
  // It must not name this game (or any game) — the registry is the source.
  assert.doesNotMatch(src, /speed-typing/);
});

test("leaderboard: the per-game trophy board derives its game list from TROPHY_GAMES", () => {
  const src = read("src/app/api/leaderboard/trophy/route.js");
  assert.match(src, /listTrophyGames/);
  assert.doesNotMatch(src, /speed-typing/);
});

test("leaderboard: /classement's first-paint fallback mirrors the registry", () => {
  // The board's client-side fallback list is the one place the game list is
  // duplicated by necessity (it renders before the API answers), so it must
  // still agree with RATED_GAMES.
  const src = read("src/app/classement/PageClient.jsx");
  assert.match(src, /key: "speed-typing", label: "Speed Typing"/);
  for (const key of RATED_GAMES) {
    assert.match(
      src,
      new RegExp(`key: "${key}", label:`),
      `/classement's fallback is missing the rated game "${key}"`,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════
// 4. Settlement wiring — the source contract the audits look for
// ════════════════════════════════════════════════════════════════════════

test("wiring: the store imports and calls the SHARED writers", () => {
  for (const writer of ["applyRatingResult", "applyTrophyResult"]) {
    assert.match(
      STORE_SRC,
      new RegExp(`import\\s*\\{[^}]*${writer}[^}]*\\}`),
      `${STORE} must import ${writer}`,
    );
    assert.match(
      STORE_SRC,
      new RegExp(`${writer}\\(\\{`),
      `${STORE} must call ${writer}`,
    );
  }
});

test("wiring: the game key is written as a literal at every settlement call site", () => {
  // tests/elo-rating.test.mjs and tests/trophy-system.test.mjs audit the source
  // for `gameKey: "<key>"` to prove a rated game is actually wired. A constant
  // reference would be invisible to that check.
  const literals = STORE_SRC.match(/gameKey:\s*"speed-typing"/g) ?? [];
  assert.ok(
    literals.length >= 4,
    `expected the literal gameKey at every writer call site (found ${literals.length})`,
  );
});

test("wiring: the settlement seam is exported and takes the caller's transaction", () => {
  assert.match(STORE_SRC, /export async function settleSpeedTypingMatch\(\{/);
  assert.match(STORE_SRC, /tx: any;/);
  // It must never open its own transaction: settlement belongs INSIDE the
  // caller's row-locked one so the match finalisation and the rating change
  // commit atomically.
  const fn = STORE_SRC.slice(STORE_SRC.indexOf("export async function settleSpeedTypingMatch("));
  assert.doesNotMatch(
    fn.slice(0, fn.indexOf("\n}\n")),
    /db\.transaction/,
    "the settlement seam must use the caller's transaction, never its own",
  );
});

test("wiring: settlement never touches tokens, balances or payouts", () => {
  // Comments stripped: the file's prose legitimately explains that the game is
  // unstaked, and that prose must not be mistaken for a money-moving call.
  const storeCode = code(STORE);
  const settlement = storeCode.slice(
    storeCode.indexOf("export async function settleSpeedTypingMatch("),
  );
  assert.doesNotMatch(settlement, /balance|payout|wager|stake|token|prize/i);
  // The only account stats a settled race moves are the win/loss counters.
  assert.match(settlement, /gamesWon/);
  assert.match(settlement, /gamesLost/);
});

// ════════════════════════════════════════════════════════════════════════
// 5. The settlement seam, driven — it delegates, it does not re-implement
// ════════════════════════════════════════════════════════════════════════

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:speed-typing";

const MATCH_ID = "44444444-4444-4444-8444-444444444444";
const WINNER = "user_winner";
const LOSER = "user_loser";

/** A fake settlement transaction that records the account-stat updates. */
function makeFakeTx() {
  const writes = [];
  return {
    writes,
    tx: {
      update: () => ({
        set: (values) => ({
          where: async () => {
            writes.push(values);
            return { rowCount: 1 };
          },
        }),
      }),
    },
  };
}

//
// All three settlement scenarios live in ONE test on purpose: a mocked module
// (and the mock functions bound into it) is cached for the rest of the file, so
// a second test that re-registered the same mocks would import the FIRST test's
// instance and record its calls into the first test's arrays.
test(
  "seam: settlement delegates to BOTH shared writers, and never re-implements them",
  { skip: SKIP_REASON },
  async (t) => {
    const ratingCalls = [];
    const trophyCalls = [];

    t.mock.module("../src/lib/rating.js", {
      namedExports: {
        applyRatingResult: async (args) => {
          ratingCalls.push(args);
          return { applied: true };
        },
      },
    });
    t.mock.module("../src/lib/trophyStore.js", {
      namedExports: {
        applyTrophyResult: async (args) => {
          trophyCalls.push(args);
          return { applied: true };
        },
      },
    });
    t.mock.module("../src/lib/canonicalQueueLifecycle.js", {
      namedExports: {
        mirrorQueueCreated: () => {},
        mirrorQueueTransition: () => {},
      },
    });

    const { settleSpeedTypingMatch } = await import(
      "../src/lib/speed-typing/serverStore.ts"
    );

    // ── Phase 1: a win delegates to BOTH writers and moves the counters ──
    {
      const { tx, writes } = makeFakeTx();
      const outcome = await settleSpeedTypingMatch({
        tx,
        matchId: MATCH_ID,
        winnerClerkId: WINNER,
        loserClerkId: LOSER,
      });

      assert.deepEqual(outcome, { rated: true, trophied: true });

      // Both writers were called, with the caller's transaction, the canonical
      // game key and the authoritative match id — the journal key.
      assert.equal(ratingCalls.length, 1);
      assert.equal(trophyCalls.length, 1);
      assert.equal(ratingCalls[0].tx, tx, "the caller's transaction must be reused");
      assert.equal(trophyCalls[0].tx, tx);
      assert.equal(ratingCalls[0].gameKey, KEY);
      assert.equal(trophyCalls[0].gameKey, KEY);
      assert.equal(ratingCalls[0].matchId, MATCH_ID);
      assert.equal(trophyCalls[0].matchId, MATCH_ID);
      assert.equal(ratingCalls[0].winnerClerkId, WINNER);
      assert.equal(ratingCalls[0].loserClerkId, LOSER);
      // A win is not a draw.
      assert.equal(ratingCalls[0].result, undefined);
      assert.equal(trophyCalls[0].result, undefined);

      // Exactly two stat writes: +1 win for the winner, +1 loss for the loser.
      assert.equal(writes.length, 2);
    }

  // ── Phase 2: a draw journals both seats as draws, and moves no counter ──
  {
    const { tx, writes } = makeFakeTx();
    ratingCalls.length = 0;
    trophyCalls.length = 0;
    const outcome = await settleSpeedTypingMatch({
      tx,
      matchId: MATCH_ID,
      winnerClerkId: WINNER,
      loserClerkId: LOSER,
      result: SETTLEMENT_RESULT.DRAW,
    });

    assert.deepEqual(outcome, { rated: true, trophied: true });
    assert.equal(ratingCalls[0].result, "draw");
    assert.equal(trophyCalls[0].result, "draw");
    // A draw is a result, not a win: no counter moves.
    assert.equal(writes.length, 0);
  }

  // ── Phase 3: an unusable settlement never reaches a writer at all ──────
  {
    const beforeRating = ratingCalls.length;
    const beforeTrophy = trophyCalls.length;

    const self = await settleSpeedTypingMatch({
      tx: makeFakeTx().tx,
      matchId: MATCH_ID,
      winnerClerkId: WINNER,
      loserClerkId: WINNER,
    });
    assert.deepEqual(self, { rated: false, trophied: false });

    const missing = await settleSpeedTypingMatch({
      tx: makeFakeTx().tx,
      matchId: MATCH_ID,
      winnerClerkId: WINNER,
      loserClerkId: "",
    });
    assert.deepEqual(missing, { rated: false, trophied: false });

    const noMatch = await settleSpeedTypingMatch({
      tx: makeFakeTx().tx,
      matchId: "",
      winnerClerkId: WINNER,
      loserClerkId: LOSER,
    });
    assert.deepEqual(noMatch, { rated: false, trophied: false });

    assert.equal(ratingCalls.length, beforeRating, "no writer may be reached");
    assert.equal(trophyCalls.length, beforeTrophy);
  }
  },
);

// ════════════════════════════════════════════════════════════════════════
// 6. Match history — explicit per-game registration
// ════════════════════════════════════════════════════════════════════════

test("history: the bet-history route registers Speed Typing explicitly", () => {
  const src = read("src/app/api/get-bet-history/route.ts");
  assert.match(src, /speedTypingMatches,/);
  assert.match(src, /speedTypingRows,/);
  // It reads the same authoritative columns every other duel does.
  assert.match(src, /winnerId: speedTypingMatches\.winnerId/);
  assert.match(src, /result: speedTypingMatches\.result/);
  assert.match(src, /isAi: speedTypingMatches\.isAi/);
  // Both seats are matched, so the caller sees their own matches either way.
  assert.match(src, /eq\(speedTypingMatches\.player1Id, clerkId\)/);
  assert.match(src, /eq\(speedTypingMatches\.player2Id, clerkId\)/);
  // …and the formatted rows are merged into the one list the profile renders.
  assert.match(src, /\.\.\.speedTypingFormatted,/);
  // Unstaked: the record line is decided, never token movement.
  assert.match(src, /type: g\.isAi \? "Speed Typing vs AI" : "Speed Typing"/);
});

test("history: only a TERMINAL match is listed", () => {
  const src = read("src/app/api/get-bet-history/route.ts");
  const block = src.slice(src.indexOf("const speedTypingFormatted"));
  assert.match(block.slice(0, 260), /if \(g\.status !== "finished"\) return null;/);
});

test("history: the DTO carries no passage, no keystrokes and nothing to hide", () => {
  // The read path is registration-only in this release. If a field the gameplay
  // phase must keep server-side ever leaks into the DTO, this fails.
  const dto = STORE_SRC.slice(STORE_SRC.indexOf("export function matchToDto("));
  const body = dto.slice(0, dto.indexOf("\n}\n"));
  assert.doesNotMatch(body, /passage|text|keystroke|nonce|wpm|accuracy/i);
});

// ════════════════════════════════════════════════════════════════════════
// 7. No second Elo and no second trophy implementation
// ════════════════════════════════════════════════════════════════════════

test("no duplication: the game module contains no rating maths", () => {
  const src = code(STORE) + code("src/lib/speed-typing/constants.ts");
  for (const forbidden of [
    /K_FACTOR/i,
    /expectedScore/i,
    /STARTING_RATING/i,
    /PROVISIONAL_GAMES/i,
    /player_ratings|rating_events|rating_identities/i,
    /INSERT INTO .*rating/i,
  ]) {
    assert.doesNotMatch(src, forbidden, `found a local rating implementation: ${forbidden}`);
  }
});

test("no duplication: the game module contains no trophy maths", () => {
  const src = code(STORE) + code("src/lib/speed-typing/constants.ts");
  for (const forbidden of [
    /TROPHY_WIN|TROPHY_LOSS|TROPHY_MIN|TROPHY_DRAW/i,
    /clampTrophies/i,
    /trophies_before|trophies_after/i,
    /INSERT INTO .*troph/i,
  ]) {
    assert.doesNotMatch(src, forbidden, `found a local trophy implementation: ${forbidden}`);
  }
});

test("no duplication: the game module owns no second queue or matchmaker", () => {
  const src = code(STORE) + code("src/lib/speed-typing/constants.ts");
  // It must reuse the platform's matchmaking primitives (an advisory lock plus
  // a row lock), not grow a parallel queue.
  assert.match(src, /pg_advisory_xact_lock/);
  assert.match(src, /for\("update"\)/);
  for (const forbidden of [
    /quickQueueRequests|quickQueueAssignments/i,
    /new Map\(\)/,
    /setInterval/,
  ]) {
    assert.doesNotMatch(src, forbidden, `found second-queue machinery: ${forbidden}`);
  }
});

test("registry: the queue integration reuses the ONE key list", async () => {
  const { QUICK_QUEUE_GAME_KEYS } = await import("../src/lib/quickQueue.ts");
  assert.ok(QUICK_QUEUE_GAME_KEYS.includes(KEY));
  // The game must not declare its own queue key list.
  assert.doesNotMatch(code(STORE), /QUICK_QUEUE_GAME_KEYS\s*=/);
});

// ════════════════════════════════════════════════════════════════════════
// 8. Pure helpers — the vocabulary the settlement/gameplay layer shares
// ════════════════════════════════════════════════════════════════════════

test("helpers: a match id must be a real uuid or it never reaches Postgres", async () => {
  const { isMatchId } = await loadStore();
  assert.equal(isMatchId(MATCH_ID), true);
  assert.equal(isMatchId("11111111-1111-4111-8111-111111111111"), true);
  assert.equal(isMatchId("not-a-uuid"), false);
  assert.equal(isMatchId(""), false);
  assert.equal(isMatchId("1 OR 1=1"), false);
  assert.equal(isMatchId(null), false);
  assert.equal(isMatchId(42), false);
  assert.equal(isMatchId({}), false);
});

test("helpers: seats and participant checks come from the row, never the body", async () => {
  const { isParticipant, seatsFromRow } = await loadStore();
  const row = { player1Id: "a", player2Id: null };
  assert.deepEqual(seatsFromRow(row), { player1Id: "a", player2Id: null });
  assert.equal(isParticipant(row, "a"), true);
  assert.equal(isParticipant(row, "b"), false, "an empty seat is nobody's");
  assert.equal(isParticipant(row, null), false);
  assert.equal(isParticipant({ player1Id: "a", player2Id: "b" }, "b"), true);
});

test("helpers: the DTO reports the viewer's own seat and nothing secret", async () => {
  const { matchToDto } = await loadStore();
  const row = {
    id: MATCH_ID,
    player1Id: "a",
    player2Id: "b",
    winnerId: null,
    status: MATCH_STATUS.PLAYING,
    isAi: false,
    aiDifficulty: null,
    result: null,
    createdAt: new Date(0),
    startedAt: null,
    endedAt: null,
  };

  const asA = matchToDto(row, "a");
  assert.equal(asA.viewerSeat, 1);
  assert.deepEqual(asA.players, [
    { seat: 1, userId: "a" },
    { seat: 2, userId: "b" },
  ]);

  const asB = matchToDto(row, "b");
  assert.equal(asB.viewerSeat, 2);

  // A stranger gets no seat — and cannot reach this function at all, because
  // `fetchMatch` refuses a non-participant first.
  assert.equal(matchToDto(row, "c").viewerSeat, null);
  assert.equal(matchToDto(row, null).viewerSeat, null);

  // A waiting lobby advertises only the seat that exists.
  const waiting = matchToDto({ ...row, player2Id: null, status: MATCH_STATUS.WAITING }, "a");
  assert.deepEqual(waiting.players, [{ seat: 1, userId: "a" }]);
});

test("helpers: the AI tier is null on a human duel and coerced on a practice row", async () => {
  const { aiDifficultyForMatch } = await loadStore();
  assert.equal(aiDifficultyForMatch({ isAi: false, aiDifficulty: "hard" }), null);
  assert.equal(aiDifficultyForMatch({ isAi: true, aiDifficulty: "hard" }), "hard");
  assert.equal(aiDifficultyForMatch({ isAi: true, aiDifficulty: "medium" }), "normal");
  assert.equal(aiDifficultyForMatch({ isAi: true, aiDifficulty: null }), "normal");
});

test("helpers: the settlement token is derived, never accepted from a client", async () => {
  const { settlementResultFor, settlementResultFromRow } = await loadStore();
  assert.equal(settlementResultFor({ winnerSeat: "player1" }), "win");
  assert.equal(settlementResultFor({ winnerSeat: "player2" }), "win");
  assert.equal(settlementResultFor({ winnerSeat: null }), "draw");
  assert.equal(settlementResultFromRow(RESULT.PLAYER1), "win");
  assert.equal(settlementResultFromRow(RESULT.PLAYER2), "win");
  assert.equal(settlementResultFromRow(RESULT.TIE), "draw");
  // A tampered/unknown row value is a win shape, never a silent draw.
  assert.equal(settlementResultFromRow("player3"), "win");
  assert.equal(settlementResultFromRow(undefined), "win");
});

test("helpers: terminal statuses are terminal", async () => {
  const { isActiveStatus } = await loadStore();
  assert.equal(isActiveStatus(MATCH_STATUS.WAITING), true);
  assert.equal(isActiveStatus(MATCH_STATUS.PLAYING), true);
  assert.equal(isActiveStatus(MATCH_STATUS.FINISHED), false);
  assert.equal(isActiveStatus(MATCH_STATUS.CANCELLED), false);
});

test("vocabulary: the game is strictly 1v1 and unstaked by construction", () => {
  assert.equal(SEAT_COUNT, 2);
  assert.equal(typeof SPEED_TYPING_LOCK_NAMESPACE, "number");
  assert.ok(
    Number.isInteger(SPEED_TYPING_LOCK_NAMESPACE) && SPEED_TYPING_LOCK_NAMESPACE > 0,
    "the advisory-lock namespace must be a positive int4",
  );
  assert.ok(
    SPEED_TYPING_LOCK_NAMESPACE < 2 ** 31,
    "pg_advisory_xact_lock takes a signed int4",
  );
  // No economy vocabulary may exist in the game's own constants.
  assert.doesNotMatch(
    code("src/lib/speed-typing/constants.ts"),
    /wager|stake|balance|payout|token/i,
  );
});
