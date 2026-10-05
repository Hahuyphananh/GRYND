/**
 * speed-typing-store.test.mjs
 *
 * The AUTHORITATIVE MATCH STORE, driven for real.
 *
 * `tests/speed-typing-race.test.mjs` proves the store's SHAPE (every mutator
 * locks the row first, no signature accepts a decision, one transaction per
 * action). This file proves its BEHAVIOUR: the store is exercised end to end
 * against a fake database, exactly the way the API routes and the socket layer
 * will call it, and every answer is asserted.
 *
 * The model under test, in one line: a client may only ever say WHAT IT TYPED.
 * Every progress count, error count, completion, timestamp, WPM, accuracy,
 * winner, rating and trophy is derived by the server from the passage on the
 * row and the server's own clock. So most of what these tests do is try to make
 * the store accept something a client is not allowed to decide — and watch it
 * refuse, or ignore the claim and derive the truth anyway.
 *
 * The fake DB follows the established harness in
 * tests/keno-pvp-ai-audit.test.mjs: it does not implement WHERE clauses (every
 * store read targets the one match row under test), so each scenario seeds a
 * database holding exactly the rows it means to act on. The module graph is
 * cached for the whole file, so there is ONE shared fake, reset per test.
 *
 * Run:  npm run test:speed-typing
 *   (or: node --import tsx --test --experimental-test-module-mocks tests/speed-typing-store.test.mjs)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

import { speedTypingMatches, users } from "../src/db/schema.ts";
import {
  MATCH_STATUS,
  RACE_COUNTDOWN_MS,
  RACE_LIMIT_MS,
  RESOLUTION,
  RESULT,
  SEAT,
  SPEED_TYPING_AI_PLAYER_ID,
} from "../src/lib/speed-typing/constants.ts";
import { createRaceState } from "../src/lib/speed-typing/rules.ts";
import {
  PASSAGE_VERSION,
  isEnabledPassageId,
  passageForRow,
  selectPassageForSeed,
} from "../src/lib/speed-typing/passages.ts";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:speed-typing";

const MATCH_ID = "55555555-5555-4555-8555-555555555555";
const ALICE = "user_alice";
const BOB = "user_bob";
const MALLORY = "user_mallory";
const GO = 1_700_000_000_000;

const SEED = 987654;
const PROMPT = selectPassageForSeed({ seed: SEED });
const TEXT = PROMPT.text;
assert.ok(TEXT.length > 20, "the seeded prompt must be a real passage");

// ── The fake database ─────────────────────────────────────────────────────

/**
 * A fake Drizzle client covering exactly the query shapes the store uses.
 *
 * It deliberately ignores WHERE clauses: each test seeds the rows it means the
 * store to see, so "the row" is unambiguous. Updates persist, so a read after a
 * write observes the new state the way a real transaction would.
 */
function createFakeDb() {
  const state = { tables: new Map(), nextId: 1, transactions: 0, writes: [], locks: [] };

  const rowsOf = (table) => {
    if (!state.tables.has(table)) state.tables.set(table, []);
    return state.tables.get(table);
  };

  const select = () => {
    let table = null;
    const q = {
      from(t) {
        table = t;
        return q;
      },
      where: () => q,
      for: () => q,
      orderBy: () => q,
      limit: () => q,
      then: (resolve, reject) =>
        Promise.resolve(rowsOf(table).map((row) => ({ ...row }))).then(resolve, reject),
    };
    return q;
  };

  const update = (table) => {
    let values = null;
    const b = {
      set(v) {
        values = v;
        return b;
      },
      where: () => b,
      returning: () => {
        state.writes.push({ table, op: "update", values });
        for (const row of rowsOf(table)) {
          for (const [key, value] of Object.entries(values)) {
            // `revision` is written as a SQL increment; emulate just that one
            // expression so the counter stays a number the reads can use.
            row[key] =
              key === "revision" && value && typeof value === "object"
                ? (Number(row[key]) || 0) + 1
                : value;
          }
        }
        return Promise.resolve(rowsOf(table).map((row) => ({ ...row })));
      },
      then: (resolve, reject) => b.returning().then(resolve, reject),
    };
    return b;
  };

  const insert = (table) => ({
    values: (v) => ({
      returning: () => {
        const row = {
          id: `match-${state.nextId++}`,
          revision: 0,
          createdAt: new Date(GO - 10_000),
          ...v,
        };
        state.writes.push({ table, op: "insert", values: v });
        rowsOf(table).push(row);
        return Promise.resolve([{ ...row }]);
      },
    }),
  });

  const tx = {
    select,
    update,
    insert,
    execute: async (query) => {
      state.locks.push(query);
    },
  };

  const reset = () => {
    state.tables.clear();
    state.nextId = 1;
    state.transactions = 0;
    state.writes = [];
    state.locks = [];
  };

  return {
    state,
    reset,
    rowsOf,
    db: {
      transaction: async (fn) => {
        state.transactions += 1;
        return fn(tx);
      },
      select,
      update,
      insert,
    },
  };
}

// The store module is cached for the whole file, so every test must be mocked
// with THE SAME fake — a fresh instance per test would leave the cached module
// pointing at the first one. The one fake is reset before each test instead.
let sharedFake = null;
const settlement = { rating: [], trophy: [], queue: [] };

function installMocks(t) {
  if (!sharedFake) sharedFake = createFakeDb();
  const fake = sharedFake;
  fake.reset();
  settlement.rating.length = 0;
  settlement.trophy.length = 0;
  settlement.queue.length = 0;

  t.mock.module("../src/db/client.ts", { namedExports: { db: fake.db } });
  t.mock.module("../src/lib/rating.js", {
    namedExports: {
      applyRatingResult: async (args) => {
        settlement.rating.push(args);
        return { applied: true };
      },
    },
  });
  t.mock.module("../src/lib/trophyStore.js", {
    namedExports: {
      applyTrophyResult: async (args) => {
        settlement.trophy.push(args);
        return { applied: true };
      },
    },
  });
  t.mock.module("../src/lib/canonicalQueueLifecycle.js", {
    namedExports: {
      mirrorQueueCreated: (args) => settlement.queue.push({ kind: "created", ...args }),
      mirrorQueueTransition: (args) => settlement.queue.push({ kind: "transition", ...args }),
    },
  });
  return fake;
}

const loadStore = () => import("../src/lib/speed-typing/serverStore.ts");

// ── Fixtures ──────────────────────────────────────────────────────────────

/** An armed, playing match row — everything `armedRaceValues` writes plus the
 *  lifecycle columns the store reads. */
function armedRow(overrides = {}) {
  return {
    id: MATCH_ID,
    player1Id: ALICE,
    player2Id: BOB,
    winnerId: null,
    status: MATCH_STATUS.PLAYING,
    isAi: false,
    aiDifficulty: null,
    result: null,
    raceSeed: SEED,
    passageId: PROMPT.id,
    passageVersion: PASSAGE_VERSION,
    goAt: new Date(GO),
    revision: 1,
    resolutionReason: null,
    raceState: createRaceState({ version: 1 }),
    player1CharsTyped: 0,
    player1Errors: 0,
    player2CharsTyped: 0,
    player2Errors: 0,
    player1CompletedAt: null,
    player2CompletedAt: null,
    startedAt: new Date(GO - RACE_COUNTDOWN_MS),
    endedAt: null,
    createdAt: new Date(GO - 10_000),
    updatedAt: new Date(GO - 10_000),
    ...overrides,
  };
}

/**
 * Point the fake at exactly ONE match row.
 *
 * The fake does not implement WHERE, so every read resolves to "the row". Each
 * scenario therefore REPLACES the table rather than appending to it — otherwise
 * a later read would silently grade an earlier scenario's match.
 */
function seed(fake, row) {
  fake.state.tables.set(speedTypingMatches, [row]);
  return row;
}

/** Freeze the store's clock for a test (only `createOrJoin` needs it: the join
 *  path stamps its own GO instant instead of taking one as an argument). */
function installClock(t, clockMs) {
  const realNow = Date.now;
  Date.now = () => clockMs;
  t.after(() => {
    Date.now = realNow;
  });
}

const matchWrites = (fake) => fake.state.writes.filter((w) => w.table === speedTypingMatches);
const userWrites = (fake) => fake.state.writes.filter((w) => w.table === users);

// Which settlement token each scenario should produce.
const settledOnce = (label) => {
  assert.equal(settlement.rating.length, 1, `${label}: rating must settle exactly once`);
  assert.equal(settlement.trophy.length, 1, `${label}: trophies must settle exactly once`);
  assert.equal(settlement.rating[0].gameKey, "speed-typing");
  assert.equal(settlement.trophy[0].gameKey, "speed-typing");
  assert.equal(settlement.rating[0].matchId, MATCH_ID, "the match id is the journal key");
  assert.equal(settlement.trophy[0].matchId, MATCH_ID);
};

// ════════════════════════════════════════════════════════════════════════
// 1. Create → join → start
// ════════════════════════════════════════════════════════════════════════

test("create: matchmaking opens a waiting lobby for the first player", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { createOrJoin } = await loadStore();

  const result = await createOrJoin({ userId: ALICE });
  assert.equal(result.joined, false);
  assert.equal(result.match.player1Id, ALICE);
  assert.equal(result.match.player2Id ?? null, null, "the second seat is still open");
  assert.equal(result.match.status, MATCH_STATUS.WAITING);
  assert.equal(result.match.raceSeed ?? null, null, "an open lobby is not armed yet");
  assert.equal(result.match.goAt ?? null, null);

  // Exactly one row, one transaction, and the per-game advisory lock taken.
  assert.equal(matchWrites(fake).filter((w) => w.op === "insert").length, 1);
  assert.equal(fake.state.transactions, 1);
  assert.equal(fake.state.locks.length, 1, "matchmaking must serialise on the advisory lock");
  assert.equal(settlement.queue.filter((q) => q.kind === "created").length, 1);
});

test("join: the second player fills the seat and ARMS the race", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { createOrJoin } = await loadStore();
  const waiting = seed(fake, {
    ...armedRow({ status: MATCH_STATUS.WAITING }),
    player2Id: null,
    raceSeed: null,
    passageId: null,
    passageVersion: null,
    goAt: null,
    raceState: createRaceState({ version: 0 }),
  });

  const now = GO - RACE_COUNTDOWN_MS - 5_000;
  installClock(t, now);
  const result = await createOrJoin({ userId: BOB, nowMs: now });

  assert.equal(result.joined, true);
  assert.equal(result.match.id, waiting.id);
  assert.equal(result.match.player2Id, BOB);
  assert.equal(result.match.status, MATCH_STATUS.PLAYING, "a typing race has nothing to ready up");
  // The race is armed with ONE server-selected prompt and ONE absolute GO
  // instant — both derived here, never supplied by a client.
  assert.equal(typeof result.match.raceSeed, "number");
  assert.equal(isEnabledPassageId(result.match.passageId), true, "a selectable prompt was chosen");
  assert.equal(result.match.passageVersion, PASSAGE_VERSION);
  assert.equal(new Date(result.match.goAt).getTime(), now + RACE_COUNTDOWN_MS);
  assert.ok(result.match.raceState?.seats?.player1, "the authoritative race state exists");
});

test("join: a caller who already has a lobby gets it back instead of a second one", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { createOrJoin } = await loadStore();
  seed(fake, {
    ...armedRow({ status: MATCH_STATUS.WAITING }),
    player2Id: null,
    raceSeed: null,
    passageId: null,
    passageVersion: null,
    goAt: null,
  });

  const result = await createOrJoin({ userId: ALICE });
  assert.equal(result.joined, false);
  assert.equal(result.match.player1Id, ALICE);
  assert.equal(matchWrites(fake).filter((w) => w.op === "insert").length, 0, "no second row");
});

test("start: arming is idempotent and writes one absolute GO instant", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { armRace } = await loadStore();
  const unarmed = seed(fake, {
    ...armedRow({ status: MATCH_STATUS.PLAYING }),
    raceSeed: null,
    passageId: null,
    passageVersion: null,
    goAt: null,
    raceState: createRaceState({ version: 0 }),
  });

  const now = GO - 1_000;
  const armed = await armRace({ matchId: unarmed.id, nowMs: now });
  assert.equal(armed.armed, true);
  assert.equal(new Date(armed.match.goAt).getTime(), now + RACE_COUNTDOWN_MS);
  assert.equal(isEnabledPassageId(armed.match.passageId), true);
  assert.equal(armed.match.status, MATCH_STATUS.PLAYING);
  assert.equal(matchWrites(fake).length, 1);

  // A second call must NOT re-roll the prompt or restart the clock.
  const again = await armRace({ matchId: unarmed.id, nowMs: now + 500 });
  assert.equal(again.armed, false);
  assert.equal(new Date(again.match.goAt).getTime(), now + RACE_COUNTDOWN_MS, "GO is untouched");
  assert.equal(matchWrites(fake).length, 1, "an armed race is not written again");
});

test("start: an unarmed race is refused, and a row with no opponent is not armed", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { armRace, recordProgress } = await loadStore();
  seed(fake, { ...armedRow({ status: MATCH_STATUS.WAITING }), player2Id: null, goAt: null, raceSeed: null });

  const noOpponent = await armRace({ matchId: MATCH_ID, nowMs: GO });
  assert.equal(noOpponent.error, "Waiting for an opponent");
  assert.equal(noOpponent.status, 409);
  assert.equal(matchWrites(fake).length, 0);

  // And progress against a row with no resolved prompt is refused, not guessed.
  const unarmed = await recordProgress({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO });
  assert.equal(unarmed.status, 409);
});

// ════════════════════════════════════════════════════════════════════════
// 2. Load + participant validation
// ════════════════════════════════════════════════════════════════════════

test("load: fetchMatch is participant-gated and 404s an unknown id", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { fetchMatch } = await loadStore();
  seed(fake, armedRow());

  const asAlice = await fetchMatch({ userId: ALICE, matchId: MATCH_ID });
  assert.equal(asAlice.dto.viewerSeat, 1);
  assert.equal(asAlice.dto.race.passageText, TEXT, "a participant gets the canonical prompt");
  assert.equal(asAlice.dto.race.prompt.id, PROMPT.id);

  const asMallory = await fetchMatch({ userId: MALLORY, matchId: MATCH_ID });
  assert.equal(asMallory.status, 403, "a non-participant is refused outright");
  assert.equal(asMallory.dto, undefined, "and gets no prompt at all");

  // An unknown id: the table is emptied so the lookup genuinely finds nothing.
  fake.state.tables.set(speedTypingMatches, []);
  const missing = await fetchMatch({ userId: ALICE, matchId: "00000000-0000-4000-8000-000000000000" });
  assert.equal(missing.status, 404);
});

// ════════════════════════════════════════════════════════════════════════
// 3. Progress
// ════════════════════════════════════════════════════════════════════════

test("progress: a checkpoint is verified against the prompt and stored server-side", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { recordProgress } = await loadStore();
  seed(fake, armedRow());

  const typed = TEXT.slice(0, 12);
  const result = await recordProgress({ userId: ALICE, matchId: MATCH_ID, typedText: typed, nowMs: GO + 1_000 });

  assert.equal(result.accepted, true);
  assert.equal(result.seat, SEAT.PLAYER1);
  assert.equal(result.seatState.charsTyped, 12, "the count comes from the server's compare");
  assert.equal(result.seatState.errors, 0);
  assert.equal(result.seatState.finished, false, "progress never completes a match");

  // The denormalised columns and the authoritative blob both moved.
  assert.equal(result.match.player1CharsTyped, 12);
  assert.equal(result.match.player1Errors, 0);
  assert.equal(result.match.raceState.seats.player1.charsTyped, 12);
  assert.equal(result.match.status, MATCH_STATUS.PLAYING);
  assert.equal(matchWrites(fake).length, 1);
});

test("progress: nonsense is refused, and a refused checkpoint writes nothing", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { recordProgress } = await loadStore();
  seed(fake, armedRow());

  // Before GO: a pre-buffered passage counts for nothing.
  const early = await recordProgress({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO - 1 });
  assert.equal(early.accepted, false);
  assert.equal(early.reason, "before_go");
  assert.equal(early.seatState.charsTyped, 0);

  // After the hard limit: too late.
  const late = await recordProgress({
    userId: ALICE,
    matchId: MATCH_ID,
    typedText: TEXT,
    nowMs: GO + RACE_LIMIT_MS + 1,
  });
  assert.equal(late.reason, "past_deadline");

  // Malformed input is EMPTY progress, not an error and not a claim.
  for (const junk of [42, { charsTyped: 999 }, null, []]) {
    const bad = await recordProgress({ userId: ALICE, matchId: MATCH_ID, typedText: junk, nowMs: GO + 2_000 });
    assert.equal(bad.accepted, false);
    assert.equal(bad.seatState.charsTyped, 0);
  }

  assert.equal(matchWrites(fake).length, 0, "a rejected checkpoint must not write");
});

test("progress: it never moves backwards, and the throttle keeps a race out of the write path", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { recordProgress } = await loadStore();
  seed(fake, armedRow());

  const first = await recordProgress({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT.slice(0, 20), nowMs: GO + 1_000 });
  assert.equal(first.accepted, true);
  assert.equal(matchWrites(fake).length, 1);

  // A late, shorter packet (an out-of-order delivery) is a harmless no-op.
  const back = await recordProgress({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT.slice(0, 5), nowMs: GO + 1_100 });
  assert.equal(back.accepted, false);
  assert.equal(back.reason, "no_advance");
  assert.equal(back.seatState.charsTyped, 20, "the stored position is unchanged");
  assert.equal(matchWrites(fake).length, 1, "no write for a no-op");

  // A tiny advance is below the throttle, so it is not persisted either.
  const tiny = await recordProgress({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT.slice(0, 22), nowMs: GO + 1_200 });
  assert.equal(tiny.accepted, false);
  assert.equal(tiny.reason, "below_threshold");
  assert.equal(matchWrites(fake).length, 1);
});

test("progress: non-participants, terminal matches and waiting lobbies are refused", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { recordProgress } = await loadStore();
  seed(fake, armedRow());

  const stranger = await recordProgress({ userId: MALLORY, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 1_000 });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.error, "Not a participant of this match");

  // A waiting lobby is not a race yet.
  const waiting = seed(fake, {
    ...armedRow(),
    id: "match-waiting",
    status: MATCH_STATUS.WAITING,
    player2Id: null,
    goAt: null,
    raceSeed: null,
  });
  const inLobby = await recordProgress({ userId: ALICE, matchId: waiting.id, typedText: TEXT, nowMs: GO });
  assert.equal(inLobby.status, 409);

  // A finished match accepts nothing and says so benignly.
  const finished = seed(fake, {
    ...armedRow(),
    id: "match-finished",
    status: MATCH_STATUS.FINISHED,
    result: RESULT.PLAYER1,
  });
  const after = await recordProgress({ userId: ALICE, matchId: finished.id, typedText: TEXT, nowMs: GO + 1_000 });
  assert.equal(after.accepted, false);
  assert.equal(after.reason, "resolved");

  // A cancelled match is terminal too.
  const cancelled = seed(fake, {
    ...armedRow(),
    id: "match-cancelled",
    status: MATCH_STATUS.CANCELLED,
  });
  const onCancelled = await recordProgress({ userId: ALICE, matchId: cancelled.id, typedText: TEXT, nowMs: GO + 1_000 });
  assert.equal(onCancelled.reason, "resolved");

  assert.equal(matchWrites(fake).length, 0);
});

test("progress: a flood of wrong characters cannot claim the passage", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { recordProgress } = await loadStore();
  seed(fake, armedRow());

  // Every character wrong: the cursor stops at the prompt's end, and the whole
  // submission is recorded as mistakes — never as progress.
  const result = await recordProgress({
    userId: ALICE,
    matchId: MATCH_ID,
    typedText: "Q".repeat(TEXT.length * 4),
    nowMs: GO + 1_000,
  });
  assert.equal(result.seatState.charsTyped, TEXT.length, "progress is capped at the prompt");
  assert.equal(result.seatState.errors, TEXT.length);
  assert.equal(result.seatState.finished, false, "mashing is not finishing");
});

// ════════════════════════════════════════════════════════════════════════
// 4. Finish, winner and settlement
// ════════════════════════════════════════════════════════════════════════

test("finish: only the exact prompt completes, and the numbers are server-derived", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { submitFinish } = await loadStore();
  seed(fake, armedRow());

  const nearMiss = await submitFinish({
    userId: ALICE,
    matchId: MATCH_ID,
    typedText: TEXT.slice(0, TEXT.length - 1),
    nowMs: GO + 5_000,
  });
  assert.equal(nearMiss.accepted, false);
  assert.equal(nearMiss.reason, "incomplete");
  assert.equal(matchWrites(fake).length, 0);

  const typo = `${TEXT.slice(0, 5)}Z${TEXT.slice(6)}`;
  const withTypo = await submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: typo, nowMs: GO + 6_000 });
  assert.equal(withTypo.reason, "incomplete");
  assert.equal(withTypo.firstMismatch, 5, "the refusal says where it went wrong");

  const now = GO + 30_000;
  const done = await submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: now });
  assert.equal(done.accepted, true);
  assert.equal(done.seatState.finished, true);
  assert.equal(done.seatState.finishedAtMs, now);
  assert.equal(done.seatState.elapsedMs, 30_000, "elapsed is measured from the server's GO");
  assert.equal(done.seatState.accuracy, 100);
  assert.equal(done.seatState.wpm, Math.round(TEXT.length / 5 / 0.5));
  assert.equal(done.match.player1CompletedAt?.getTime(), now);
  // One seat finished: the race stays live for the opponent's remaining time.
  assert.equal(done.match.status, MATCH_STATUS.PLAYING);
  assert.equal(settlement.rating.length, 0, "a single finish settles nothing");
  assert.equal(matchWrites(fake).length, 1);
});

test("finish: the second finish decides the winner and settles EXACTLY once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { submitFinish } = await loadStore();
  seed(fake, armedRow());

  await submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 20_000 });
  const second = await submitFinish({ userId: BOB, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 25_000 });

  assert.equal(second.accepted, true);
  assert.equal(second.outcome.settled, true);
  assert.equal(second.outcome.winnerSeat, SEAT.PLAYER1, "the EARLIER verified finish wins");
  assert.equal(second.outcome.resolutionReason, RESOLUTION.FINISH);
  assert.equal(second.match.status, MATCH_STATUS.FINISHED);
  assert.equal(second.match.result, RESULT.PLAYER1);
  assert.equal(second.match.winnerId, ALICE);
  assert.ok(second.match.endedAt);

  settledOnce("both finishes");
  assert.equal(userWrites(fake).filter((w) => "gamesWon" in w.values).length, 1);
  assert.equal(userWrites(fake).filter((w) => "gamesLost" in w.values).length, 1);

  const writesAfterSettle = fake.state.writes.length;

  // A replayed finish is a duplicate: no new state, and NO second settlement.
  const replay = await submitFinish({ userId: BOB, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 26_000 });
  assert.equal(replay.accepted, false);
  assert.equal(replay.reason, "duplicate");
  assert.equal(replay.seatState.finishedAtMs, GO + 25_000, "the first verified finish stands");

  const replayWinner = await submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 27_000 });
  assert.equal(replayWinner.reason, "duplicate");

  assert.equal(fake.state.writes.length, writesAfterSettle, "a replay writes nothing at all");
  assert.equal(settlement.rating.length, 1, "rating must never be awarded twice");
  assert.equal(settlement.trophy.length, 1, "trophies must never be awarded twice");
});

test("finish: a false completion and client-supplied results are ignored outright", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { submitFinish } = await loadStore();
  seed(fake, armedRow());

  // A client trying to declare itself the winner with a partial submission, and
  // sprinkling in every number it is not allowed to decide.
  const forged = await submitFinish({
    userId: ALICE,
    matchId: MATCH_ID,
    typedText: TEXT.slice(0, 10),
    winner: "player1",
    wpm: 999,
    accuracy: 100,
    elapsedMs: 1,
    completionTime: 1,
    elo: 500,
    rating: 500,
    trophies: 999,
    nowMs: GO + 1_000,
  });
  assert.equal(forged.accepted, false);
  assert.equal(forged.reason, "incomplete");
  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);
  assert.equal(matchWrites(fake).length, 0);

  // Even with a legitimate full submission, the stored numbers are the server's
  // — never the ones the request carried.
  const done = await submitFinish({
    userId: ALICE,
    matchId: MATCH_ID,
    typedText: TEXT,
    wpm: 999,
    accuracy: 1,
    elapsedMs: 1,
    nowMs: GO + 30_000,
  });
  assert.equal(done.seatState.wpm, Math.round(TEXT.length / 5 / 0.5));
  assert.notEqual(done.seatState.wpm, 999);
  assert.equal(done.seatState.accuracy, 100);
  assert.notEqual(done.seatState.accuracy, 1);
  assert.equal(done.seatState.elapsedMs, 30_000);
  assert.notEqual(done.seatState.elapsedMs, 1);
});

test("finish: an error made earlier is never laundered by a clean final submission", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { recordProgress, submitFinish } = await loadStore();
  seed(fake, armedRow());

  // A typo checkpoint, then a perfect finish: accuracy reflects the whole race.
  await recordProgress({
    userId: ALICE,
    matchId: MATCH_ID,
    typedText: `${TEXT.slice(0, 10)}Z${TEXT.slice(11, 30)}`,
    nowMs: GO + 1_000,
  });
  const done = await submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 20_000 });
  assert.equal(done.accepted, true);
  assert.equal(done.seatState.errors, 1, "the mistake stays on the record");
  assert.ok(done.seatState.accuracy < 100);
});

// ════════════════════════════════════════════════════════════════════════
// 5. Forfeit and the hard limit
// ════════════════════════════════════════════════════════════════════════

test("forfeit: leaving hands an active race to the opponent and settles once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { forfeitMatch } = await loadStore();
  seed(fake, armedRow());

  const result = await forfeitMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: GO + 5_000 });
  assert.equal(result.forfeited, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.match.status, MATCH_STATUS.FINISHED);
  assert.equal(result.match.result, RESULT.PLAYER2, "the seat that stayed wins");
  assert.equal(result.match.winnerId, BOB);
  assert.equal(result.match.resolutionReason, RESOLUTION.FORFEIT, "a walkover is not a typed win");
  settledOnce("forfeit");
  assert.equal(settlement.rating[0].winnerClerkId, BOB);
  assert.equal(settlement.rating[0].loserClerkId, ALICE);
});

test("forfeit: a still-open lobby is cancelled and settles NOTHING", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { forfeitMatch } = await loadStore();
  seed(fake, {
    ...armedRow({ status: MATCH_STATUS.WAITING }),
    player2Id: null,
    goAt: null,
    raceSeed: null,
    passageId: null,
  });

  const result = await forfeitMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: GO });
  assert.equal(result.cancelled, true);
  assert.equal(result.forfeited, false);
  assert.equal(result.match.status, MATCH_STATUS.CANCELLED);
  assert.equal(settlement.rating.length, 0, "an abandoned lobby is not a rated match");
  assert.equal(settlement.trophy.length, 0);
});

test("forfeit: a terminal match is a no-op, not an error", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { forfeitMatch } = await loadStore();
  seed(fake, { ...armedRow(), status: MATCH_STATUS.FINISHED, result: RESULT.PLAYER1 });

  const result = await forfeitMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: GO + 9_000 });
  assert.equal(result.forfeited, false);
  assert.equal(result.cancelled, false);
  assert.equal(matchWrites(fake).length, 0);
  assert.equal(settlement.rating.length, 0);
});

test("deadline: a due race is decided from checkpoints and settles once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { resolveDueRace } = await loadStore();
  const state = createRaceState({ version: 1 });
  state.seats[SEAT.PLAYER1] = { ...state.seats[SEAT.PLAYER1], charsTyped: 30 };
  state.seats[SEAT.PLAYER2] = { ...state.seats[SEAT.PLAYER2], charsTyped: 12 };
  seed(
    fake,
    armedRow({
      goAt: new Date(GO - RACE_LIMIT_MS - 5_000),
      raceState: state,
      player1CharsTyped: 30,
      player2CharsTyped: 12,
    }),
  );

  const result = await resolveDueRace({ matchId: MATCH_ID, nowMs: GO });
  assert.equal(result.resolved, true);
  assert.equal(result.reason, RESOLUTION.DEADLINE);
  assert.equal(result.match.status, MATCH_STATUS.FINISHED);
  assert.equal(result.match.result, RESULT.PLAYER1, "the seat that got further wins");
  settledOnce("deadline");
});

test("deadline: it does nothing before the limit, and nothing a second time", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { resolveDueRace } = await loadStore();
  seed(fake, armedRow({ goAt: new Date(GO) }));

  const early = await resolveDueRace({ matchId: MATCH_ID, nowMs: GO + 1_000 });
  assert.equal(early.resolved, false);
  assert.equal(early.reason, "not_due");
  assert.equal(matchWrites(fake).length, 0);
  assert.equal(settlement.rating.length, 0);

  const due = await resolveDueRace({ matchId: MATCH_ID, nowMs: GO + RACE_LIMIT_MS + 1 });
  assert.equal(due.resolved, true);
  assert.equal(settlement.rating.length, 1);

  // The row is terminal now, so a repeat scheduler pass is inert.
  const repeat = await resolveDueRace({ matchId: MATCH_ID, nowMs: GO + RACE_LIMIT_MS + 2 });
  assert.equal(repeat.resolved, false);
  assert.equal(settlement.rating.length, 1, "the race settles exactly once");
  assert.equal(settlement.trophy.length, 1);
});

test("deadline: an already-resolved race is not resolved again", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { resolveDueRace } = await loadStore();
  const state = createRaceState({ version: 2 });
  state.resolvedAtMs = GO - 1;
  state.resolutionReason = RESOLUTION.DEADLINE;
  seed(fake, armedRow({ goAt: new Date(GO - RACE_LIMIT_MS - 5_000), raceState: state }));

  const result = await resolveDueRace({ matchId: MATCH_ID, nowMs: GO });
  assert.equal(result.resolved, false);
  assert.equal(result.reason, "already_resolved");
  assert.equal(matchWrites(fake).length, 0);
});

// ════════════════════════════════════════════════════════════════════════
// 6. Security — a player only ever touches their own seat
// ════════════════════════════════════════════════════════════════════════

test("security: a checkpoint from one seat cannot move the other seat", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { recordProgress } = await loadStore();
  seed(fake, armedRow());

  const asAlice = await recordProgress({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT.slice(0, 30), nowMs: GO + 1_000 });
  assert.equal(asAlice.seat, SEAT.PLAYER1);
  assert.equal(asAlice.match.player2CharsTyped, 0, "the opponent's progress is untouched");
  assert.equal(asAlice.match.raceState.seats.player2.charsTyped, 0);
  assert.equal(asAlice.match.raceState.seats.player2.errors, 0);
  assert.equal(asAlice.match.raceState.seats.player2.finished, false);

  // …and Bob's later checkpoint writes only his own seat.
  const asBob = await recordProgress({ userId: BOB, matchId: MATCH_ID, typedText: TEXT.slice(0, 9), nowMs: GO + 1_100 });
  assert.equal(asBob.seat, SEAT.PLAYER2);
  assert.equal(asBob.match.player2CharsTyped, 9);
  assert.equal(asBob.match.player1CharsTyped, 30, "Alice's progress is preserved");
});

test("security: a finish from one seat cannot finish the opponent's race", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { submitFinish } = await loadStore();
  seed(fake, armedRow());

  const alice = await submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 10_000 });
  assert.equal(alice.seat, SEAT.PLAYER1);
  assert.equal(alice.match.player2CompletedAt ?? null, null, "Bob has not completed anything");
  assert.equal(alice.match.raceState.seats.player2.finished, false);
  // A malformed/empty submission for Bob is refused, so he cannot be marked done
  // by accident or by replaying Alice's packet under his own id.
  const bobEmpty = await submitFinish({ userId: BOB, matchId: MATCH_ID, typedText: "", nowMs: GO + 11_000 });
  assert.equal(bobEmpty.accepted, false);
  assert.equal(bobEmpty.reason, "incomplete");
  assert.equal(bobEmpty.seat, SEAT.PLAYER2);
  assert.equal(alice.match.player2CompletedAt ?? null, null);
  assert.equal(settlement.rating.length, 0);
});

test("security: settlement routes through the shared writers only, with the canonical key", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { submitFinish } = await loadStore();
  seed(fake, armedRow());

  await submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 10_000 });
  await submitFinish({ userId: BOB, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 11_000 });

  // The ONLY rating/trophy calls are the two shared writers, exactly once each,
  // with the caller's transaction and the game key as a literal.
  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.trophy.length, 1);
  assert.equal(settlement.rating[0].gameKey, "speed-typing");
  assert.equal(settlement.trophy[0].gameKey, "speed-typing");
  assert.equal(settlement.rating[0].winnerClerkId, ALICE);
  assert.equal(settlement.rating[0].loserClerkId, BOB);
  // A win is not a draw.
  assert.equal(settlement.rating[0].result, undefined);
  assert.equal(settlement.trophy[0].result, undefined);
  // And no token/balance/payout write exists anywhere in the flow.
  assert.equal(fake.state.tables.has("tokenTransactions"), false);
});

test("assumption: the seeded prompt is the one the row races", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const row = armedRow();
  assert.equal(passageForRow(row)?.text, TEXT, "the fixture row must carry the seeded prompt");
});

// ════════════════════════════════════════════════════════════════════════
// 7. Practice vs AI — the bot genuinely races and settles nothing
// ════════════════════════════════════════════════════════════════════════

const practiceRow = (overrides = {}) =>
  armedRow({
    isAi: true,
    player2Id: SPEED_TYPING_AI_PLAYER_ID,
    aiDifficulty: "normal",
    ...overrides,
  });

/** The bot's finish instant for the seeded passage, from the shared profile. */
function botFinishElapsedMs(difficulty = "normal") {
  const wpm = { easy: 30, normal: 45, hard: 65 }[difficulty];
  return Math.ceil(TEXT.length / ((wpm * 5) / 60_000));
}

test("practice: createAiMatch seats the bot, arms the race and marks it unrated", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { createAiMatch } = await loadStore();
  installClock(t, GO);

  const { match } = await createAiMatch({ userId: ALICE, difficulty: "hard" });
  assert.equal(match.player1Id, ALICE);
  assert.equal(match.player2Id, SPEED_TYPING_AI_PLAYER_ID);
  assert.equal(match.isAi, true);
  assert.equal(match.aiDifficulty, "hard");
  assert.equal(match.status, MATCH_STATUS.PLAYING);
  // Armed exactly like a real join: a seed, a passage pair and a future GO.
  assert.ok(match.raceSeed != null);
  assert.ok(match.passageId);
  assert.equal(match.passageVersion, PASSAGE_VERSION);
  assert.equal(match.goAt.getTime(), GO + RACE_COUNTDOWN_MS);
  // A practice row is never mirrored into the queue lifecycle.
  assert.equal(settlement.queue.length, 0);
});

test("practice: createAiMatch coerces an unknown difficulty onto the shared scale", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const { createAiMatch } = await loadStore();
  installClock(t, GO);
  const { match } = await createAiMatch({ userId: ALICE, difficulty: "nonsense" });
  assert.equal(match.aiDifficulty, "normal");
});

test("practice: the bot's cursor advances from the server clock on a read", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { fetchMatch } = await loadStore();
  seed(fake, practiceRow());
  installClock(t, GO + 20_000);

  const first = await fetchMatch({ userId: ALICE, matchId: MATCH_ID });
  assert.equal("error" in first, false);
  const bot = first.dto.race.opponent;
  assert.ok(bot.charsTyped > 0, "the bot has made progress");
  assert.equal(bot.finished, false, "20s in, the normal bot is still typing");

  // Further along the clock, further along the passage — never backwards.
  Date.now = () => GO + 40_000;
  const second = await fetchMatch({ userId: ALICE, matchId: MATCH_ID });
  assert.ok(second.dto.race.opponent.charsTyped > bot.charsTyped);

  // A stale (earlier) instant cannot rewind the bot.
  const rewound = await (await loadStore()).advanceAiRace({ matchId: MATCH_ID, nowMs: GO + 5_000 });
  assert.equal(rewound.match.player2CharsTyped, second.dto.race.opponent.charsTyped);
});

test("practice: the bot finishes, and a human who finishes later loses to it unrated", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { submitFinish } = await loadStore();
  seed(fake, practiceRow());

  // The human types the whole passage AFTER the bot's own finish instant, so
  // the finish is submitted with the bot already done.
  const elapsed = botFinishElapsedMs("normal") + 20_000;
  const result = await submitFinish({
    userId: ALICE,
    matchId: MATCH_ID,
    typedText: TEXT,
    nowMs: GO + elapsed,
  });

  assert.equal(result.accepted, true);
  // Both seats are finished, and the bot was quicker — it wins.
  const row = result.match;
  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, RESULT.PLAYER2);
  assert.equal(row.winnerId, SPEED_TYPING_AI_PLAYER_ID);
  assert.equal(row.raceState.seats.player2.finished, true);
  assert.equal(row.raceState.seats.player1.finished, true);
  // A practice race touches NO competitive progression at all.
  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);
  assert.equal(settlement.queue.length, 0);
});

test("practice: a human who finishes FIRST ends the race at once and wins", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { submitFinish } = await loadStore();
  seed(fake, practiceRow());

  // The human beats the bot comfortably — well BEFORE the bot's own finish
  // instant. Nothing advances the bot after this point (a migrated client only
  // reads on a socket push or a tab focus), so the race has to resolve right
  // here. Waiting for a bot finish that no read would ever simulate left the
  // player on a "race complete" screen with no result and no way on.
  const elapsed = Math.max(1_000, Math.floor(botFinishElapsedMs("normal") / 2));
  assert.ok(elapsed < botFinishElapsedMs("normal"), "the human is genuinely quicker");

  const result = await submitFinish({
    userId: ALICE,
    matchId: MATCH_ID,
    typedText: TEXT,
    nowMs: GO + elapsed,
  });

  assert.equal(result.accepted, true);
  const row = result.match;

  // Resolved in the SAME transaction as the finish, the earlier (human)
  // instant deciding it.
  assert.equal(result.outcome?.settled, true);
  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, RESULT.PLAYER1);
  assert.equal(row.winnerId, ALICE);
  assert.equal(row.raceState.seats.player1.finished, true);
  assert.equal(row.raceState.seats.player2.finished, false, "the bot never had to finish");

  // Still practice: nothing competitive is recorded.
  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);
  assert.equal(settlement.queue.length, 0);
});

test("practice: the deadline verdict sees the bot's real progress", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { resolveDueRace } = await loadStore();
  seed(fake, practiceRow({ goAt: new Date(GO) }));

  const result = await resolveDueRace({ matchId: MATCH_ID, nowMs: GO + RACE_LIMIT_MS + 1_000 });
  assert.equal(result.resolved, true);
  // The bot finished long before the limit, so it wins by finish, not by the
  // deadline tiebreak — and still settles nothing.
  assert.equal(result.reason, RESOLUTION.FINISH);
  assert.equal(result.match.result, RESULT.PLAYER2);
  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);
});

test("practice: advanceAiRace is a no-op for a human match", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { advanceAiRace } = await loadStore();
  seed(fake, armedRow());

  const result = await advanceAiRace({ matchId: MATCH_ID, nowMs: GO + 60_000 });
  assert.equal(result.advanced, false);
  assert.equal(matchWrites(fake).length, 0, "a human match is never advanced or written");
});
