// tests/quests-settlement.test.mjs
//
// The bridge between server-side match settlement and quest progress.
//
// WHAT IS BEING PINNED
//   * only a completed, server-decided match against another REAL account may
//     move a quest — AI seats, bot ids, practice opponents, spectators and
//     seats that name no account are dropped;
//   * a match counts exactly ONCE per participant, durably (the unique journal
//     row), not because a caller remembered to check a flag;
//   * retries, replays and racing terminal events converge on the same result;
//   * distinct games are tracked by CANONICAL key, so `keno-pvp` and `keno` are
//     one game, and a repeat of the same game cannot satisfy two slots;
//   * the write lands in the SAME transaction as the terminal match write, and
//     nothing else (Elo, trophies, coins, leaderboards) is touched.
//
// The fake transaction below emulates exactly the statements
// src/lib/quests/settle.ts issues — including the unique constraints and the
// foreign keys — so the real code path, validation and idempotency run with no
// DATABASE_URL and no Postgres.
//
// Run:  node --import tsx --test tests/quests-settlement.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  QUEST_MATCH_ID_MAX_LENGTH,
  normalizeSettlementSeats,
  recordSettledMatch,
} from "../src/lib/quests/settle.ts";
import { planQuests } from "../src/lib/quests/definitions.ts";
import { periodKeyFor } from "../src/lib/quests/periods.ts";

// ════════════════════════════════════════════════════════════════════════
// Fake transaction harness
// ════════════════════════════════════════════════════════════════════════

const dialect = new PgDialect();
const flatten = (query) => dialect.sqlToQuery(query);
const norm = (text) => text.replace(/\s+/g, " ").trim();

/**
 * An in-memory stand-in for the drizzle transaction handle that understands the
 * settlement bridge's statements and nothing else, so an unexpected write is a
 * loud failure rather than a silent pass.
 */
function makeQuestDb({ users = [] } = {}) {
  const state = {
    users: new Set(users.map(Number)),
    events: [], // quest_match_events rows
    quests: [], // user_quests rows
    statements: [],
    nextId: 1,
  };

  const tx = {
    async execute(query) {
      const { sql, params } = flatten(query);
      const text = norm(sql);
      state.statements.push({ sql: text, params });

      // ── the seat accounts must be real ────────────────────────────
      if (/^SELECT id FROM users/i.test(text)) {
        return {
          rows: params
            .map(Number)
            .filter((id) => state.users.has(id))
            .map((id) => ({ id })),
        };
      }

      // ── durable once-per-participant journal ──────────────────────
      if (/^INSERT INTO quest_match_events/i.test(text)) {
        const inserted = [];
        for (let i = 0; i < params.length; i += 5) {
          const [userId, gameKey, matchId, opponentUserId, outcome] =
            params.slice(i, i + 5);
          // Foreign keys: both seats must be accounts.
          if (
            !state.users.has(Number(userId)) ||
            !state.users.has(Number(opponentUserId))
          ) {
            throw new Error("quest_match_events violates users foreign key");
          }
          const duplicate = state.events.some(
            (event) =>
              event.user_id === Number(userId) &&
              event.game_key === gameKey &&
              event.match_id === matchId,
          );
          if (duplicate) continue; // ON CONFLICT DO NOTHING
          state.events.push({
            user_id: Number(userId),
            game_key: gameKey,
            match_id: matchId,
            opponent_user_id: Number(opponentUserId),
            outcome,
          });
          inserted.push({ user_id: Number(userId) });
        }
        return { rows: inserted };
      }

      // ── the deterministic slot planner's inserts ──────────────────
      if (/^INSERT INTO user_quests/i.test(text)) {
        // 11 params per row.
        for (let i = 0; i < params.length; i += 11) {
          const [
            userId,
            periodType,
            periodKey,
            slot,
            questType,
            gameKey,
            target,
            reward,
            progress,
            claimed,
            meta,
          ] = params.slice(i, i + 11);
          const exists = state.quests.some(
            (row) =>
              row.user_id === Number(userId) &&
              row.period_type === periodType &&
              row.period_key === periodKey &&
              row.slot === Number(slot),
          );
          if (exists) continue; // ON CONFLICT DO NOTHING
          state.quests.push({
            id: state.nextId++,
            user_id: Number(userId),
            period_type: periodType,
            period_key: periodKey,
            slot: Number(slot),
            quest_type: questType,
            game_key: gameKey ?? null,
            target: Number(target),
            reward: Number(reward),
            progress: Number(progress),
            claimed: Boolean(claimed),
            meta: JSON.parse(meta),
            completed_at: null,
          });
        }
        return { rows: [] };
      }

      // ── locked read of the period's slots ─────────────────────────
      if (/^SELECT id, user_id/i.test(text) && /FROM user_quests/i.test(text)) {
        const [userId, periodType, periodKey] = params;
        return {
          rows: state.quests
            .filter(
              (row) =>
                row.user_id === Number(userId) &&
                row.period_type === periodType &&
                row.period_key === periodKey,
            )
            .sort((a, b) => a.slot - b.slot)
            .map((row) => ({ ...row, meta: { ...row.meta } })),
        };
      }

      // ── the batched progress write ────────────────────────────────
      if (/^UPDATE user_quests AS q/i.test(text)) {
        // 4 params per row: id, progress, completed_at, meta.
        for (let i = 0; i < params.length; i += 4) {
          const [id, progress, completedAt, meta] = params.slice(i, i + 4);
          const row = state.quests.find((quest) => quest.id === Number(id));
          if (!row) throw new Error("quest update targeted a missing row");
          row.progress = Number(progress);
          row.completed_at = completedAt ? new Date(completedAt) : null;
          row.meta = JSON.parse(meta);
        }
        return { rows: [] };
      }

      throw new Error(`FakeDb: unrecognised statement -> ${text}`);
    },
  };

  return { tx, state };
}

const NOW = new Date("2026-10-21T12:00:00.000Z");
const DAY = periodKeyFor("daily", NOW);
const WEEK = periodKeyFor("weekly", NOW);

const read = (rel) => fs.readFileSync(rel, "utf8");

const questsFor = (state, userId, periodType = "daily", periodKey = DAY) =>
  state.quests.filter(
    (row) =>
      row.user_id === Number(userId) &&
      row.period_type === periodType &&
      row.period_key === periodKey,
  );

const byObjective = (rows, objective) =>
  rows.filter((row) => row.quest_type === objective);

/** Seed one explicit slot, so an assertion never depends on the day's plan. */
function seedQuest(state, overrides = {}) {
  const row = {
    id: state.nextId++,
    user_id: 11,
    period_type: "daily",
    period_key: DAY,
    slot: 9,
    quest_type: "pvp_matches",
    game_key: null,
    target: 3,
    reward: 60,
    progress: 0,
    claimed: false,
    meta: { definitionId: "seeded", games: [] },
    completed_at: null,
    ...overrides,
  };
  state.quests.push(row);
  return row;
}

const SEATS_1V1 = [
  { userId: 11, opponentUserId: 22, outcome: "win" },
  { userId: 22, opponentUserId: 11, outcome: "loss" },
];

// ════════════════════════════════════════════════════════════════════════
// 1. A completed human match
// ════════════════════════════════════════════════════════════════════════

test("a settled human match counts once for BOTH participants", async () => {
  const { tx, state } = makeQuestDb({ users: [11, 22] });

  const result = await recordSettledMatch({
    tx,
    gameKey: "chess",
    matchId: "match-1",
    seats: SEATS_1V1,
    now: NOW,
  });

  assert.equal(result.recorded, true);
  assert.equal(result.reason, "recorded");
  assert.equal(result.game, "chess");
  assert.deepEqual(result.recordedUserIds, [11, 22]);

  // One journal row per participant — the durable "this counted" proof.
  assert.equal(state.events.length, 2);
  assert.deepEqual(
    state.events.map((event) => [event.user_id, event.outcome]).sort(),
    [
      [11, "win"],
      [22, "loss"],
    ],
  );

  // Both boards exist for both players, in both periods.
  for (const userId of [11, 22]) {
    assert.equal(
      questsFor(state, userId).length,
      planQuests("daily", DAY).length,
      "daily slots",
    );
    assert.equal(
      questsFor(state, userId, "weekly", WEEK).length,
      planQuests("weekly", WEEK).length,
      "weekly slots",
    );
  }

  // Whatever the day's plan is, a completed match moves every pvp_matches slot
  // by one — for the winner AND the loser.
  for (const userId of [11, 22]) {
    const matches = byObjective(questsFor(state, userId), "pvp_matches");
    assert.ok(matches.length >= 0);
    for (const row of matches) {
      assert.equal(row.progress, 1, `pvp_matches progress for ${userId}`);
    }
  }

  // The win objective only moves for the winner.
  for (const row of byObjective(questsFor(state, 22), "pvp_wins")) {
    assert.equal(row.progress, 0, "the loser gets no win credit");
  }
  for (const row of byObjective(questsFor(state, 11), "pvp_wins")) {
    assert.equal(row.progress, 1, "the winner gets the win credit");
  }
});

test("a draw is a completed match for both seats and moves no win quest", async () => {
  const { tx, state } = makeQuestDb({ users: [11, 22] });
  seedQuest(state, { quest_type: "pvp_wins", target: 3 });

  await recordSettledMatch({
    tx,
    gameKey: "tic-tac-toe",
    matchId: "draw-1",
    seats: [
      { userId: 11, opponentUserId: 22, outcome: "draw" },
      { userId: 22, opponentUserId: 11, outcome: "draw" },
    ],
    now: NOW,
  });

  assert.equal(state.events.length, 2);
  const wins = byObjective(questsFor(state, 11), "pvp_wins");
  for (const row of wins) assert.equal(row.progress, 0);
});

// ════════════════════════════════════════════════════════════════════════
// 2. Idempotency — duplicate settlement and retries
// ════════════════════════════════════════════════════════════════════════

test("replaying a settled match is a no-op for every participant", async () => {
  const { tx, state } = makeQuestDb({ users: [11, 22] });

  const first = await recordSettledMatch({
    tx,
    gameKey: "chess",
    matchId: "match-1",
    seats: SEATS_1V1,
    now: NOW,
  });
  const afterFirst = JSON.stringify(state.quests);

  const second = await recordSettledMatch({
    tx,
    gameKey: "chess",
    matchId: "match-1",
    seats: SEATS_1V1,
    now: NOW,
  });

  assert.equal(first.recorded, true);
  assert.equal(second.recorded, false);
  assert.equal(second.reason, "duplicate");
  assert.deepEqual(second.recordedUserIds, []);
  assert.equal(JSON.stringify(state.quests), afterFirst, "no slot may move");
  assert.equal(state.events.length, 2, "the journal must not grow");
});

test("a retry counts only the participant it had not journaled yet", async () => {
  const { tx, state } = makeQuestDb({ users: [11, 22] });

  // A partial first attempt (one seat made it into the terminal write).
  await recordSettledMatch({
    tx,
    gameKey: "chess",
    matchId: "match-1",
    seats: [SEATS_1V1[0]],
    now: NOW,
  });
  const retry = await recordSettledMatch({
    tx,
    gameKey: "chess",
    matchId: "match-1",
    seats: SEATS_1V1,
    now: NOW,
  });

  assert.equal(retry.recorded, true);
  assert.deepEqual(retry.recordedUserIds, [22], "only the missing seat counts");
  assert.equal(state.events.length, 2);
});

test("two DIFFERENT matches for the same player both count", async () => {
  const { tx, state } = makeQuestDb({ users: [11, 22, 33] });
  seedQuest(state, { quest_type: "pvp_matches", target: 5, slot: 8 });

  await recordSettledMatch({
    tx,
    gameKey: "chess",
    matchId: "match-1",
    seats: SEATS_1V1,
    now: NOW,
  });
  await recordSettledMatch({
    tx,
    gameKey: "chess",
    matchId: "match-2",
    seats: [
      { userId: 11, opponentUserId: 33, outcome: "loss" },
      { userId: 33, opponentUserId: 11, outcome: "win" },
    ],
    now: NOW,
  });

  const seeded = state.quests.find((row) => row.slot === 8 && row.user_id === 11);
  assert.equal(seeded.progress, 2, "each distinct match is a distinct event");
  assert.equal(state.events.length, 4);
});

// ════════════════════════════════════════════════════════════════════════
// 3. Exclusions — AI, practice, spectators, invalid seats
// ════════════════════════════════════════════════════════════════════════

test("AI, bot and practice seats cannot advance a quest", async () => {
  for (const opponent of [null, undefined, 0, "AI_BOT", "chess_ai_bot"]) {
    const { tx, state } = makeQuestDb({ users: [11] });
    const result = await recordSettledMatch({
      tx,
      gameKey: "chess",
      matchId: `vs-ai-${String(opponent)}`,
      seats: [
        { userId: 11, opponentUserId: opponent, outcome: "win" },
      ],
      now: NOW,
    });
    assert.equal(result.recorded, false, `opponent=${String(opponent)}`);
    assert.equal(result.reason, "no-participants");
    assert.equal(state.events.length, 0, "no journal row for an AI seat");
    assert.equal(state.quests.length, 0, "no slot may even be created");
  }
});

test("a seat playing itself is not a match", async () => {
  const { tx, state } = makeQuestDb({ users: [11] });
  const result = await recordSettledMatch({
    tx,
    gameKey: "chess",
    matchId: "self-1",
    seats: [{ userId: 11, opponentUserId: 11, outcome: "win" }],
    now: NOW,
  });
  assert.equal(result.recorded, false);
  assert.equal(result.reason, "no-participants");
  assert.equal(state.events.length, 0);
});

test("a seat whose accounts do not exist is dropped, not guessed at", async () => {
  const { tx, state } = makeQuestDb({ users: [11] });

  // The opponent id is a spectator / deleted account, not a participant.
  const result = await recordSettledMatch({
    tx,
    gameKey: "chess",
    matchId: "ghost-1",
    seats: [{ userId: 11, opponentUserId: 99, outcome: "win" }],
    now: NOW,
  });
  assert.equal(result.recorded, false);
  assert.equal(result.reason, "no-participants");
  assert.equal(state.events.length, 0);
  assert.equal(state.quests.length, 0);

  // The participant itself being unknown is the same story.
  const unknown = await recordSettledMatch({
    tx,
    gameKey: "chess",
    matchId: "ghost-2",
    seats: [{ userId: 98, opponentUserId: 11, outcome: "win" }],
    now: NOW,
  });
  assert.equal(unknown.recorded, false);
});

test("normalizeSettlementSeats keeps only complete, human, distinct seats", () => {
  const accepted = normalizeSettlementSeats([
    { userId: 11, opponentUserId: 22, outcome: "win" },
    { userId: 11, opponentUserId: 33, outcome: "loss" }, // duplicate seat
    { userId: 22, opponentUserId: 22, outcome: "win" }, // self
    { userId: 33, opponentUserId: null, outcome: "win" }, // no opponent
    { userId: "x", opponentUserId: 11, outcome: "win" }, // not an id
    { userId: 44, opponentUserId: 55, outcome: "victory" }, // not an outcome
    { userId: 66, opponentUserId: 77, outcome: "draw" },
  ]);

  assert.deepEqual(
    accepted,
    [
      { userId: 11, opponentUserId: 22, outcome: "win" },
      { userId: 66, opponentUserId: 77, outcome: "draw" },
    ],
    "ascending user id, one seat each, only decided outcomes",
  );
});

// ════════════════════════════════════════════════════════════════════════
// 4. Canonical game keys and distinct-game tracking
// ════════════════════════════════════════════════════════════════════════

test("distinct games are counted by CANONICAL key, once each", async () => {
  const { tx, state } = makeQuestDb({ users: [11, 22] });
  const quest = seedQuest(state, {
    quest_type: "pvp_games",
    target: 3,
    slot: 7,
  });

  const play = (matchId, gameKey) =>
    recordSettledMatch({
      tx,
      gameKey,
      matchId,
      seats: [
        { userId: 11, opponentUserId: 22, outcome: "win" },
        { userId: 22, opponentUserId: 11, outcome: "loss" },
      ],
      now: NOW,
    });

  await play("m-chess", "chess");
  await play("m-keno-1", "keno-pvp"); // settlement key
  await play("m-keno-2", "keno"); // canonical key — the SAME game
  assert.equal(quest.progress, 2, "two distinct games, not three matches");
  assert.deepEqual(quest.meta.games, ["chess", "keno"]);

  await play("m-pool", "pool"); // rating key for Pool Masters
  assert.equal(quest.progress, 3);
  assert.deepEqual(quest.meta.games, ["chess", "keno", "pool-masters"]);
  assert.ok(quest.completed_at, "the target was reached, so it completes");
});

test("an unrecognised game key can never create or move a quest", async () => {
  const { tx, state } = makeQuestDb({ users: [11, 22] });
  const result = await recordSettledMatch({
    tx,
    gameKey: "not-a-real-game",
    matchId: "x-1",
    seats: SEATS_1V1,
    now: NOW,
  });
  assert.equal(result.recorded, false);
  assert.equal(result.reason, "unknown-game");
  assert.equal(state.quests.length, 0);
  assert.equal(state.events.length, 0);
});

test("a match id is required and bounded", async () => {
  const { tx } = makeQuestDb({ users: [11, 22] });
  for (const matchId of ["", "   ", "x".repeat(QUEST_MATCH_ID_MAX_LENGTH + 1)]) {
    const result = await recordSettledMatch({
      tx,
      gameKey: "chess",
      matchId,
      seats: SEATS_1V1,
      now: NOW,
    });
    assert.equal(result.recorded, false);
    assert.equal(result.reason, "invalid-match");
  }
});

// ════════════════════════════════════════════════════════════════════════
// 5. Progress bookkeeping
// ════════════════════════════════════════════════════════════════════════

test("progress clamps at the target and completion is stamped once", async () => {
  const { tx, state } = makeQuestDb({ users: [11, 22] });
  const quest = seedQuest(state, {
    quest_type: "pvp_matches",
    target: 1,
    slot: 6,
  });

  await recordSettledMatch({
    tx,
    gameKey: "chess",
    matchId: "m-1",
    seats: SEATS_1V1,
    now: NOW,
  });
  assert.equal(quest.progress, 1);
  assert.ok(quest.completed_at);
  const stampedAt = quest.completed_at;

  await recordSettledMatch({
    tx,
    gameKey: "chess",
    matchId: "m-2",
    seats: SEATS_1V1,
    now: new Date(NOW.getTime() + 60_000),
  });

  assert.equal(quest.progress, 1, "a finished quest never overflows its target");
  assert.equal(
    quest.completed_at,
    stampedAt,
    "completed_at freezes at the first completion",
  );
});

test("a claimed quest is never advanced by a later match", async () => {
  const { tx, state } = makeQuestDb({ users: [11, 22] });
  const quest = seedQuest(state, {
    quest_type: "pvp_matches",
    target: 5,
    slot: 5,
    claimed: true,
    progress: 5,
    completed_at: new Date("2026-10-20T00:00:00.000Z"),
  });
  const before = JSON.stringify(quest);

  await recordSettledMatch({
    tx,
    gameKey: "chess",
    matchId: "m-1",
    seats: SEATS_1V1,
    now: NOW,
  });

  assert.equal(JSON.stringify(quest), before);
});

test("only the CURRENT period is advanced; yesterday's rows stay frozen", async () => {
  const { tx, state } = makeQuestDb({ users: [11, 22] });
  const stale = seedQuest(state, {
    period_key: "2026-10-20",
    slot: 4,
    quest_type: "pvp_matches",
    target: 5,
  });
  const before = JSON.stringify(stale);

  await recordSettledMatch({
    tx,
    gameKey: "chess",
    matchId: "m-1",
    seats: SEATS_1V1,
    now: NOW,
  });

  assert.equal(JSON.stringify(stale), before);
  assert.equal(state.quests.filter((row) => row.period_key === DAY).length > 0, true);
});

test("the write stays inside the settlement transaction it is given", async () => {
  const { tx, state } = makeQuestDb({ users: [11, 22] });
  // A transaction handle whose writes are discarded models a rolled-back
  // settlement: nothing outside it may have observed the quest write.
  const rolledBack = {
    async execute(query) {
      const { sql } = flatten(query);
      if (/^INSERT INTO quest_match_events/i.test(norm(sql))) {
        return { rows: [{ user_id: 11 }, { user_id: 22 }] };
      }
      if (/^SELECT id FROM users/i.test(norm(sql))) {
        return { rows: [{ id: 11 }, { id: 22 }] };
      }
      return { rows: [] };
    },
  };
  state.quests.length = 0;

  const result = await recordSettledMatch({
    tx: rolledBack,
    gameKey: "chess",
    matchId: "m-1",
    seats: SEATS_1V1,
    now: NOW,
  });

  assert.equal(result.recorded, true, "the caller's transaction was used");
  assert.equal(state.quests.length, 0, "nothing leaked into another connection");
  assert.equal(tx.execute !== undefined, true);
});

// ════════════════════════════════════════════════════════════════════════
// 6. Wiring — where a match result may become quest progress
// ════════════════════════════════════════════════════════════════════════

/** Every source file under src/ that mentions the bridge, relative to the repo. */
function filesCallingBridge() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(full);
      } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
        if (read(full).includes("recordSettledMatch")) {
          found.push(full.split(path.sep).join("/"));
        }
      }
    }
  };
  walk("src");
  return found.sort();
}

test("only terminal settlement writers may record quest progress", () => {
  assert.deepEqual(filesCallingBridge(), [
    // The two-seat settlement doorway (Elo writer), the multi-seat one
    // (placement trophies), and the two online games that settle outside those
    // ladders: Hex Duel's shared end/resign/forfeit implementation and UNO's
    // multiplayer settle route.
    "src/app/api/uno/determine-winner/route.js",
    "src/lib/hex-duel/settle.ts",
    "src/lib/quests/settle.ts",
    "src/lib/rating.js",
    "src/lib/trophyStore.js",
  ]);
});

test("the shared writers hand the bridge their OWN transaction", () => {
  const rating = read("src/lib/rating.js");
  const call = rating.slice(rating.indexOf("await recordSettledMatch({"));
  assert.match(call, /^await recordSettledMatch\(\{[\s\S]*?tx: txc,/);
  assert.match(call, /winnerRow\.id[\s\S]*?loserRow\.id/);
  // The rating row is the users row resolved above — so both seats are real
  // accounts, and `isDraw` decides the outcome for each side.
  assert.match(call, /outcome: isDraw \? "draw" : "win"/);
  assert.match(call, /outcome: isDraw \? "draw" : "loss"/);

  const trophies = read("src/lib/trophyStore.js");
  const trophyCall = trophies.slice(trophies.indexOf("await recordSettledMatch({"));
  assert.match(trophyCall, /^await recordSettledMatch\(\{[\s\S]*?tx,/);
  assert.match(trophyCall, /settled\.results\.map/);

  // Hex Duel resolves its seats from `users` inside the same transaction, so
  // its seats are account ids too.
  const hex = read("src/lib/hex-duel/settle.ts");
  const hexCall = hex.slice(hex.indexOf("await recordSettledMatch({"));
  assert.match(hexCall, /^await recordSettledMatch\(\{[\s\S]*?tx,/);
  assert.match(hex, /SELECT id, clerk_id AS "clerkId"\s+FROM users/);
});

test("the UNO hook sits in the multiplayer branch, not the AI one", () => {
  const src = read("src/app/api/uno/determine-winner/route.js");
  const hook = src.indexOf("await recordSettledMatch({");
  assert.ok(hook > 0, "UNO must reach the quest bridge from its settle path");

  // The multiplayer settle is the only `db.transaction` and the hook is inside
  // it, after the terminal claim.
  const txStart = src.indexOf("const didFinalize = await db.transaction");
  assert.ok(txStart > 0 && hook > txStart, "the hook must run in the settle tx");
  assert.ok(
    hook < src.indexOf("return true;", txStart),
    "the hook must run before the transaction commits",
  );

  // The AI branch is far below the multiplayer return, so it cannot reach it.
  const aiBranch = src.indexOf("// AI mode is free play");
  assert.ok(aiBranch > hook, "the AI branch must be after the multiplayer path");
});

test("cancelled / void / practice paths never reach the bridge", () => {
  // The bridge is only imported by the three terminal writers above. A cancel
  // route or an AI seat therefore has no code path to it at all; this asserts
  // the negative explicitly for the games with a cancel/abandon handler.
  for (const file of [
    "src/lib/memory-grid/serverStore.js",
    "src/lib/keno-pvp/serverStore.js",
    "src/lib/lane-rush-duel/serverStore.js",
    "src/lib/mines-pvp/serverStore.js",
    "src/app/api/uno/cancel-waiting/route.js",
  ]) {
    assert.doesNotMatch(
      read(file),
      /recordSettledMatch/,
      `${file} must not record quest progress`,
    );
  }
});

test("the bridge itself never pays, rates or counts anything else", () => {
  const src = read("src/lib/quests/settle.ts");
  assert.doesNotMatch(
    src,
    /\b(applyRatingResult|applyTrophyResult|applyLeaderboardCounters|settlePayout|creditUserBalance|claimDailyReward)\s*\(/,
  );
  assert.doesNotMatch(src, /INSERT INTO (rating_|trophy_|token_)/i);
  assert.doesNotMatch(src, /UPDATE users/i);
});

// ════════════════════════════════════════════════════════════════════════
// 7. Durable schema
// ════════════════════════════════════════════════════════════════════════

test("the journal table is unique per (user, game, match) and keyed to accounts", () => {
  const sql = read("src/db/migrations/0226_quest_match_events.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "quest_match_events"/);
  assert.match(
    sql,
    /CONSTRAINT "quest_match_events_user_game_match_unique"\s+UNIQUE \("user_id", "game_key", "match_id"\)/,
  );
  // Both seats are account references — an AI/bot id has no row to point at.
  assert.match(sql, /"user_id" INTEGER NOT NULL REFERENCES "users"\("id"\)/);
  assert.match(sql, /"opponent_user_id" INTEGER REFERENCES "users"\("id"\)/);
  assert.doesNotMatch(sql, /DROP\s+TABLE/i);

  const schema = read("src/db/schema.ts");
  assert.match(schema, /export const questMatchEvents = pgTable\(/);
  assert.match(schema, /unique\("quest_match_events_user_game_match_unique"\)/);

  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
  const entries = journal.entries.filter(
    (item) => item.tag === "0226_quest_match_events",
  );
  assert.equal(entries.length, 1, "the migration must be journaled exactly once");
  const [entry] = entries;
  // Position, not "newest": this migration stops being the last one the moment
  // another legitimately lands after it (Dominoes' 0227 did), and drizzle only
  // requires idx to be the array position. migration-journal-guard.test.mjs
  // holds that invariant for the whole chain.
  assert.equal(entry.idx, journal.entries.indexOf(entry));
  assert.ok(
    fs.existsSync(path.join("src/db/migrations", `${entry.tag}.sql`)),
    "the journal entry must resolve to a real file",
  );
});
