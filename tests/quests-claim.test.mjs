// tests/quests-claim.test.mjs
//
// The server side of the quest experience: the status read and the claim.
//
// WHAT IS BEING PINNED
//   * a claim is identified by the SESSION, never by a client-supplied user id;
//   * the amount, target, progress, period and claimed flag all come from the
//     stored row — a request cannot set any of them;
//   * an incomplete quest, an already-claimed quest and an expired period are
//     all refused, with no coin movement;
//   * a successful claim credits the stored reward exactly once, writes the
//     ledger row, and returns the canonical balance — including above the
//     retired 100,000-coin cap;
//   * two racing claims (double-click / two tabs) pay exactly once.
//
// The fake transaction emulates the statements src/lib/quests/claim.ts issues
// (row lock read, ledger lookup, conditional `claimed` write, balance credit,
// ledger insert) plus the drizzle slot read the board is built from. No
// DATABASE_URL, no Postgres.
//
// Run:  node --import tsx --test tests/quests-claim.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  QUEST_REWARD_REFERENCE,
  claimQuestReward,
  getQuestStatus,
} from "../src/lib/quests/claim.ts";
import { userQuests } from "../src/db/schema.ts";
import { periodKeyFor } from "../src/lib/quests/periods.ts";

const dialect = new PgDialect();
const flatten = (query) => dialect.sqlToQuery(query);
const norm = (text) => text.replace(/\s+/g, " ").trim();

const NOW = new Date("2026-10-21T12:00:00.000Z");
const DAY = periodKeyFor("daily", NOW);
const WEEK = periodKeyFor("weekly", NOW);

function makeFakeDb({
  users = [{ id: 11, clerkId: "user_a", balance: 1000, peakBalance: 1000 }],
  quests = [],
} = {}) {
  const state = {
    users: users.map((user) => ({ ...user })),
    quests: quests.map((row) => ({ ...row })),
    ledger: [],
    nextQuestId: 100,
    statements: [],
  };

  const userFor = (clerkId) => state.users.find((user) => user.clerkId === clerkId);

  const slotRows = (userId, periodType, periodKey) =>
    state.quests
      .filter(
        (row) =>
          row.user_id === Number(userId) &&
          row.period_type === periodType &&
          row.period_key === periodKey,
      )
      .sort((a, b) => a.slot - b.slot);

  const tx = {
    async execute(query) {
      const { sql, params } = flatten(query);
      const text = norm(sql);
      state.statements.push({ sql: text, params });

      // ── the player, by Clerk id (the session's identity) ──────────
      if (/^SELECT id, balance FROM users/i.test(text)) {
        const user = userFor(params[0]);
        return { rows: user ? [{ id: user.id, balance: user.balance }] : [] };
      }

      // ── the player's own quest row, locked ────────────────────────
      if (/^SELECT id, user_id, period_type/i.test(text)) {
        const [id, userId] = params;
        const row = state.quests.find(
          (quest) => quest.id === Number(id) && quest.user_id === Number(userId),
        );
        return { rows: row ? [{ ...row }] : [] };
      }

      // ── ledger idempotency ────────────────────────────────────────
      if (/^SELECT id FROM token_transactions/i.test(text)) {
        const [referenceType, referenceId] = params;
        const hit = state.ledger.some(
          (entry) =>
            entry.reference_type === referenceType &&
            entry.reference_id === referenceId,
        );
        return { rows: hit ? [{ id: 1 }] : [] };
      }

      // ── conditional claim flag ────────────────────────────────────
      if (/^UPDATE user_quests\s+SET claimed = true/i.test(text)) {
        const [id] = params;
        const row = state.quests.find((quest) => quest.id === Number(id));
        if (!row || row.claimed) return { rows: [] };
        row.claimed = true;
        return { rows: [{ id: row.id }] };
      }

      // ── the credit ────────────────────────────────────────────────
      if (/^UPDATE users SET balance = balance \+/i.test(text)) {
        // Params: reward (twice — `balance + reward` and the peak expression),
        // then the user id.
        const reward = Number(params[0]);
        const userId = Number(params[params.length - 1]);
        const user = state.users.find((entry) => entry.id === userId);
        if (!user) return { rows: [] };
        user.balance += reward;
        user.peakBalance = Math.max(user.peakBalance, user.balance);
        return { rows: [{ balance: user.balance }] };
      }

      // ── the audit ledger ──────────────────────────────────────────
      if (/^INSERT INTO token_transactions/i.test(text)) {
        const [clerkId, type, amount, referenceType, referenceId, note] = params;
        state.ledger.push({
          clerk_id: clerkId,
          type,
          amount: Number(amount),
          reference_type: referenceType,
          reference_id: referenceId,
          note,
        });
        return { rows: [] };
      }

      throw new Error(`FakeDb: unrecognised statement -> ${text}`);
    },

    // The store's read path (src/lib/quests/store.ts) uses the query builder.
    insert() {
      return {
        values: (rows) => ({
          onConflictDoNothing: async () => {
            for (const row of rows) {
              const exists = state.quests.some(
                (quest) =>
                  quest.user_id === row.userId &&
                  quest.period_type === row.periodType &&
                  quest.period_key === row.periodKey &&
                  quest.slot === row.slot,
              );
              if (exists) continue;
              state.quests.push({
                id: state.nextQuestId++,
                user_id: row.userId,
                period_type: row.periodType,
                period_key: row.periodKey,
                slot: row.slot,
                quest_type: row.questType,
                game_key: row.gameKey,
                target: row.target,
                reward: row.reward,
                progress: row.progress,
                claimed: row.claimed,
                meta: row.meta,
                completed_at: row.completedAt,
              });
            }
            return {};
          },
        }),
      };
    },
    select() {
      return {
        from: () => ({
          where: (expression) => ({
            orderBy: async () => {
              const { params } = flatten(expression);
              const [userId, periodType, periodKey] = params;
              return slotRows(userId, periodType, periodKey).map((row) => ({
                ...row,
                meta: { ...row.meta },
              }));
            },
          }),
        }),
      };
    },
  };

  return { tx, state };
}

function questRow(overrides = {}) {
  return {
    id: 1,
    user_id: 11,
    period_type: "daily",
    period_key: DAY,
    slot: 0,
    quest_type: "pvp_matches",
    game_key: null,
    target: 3,
    reward: 75,
    progress: 3,
    claimed: false,
    meta: { definitionId: "daily-three-matches", games: [] },
    completed_at: new Date("2026-10-21T09:00:00.000Z"),
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════
// 1. Authentication and input
// ════════════════════════════════════════════════════════════════════════

test("a signed-out claim or board read is refused, not guessed at", async () => {
  const { tx, state } = makeFakeDb({ quests: [questRow()] });

  for (const clerkId of [null, undefined, ""]) {
    const claim = await claimQuestReward({ clerkId, questId: 1, tx, now: NOW });
    assert.equal(claim.ok, false);
    assert.equal(claim.status, 401);
    assert.equal(claim.reason, "unauthenticated");

    const board = await getQuestStatus({ clerkId, tx, now: NOW });
    assert.equal(board.ok, false);
    assert.equal(board.status, 401);
  }

  assert.equal(state.ledger.length, 0);
  assert.equal(state.users[0].balance, 1000);
});

test("a claim needs a real quest id and nothing else", async () => {
  const { tx, state } = makeFakeDb({ quests: [questRow()] });

  for (const questId of ["abc", 0, -1, 1.5, null, undefined]) {
    const result = await claimQuestReward({
      clerkId: "user_a",
      questId,
      tx,
      now: NOW,
    });
    assert.equal(result.ok, false, `questId=${String(questId)}`);
    assert.equal(result.status, 400);
    assert.equal(result.reason, "invalid-quest");
  }

  // A client-supplied amount / progress / completion is not part of the input
  // at all, so it cannot change the payout.
  const generous = await claimQuestReward({
    clerkId: "user_a",
    questId: 1,
    tx,
    now: NOW,
    // @ts-expect-error — deliberately trying to smuggle fields in
    reward: 999999,
    progress: 999,
    claimed: false,
    userId: 22,
  });
  assert.equal(generous.ok, true);
  assert.equal(generous.credited, 75, "the stored reward is the paid reward");
  assert.equal(state.users[0].balance, 1075);
  assert.equal(state.users.find((user) => user.id === 22), undefined);
});

// ════════════════════════════════════════════════════════════════════════
// 2. Refusals
// ════════════════════════════════════════════════════════════════════════

test("an incomplete quest cannot be claimed", async () => {
  const { tx, state } = makeFakeDb({
    quests: [questRow({ progress: 2, completed_at: null })],
  });

  const result = await claimQuestReward({
    clerkId: "user_a",
    questId: 1,
    tx,
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.reason, "incomplete");
  assert.equal(state.users[0].balance, 1000, "no coins move");
  assert.equal(state.ledger.length, 0);

  const row = state.quests[0];
  assert.equal(row.claimed, false, "a refusal never marks the quest claimed");
});

test("a quest from a previous period cannot be claimed today", async () => {
  const { tx, state } = makeFakeDb({
    quests: [questRow({ period_key: "2026-10-20" })],
  });

  const result = await claimQuestReward({
    clerkId: "user_a",
    questId: 1,
    tx,
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.reason, "expired");
  assert.equal(state.users[0].balance, 1000);
  assert.equal(state.quests[0].claimed, false);
});

test("another player's quest, or an unknown id, is not found", async () => {
  const { tx, state } = makeFakeDb({
    users: [
      { id: 11, clerkId: "user_a", balance: 1000, peakBalance: 1000 },
      { id: 22, clerkId: "user_b", balance: 1000, peakBalance: 1000 },
    ],
    quests: [questRow({ user_id: 22 })],
  });

  const foreign = await claimQuestReward({
    clerkId: "user_a",
    questId: 1,
    tx,
    now: NOW,
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.status, 404);
  assert.equal(foreign.reason, "not-found");

  const missing = await claimQuestReward({
    clerkId: "user_a",
    questId: 999,
    tx,
    now: NOW,
  });
  assert.equal(missing.status, 404);
  assert.equal(state.quests[0].claimed, false);
  assert.equal(state.users[0].balance, 1000);
  assert.equal(state.users[1].balance, 1000);
});

test("a row that is already claimed is refused", async () => {
  const { tx, state } = makeFakeDb({ quests: [questRow({ claimed: true })] });

  const result = await claimQuestReward({
    clerkId: "user_a",
    questId: 1,
    tx,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.reason, "already-claimed");
  assert.equal(state.users[0].balance, 1000);
});

// ════════════════════════════════════════════════════════════════════════
// 3. A successful claim
// ════════════════════════════════════════════════════════════════════════

test("a completed quest pays its stored reward once and returns the balance", async () => {
  const { tx, state } = makeFakeDb({ quests: [questRow()] });

  const result = await claimQuestReward({
    clerkId: "user_a",
    questId: 1,
    tx,
    now: NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.credited, 75);
  assert.equal(result.balance, 1075);
  assert.equal(result.quest.claimed, true);
  assert.equal(result.quest.claimable, false);
  assert.equal(result.board.balance, 1075);
  assert.equal(
    result.board.daily.find((quest) => quest.id === 1).claimed,
    true,
    "the returned board is the post-claim truth",
  );

  assert.equal(state.users[0].balance, 1075);
  assert.equal(state.users[0].peakBalance, 1075);
  assert.equal(state.quests[0].claimed, true);
  assert.deepEqual(state.ledger, [
    {
      clerk_id: "user_a",
      type: "reward",
      amount: 75,
      reference_type: QUEST_REWARD_REFERENCE,
      reference_id: `daily:${DAY}:1`,
      note: `Quest reward (daily ${DAY})`,
    },
  ]);
});

test("a duplicate claim pays nothing and writes no second ledger row", async () => {
  const { tx, state } = makeFakeDb({ quests: [questRow()] });

  const first = await claimQuestReward({ clerkId: "user_a", questId: 1, tx, now: NOW });
  const second = await claimQuestReward({ clerkId: "user_a", questId: 1, tx, now: NOW });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "already-claimed");
  assert.equal(state.users[0].balance, 1075, "credited exactly once");
  assert.equal(state.ledger.length, 1);
});

test("two racing claims pay exactly once", async () => {
  const { tx, state } = makeFakeDb({ quests: [questRow()] });

  const [a, b] = await Promise.all([
    claimQuestReward({ clerkId: "user_a", questId: 1, tx, now: NOW }),
    claimQuestReward({ clerkId: "user_a", questId: 1, tx, now: NOW }),
  ]);

  const successes = [a, b].filter((result) => result.ok);
  const refusals = [a, b].filter((result) => !result.ok);

  assert.equal(successes.length, 1, "exactly one claim may pay");
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].status, 409);
  assert.equal(refusals[0].reason, "already-claimed");
  assert.equal(state.users[0].balance, 1075);
  assert.equal(state.ledger.length, 1);
});

test("two different completed quests both pay, in one session", async () => {
  const { tx, state } = makeFakeDb({
    quests: [
      questRow({ id: 1, reward: 40 }),
      questRow({ id: 2, slot: 1, period_type: "weekly", period_key: WEEK, reward: 200 }),
    ],
  });

  const daily = await claimQuestReward({ clerkId: "user_a", questId: 1, tx, now: NOW });
  const weekly = await claimQuestReward({ clerkId: "user_a", questId: 2, tx, now: NOW });

  assert.equal(daily.ok, true);
  assert.equal(weekly.ok, true);
  assert.equal(state.users[0].balance, 1240);
  assert.equal(state.ledger.length, 2);
  assert.equal(
    state.ledger[1].reference_id,
    `weekly:${WEEK}:2`,
    "each period has its own ledger key",
  );
});

test("a large balance is paid in full — the retired cap cannot block a reward", async () => {
  const { tx, state } = makeFakeDb({
    users: [{ id: 11, clerkId: "user_a", balance: 250_000, peakBalance: 250_000 }],
    quests: [questRow({ reward: 300 })],
  });

  const result = await claimQuestReward({
    clerkId: "user_a",
    questId: 1,
    tx,
    now: NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.credited, 300);
  assert.equal(result.balance, 250_300);
  assert.equal(state.users[0].balance, 250_300);
});

// ════════════════════════════════════════════════════════════════════════
// 4. The board read
// ════════════════════════════════════════════════════════════════════════

test("the board read returns both periods, their keys and the balance", async () => {
  const { tx } = makeFakeDb({
    quests: [
      questRow({ id: 1, progress: 1 }),
      questRow({ id: 2, slot: 1, period_type: "weekly", period_key: WEEK, target: 15 }),
    ],
  });

  const board = await getQuestStatus({ clerkId: "user_a", tx, now: NOW });

  assert.equal(board.ok, true);
  assert.equal(board.balance, 1000);
  assert.equal(board.periodKeys.daily, DAY);
  assert.equal(board.periodKeys.weekly, WEEK);
  assert.equal(board.resets.dailyEnd, "2026-10-22T00:00:00.000Z");
  assert.equal(board.daily[0].progress, 1);
  assert.equal(board.daily[0].claimable, false);
  // The seeded fixture is found by id: the planner also fills any slot the
  // fixture left empty, exactly as it would for a real player.
  assert.equal(
    board.weekly.find((quest) => quest.id === 2).target,
    15,
    "the weekly fixture is on the weekly board",
  );
});

test("an unknown player has no board", async () => {
  const { tx } = makeFakeDb();
  const board = await getQuestStatus({ clerkId: "ghost", tx, now: NOW });
  assert.equal(board.ok, false);
  assert.equal(board.status, 404);
});

test("the board seeds the period's slots on first read", async () => {
  const { tx, state } = makeFakeDb();

  const board = await getQuestStatus({ clerkId: "user_a", tx, now: NOW });

  assert.equal(board.ok, true);
  assert.ok(board.daily.length > 0, "a new player sees quests immediately");
  assert.ok(board.weekly.length > 0);
  assert.ok(
    state.quests.every((row) => row.progress === 0),
    "seeding never invents progress",
  );
});
