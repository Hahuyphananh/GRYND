/**
 * quests.test.mjs
 *
 * Daily & weekly quests. The rules that matter are narrow and absolute, so they
 * are pinned here rather than in a route test:
 *
 *   1. DEFINITIONS + REWARDS — a small, well-formed, configurable catalog whose
 *      coin rewards stay modest against the existing economy.
 *   2. PERIODS — UTC day keys and ISO-8601 week keys, including the year
 *      boundaries where a naive implementation gets it wrong.
 *   3. GENERATION — the same period always plans the same slots, and the row
 *      identity (user, period, slot) is deterministic so retries cannot create
 *      duplicate slots.
 *   4. ELIGIBILITY — only a completed, server-verified match against a real
 *      human may advance a quest. AI, bots, practice, lobbies, cancels and
 *      unfinished matches are all rejected, and leave the row untouched.
 *   5. PROGRESS — counts, distinct games (canonical ids, never display names),
 *      wins-only, clamping, sticky completion, claim eligibility.
 *   6. WIRING — schema + journaled migration, and the domain module's isolation
 *      from rating/trophies/wagers/daily rewards.
 *
 * Run:  npm run test:quests
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  DAILY_QUESTS,
  QUEST_OBJECTIVES,
  QUEST_SLOTS,
  WEEKLY_QUESTS,
  buildQuestRows,
  findQuestDefinition,
  planQuests,
  questPool,
} from "../src/lib/quests/definitions.ts";
import {
  isQuestPeriodType,
  periodBounds,
  periodKeyFor,
  utcDayKey,
  utcWeekKey,
} from "../src/lib/quests/periods.ts";
import {
  QUEST_GAME_IDS,
  canonicalQuestGame,
} from "../src/lib/quests/games.ts";
import {
  advanceQuest,
  canClaimQuest,
  describeQuestObjective,
  isQuestComplete,
  isQuestEligibleMatch,
  normalizeQuestRow,
  toQuestView,
} from "../src/lib/quests/progress.ts";

const read = (rel) => fs.readFileSync(rel, "utf8");

const HUMAN_MATCH = {
  matchId: "match-1",
  gameKey: "tic-tac-toe",
  opponentKind: "human",
  completed: true,
  outcome: "win",
};

const match = (overrides = {}) => ({ ...HUMAN_MATCH, ...overrides });

const questRow = (overrides = {}) => ({
  userId: 7,
  periodType: "daily",
  periodKey: "2026-10-21",
  slot: 0,
  questType: "pvp_matches",
  gameKey: null,
  target: 3,
  reward: 50,
  progress: 0,
  claimed: false,
  meta: { definitionId: "daily-three-matches", games: [] },
  completedAt: null,
  ...overrides,
});

// ════════════════════════════════════════════════════════════════════════
// 1. Definitions and rewards
// ════════════════════════════════════════════════════════════════════════

test("every quest definition is well formed and unique", () => {
  const ids = new Set();

  for (const pool of [DAILY_QUESTS, WEEKLY_QUESTS]) {
    for (const definition of pool) {
      assert.ok(
        definition.periodType === "daily" || definition.periodType === "weekly",
        `${definition.id}: period type`,
      );
      assert.ok(
        QUEST_OBJECTIVES.includes(definition.objective),
        `${definition.id}: unknown objective ${definition.objective}`,
      );
      assert.ok(
        Number.isInteger(definition.target) && definition.target >= 1,
        `${definition.id}: target must be a whole count >= 1`,
      );
      assert.ok(
        Number.isInteger(definition.reward) && definition.reward > 0,
        `${definition.id}: reward must be a whole positive coin amount`,
      );
      assert.ok(definition.title.trim().length > 0, `${definition.id}: title`);
      assert.ok(
        definition.description.trim().length > 0,
        `${definition.id}: description`,
      );
      assert.ok(!ids.has(definition.id), `duplicate quest id ${definition.id}`);
      ids.add(definition.id);
    }
  }

  // The pools own their period, and each pool has more quests than slots so a
  // period can never show the same quest twice.
  assert.ok(DAILY_QUESTS.every((definition) => definition.periodType === "daily"));
  assert.ok(WEEKLY_QUESTS.every((definition) => definition.periodType === "weekly"));
  assert.ok(DAILY_QUESTS.length >= QUEST_SLOTS.daily);
  assert.ok(WEEKLY_QUESTS.length >= QUEST_SLOTS.weekly);
});

test("distinct-game quests are unscoped, so the target is reachable", () => {
  // A distinct-games quest scoped to one game could never reach a target above
  // 1 — the pool must never ship that combination.
  for (const definition of [...DAILY_QUESTS, ...WEEKLY_QUESTS]) {
    if (definition.objective === "pvp_games") {
      assert.equal(definition.gameKey, null, `${definition.id}: scoped pvp_games`);
      assert.ok(definition.target >= 2, `${definition.id}: needs 2+ games`);
    }
  }
});

test("quest rewards stay modest against the existing economy", () => {
  // One daily quest is worth less than a single MAX_WIN_PER_MATCH (1,000) and
  // about a login day; a weekly quest is worth about a day of daily rewards.
  for (const definition of DAILY_QUESTS) {
    assert.ok(definition.reward >= 25, `${definition.id}: reward too small to matter`);
    assert.ok(definition.reward <= 100, `${definition.id}: daily reward too large`);
  }
  for (const definition of WEEKLY_QUESTS) {
    assert.ok(definition.reward >= 150, `${definition.id}: reward too small to matter`);
    assert.ok(definition.reward <= 350, `${definition.id}: weekly reward too large`);
  }

  // What a period can actually pay: every possible plan, over a full year of
  // period keys, must stay inside a modest envelope.
  const keys = [];
  for (let day = 0; day < 365; day += 1) {
    keys.push(new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10));
  }
  const weeks = [...new Set(keys.map((key) => utcWeekKey(new Date(`${key}T12:00:00Z`))))];

  let maxDaily = 0;
  for (const key of keys) {
    maxDaily = Math.max(
      maxDaily,
      planQuests("daily", key).reduce((sum, quest) => sum + quest.reward, 0),
    );
  }
  let maxWeekly = 0;
  for (const key of weeks) {
    maxWeekly = Math.max(
      maxWeekly,
      planQuests("weekly", key).reduce((sum, quest) => sum + quest.reward, 0),
    );
  }

  assert.ok(maxDaily <= 250, `a daily board paid ${maxDaily} coins`);
  assert.ok(maxWeekly <= 600, `a weekly board paid ${maxWeekly} coins`);
});

test("quests are virtual-coin only — no cash, gift cards or purchasable progress", () => {
  // The definitions carry exactly the fields a coin reward needs. Nothing here
  // can be redeemed, bought or converted.
  for (const definition of [...DAILY_QUESTS, ...WEEKLY_QUESTS]) {
    assert.deepEqual(
      Object.keys(definition).sort(),
      [
        "description",
        "gameKey",
        "id",
        "objective",
        "periodType",
        "reward",
        "target",
        "title",
      ],
      `${definition.id}: unexpected field`,
    );
    assert.ok(definition.objective.startsWith("pvp_"));
  }

  for (const file of [
    "src/lib/quests/definitions.ts",
    "src/lib/quests/progress.ts",
  ]) {
    const src = read(file);
    assert.doesNotMatch(src, /gift\s?card|giftcard|cash\s?out|withdraw/i, file);
    assert.doesNotMatch(src, /price|purchase|paywall/i, file);
  }
});

// ════════════════════════════════════════════════════════════════════════
// 2. UTC period identities
// ════════════════════════════════════════════════════════════════════════

test("the daily key is the UTC calendar day", () => {
  assert.equal(utcDayKey(new Date("2026-10-21T00:00:00.000Z")), "2026-10-21");
  assert.equal(utcDayKey(new Date("2026-10-21T23:59:59.999Z")), "2026-10-21");
  assert.equal(utcDayKey(new Date("2026-10-22T00:00:00.000Z")), "2026-10-22");
  // A `+14:00` local time still belongs to its UTC day, not the local one.
  assert.equal(
    utcDayKey(new Date("2026-10-21T22:30:00.000+14:00")),
    "2026-10-21",
  );
  assert.equal(periodKeyFor("daily", new Date("2026-10-21T23:30:00Z")), "2026-10-21");
});

test("the weekly key is the ISO-8601 week, including year boundaries", () => {
  // 2026-01-01 is a Thursday: ISO week 1 of 2026.
  assert.equal(utcWeekKey(new Date("2026-01-01T12:00:00Z")), "2026-W01");
  // Monday 2025-12-29 belongs to 2026-W01 (its Thursday is 2026-01-01).
  assert.equal(utcWeekKey(new Date("2025-12-29T00:00:00Z")), "2026-W01");
  // Sunday 2026-01-04 is still week 1; Monday 2026-01-05 starts week 2.
  assert.equal(utcWeekKey(new Date("2026-01-04T23:59:59Z")), "2026-W01");
  assert.equal(utcWeekKey(new Date("2026-01-05T00:00:00Z")), "2026-W02");
  // Friday 2021-01-01 belongs to 2020-W53.
  assert.equal(utcWeekKey(new Date("2021-01-01T12:00:00Z")), "2020-W53");
  // Monday 2024-12-30 belongs to 2025-W01.
  assert.equal(utcWeekKey(new Date("2024-12-30T09:00:00Z")), "2025-W01");
  // Fixed width, sortable, and inside the VARCHAR(12) column.
  for (const iso of ["2026-01-01", "2026-10-21", "2020-12-31"]) {
    const key = utcWeekKey(new Date(`${iso}T12:00:00Z`));
    assert.match(key, /^\d{4}-W\d{2}$/);
    assert.ok(key.length <= 12);
  }
  assert.equal(periodKeyFor("weekly", new Date("2026-10-21T12:00:00Z")), "2026-W43");
});

test("period bounds are UTC half-open ranges that agree with the keys", () => {
  const noon = new Date("2026-10-21T12:34:56Z");

  const day = periodBounds("daily", noon);
  assert.equal(day.start.toISOString(), "2026-10-21T00:00:00.000Z");
  assert.equal(day.end.toISOString(), "2026-10-22T00:00:00.000Z");
  assert.ok(day.start <= noon && noon < day.end);

  // 2026-10-21 is a Wednesday: the week starts Monday 2026-10-19.
  const week = periodBounds("weekly", noon);
  assert.equal(week.start.toISOString(), "2026-10-19T00:00:00.000Z");
  assert.equal(week.end.toISOString(), "2026-10-26T00:00:00.000Z");
  assert.ok(week.start <= noon && noon < week.end);
  assert.equal(
    utcWeekKey(week.start),
    periodKeyFor("weekly", noon),
    "the range must contain the key it was derived from",
  );

  // A Sunday still belongs to the week that started on Monday.
  const sunday = periodBounds("weekly", new Date("2026-10-25T23:59:59Z"));
  assert.equal(sunday.start.toISOString(), "2026-10-19T00:00:00.000Z");

  assert.equal(isQuestPeriodType("daily"), true);
  assert.equal(isQuestPeriodType("weekly"), true);
  assert.equal(isQuestPeriodType("monthly"), false);
  assert.equal(isQuestPeriodType(null), false);
});

// ════════════════════════════════════════════════════════════════════════
// 3. Deterministic quest generation
// ════════════════════════════════════════════════════════════════════════

test("the same period always plans the same slots", () => {
  const first = planQuests("daily", "2026-10-21");
  const second = planQuests("daily", "2026-10-21");
  assert.deepEqual(
    first.map((quest) => quest.id),
    second.map((quest) => quest.id),
  );
  assert.equal(first.length, QUEST_SLOTS.daily);

  // Consecutive periods rotate, so the board is not frozen forever.
  const plans = new Set(
    Array.from({ length: 14 }, (_, day) =>
      planQuests("daily", `2026-10-${String(day + 1).padStart(2, "0")}`)
        .map((quest) => quest.id)
        .join(","),
    ),
  );
  assert.ok(plans.size > 1, "the daily board never rotates");
});

test("a period never shows the same quest twice", () => {
  for (let day = 1; day <= 80; day += 1) {
    const key = new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10);
    for (const periodType of ["daily", "weekly"]) {
      const plan = planQuests(periodType, key);
      assert.equal(
        new Set(plan.map((quest) => quest.id)).size,
        plan.length,
        `${periodType} ${key} repeated a quest`,
      );
    }
  }
});

test("quest rows have a deterministic (user, period, slot) identity", () => {
  const args = { userId: 42, periodType: "daily", periodKey: "2026-10-21" };
  const first = buildQuestRows(args);
  const second = buildQuestRows(args);

  assert.deepEqual(first, second);
  assert.equal(first.length, QUEST_SLOTS.daily);

  first.forEach((row, slot) => {
    assert.equal(row.slot, slot);
    assert.equal(row.userId, 42);
    assert.equal(row.periodKey, "2026-10-21");
    assert.equal(row.progress, 0);
    assert.equal(row.claimed, false);
    assert.equal(row.completedAt, null);
    assert.deepEqual(row.meta.games, []);

    const definition = findQuestDefinition(row.meta.definitionId);
    assert.ok(definition, `slot ${slot} lost its definition id`);
    assert.equal(row.questType, definition.objective);
    assert.equal(row.target, definition.target);
    assert.equal(row.reward, definition.reward);
    assert.equal(row.gameKey, definition.gameKey);
  });

  // Two players get the same plan but their own rows — the identity includes
  // the user, so one player's slot can never collide with another's.
  const other = buildQuestRows({ ...args, userId: 43 });
  assert.deepEqual(
    other.map((row) => row.meta.definitionId),
    first.map((row) => row.meta.definitionId),
  );
  assert.notDeepEqual(
    other.map((row) => [row.userId, row.periodKey, row.slot]),
    first.map((row) => [row.userId, row.periodKey, row.slot]),
  );
});

test("a period needs a key and a user", () => {
  assert.throws(() => planQuests("daily", ""));
  assert.throws(() => planQuests("weekly", null));
  assert.throws(() => buildQuestRows({ userId: 0, periodType: "daily", periodKey: "2026-10-21" }));
  assert.throws(() => buildQuestRows({ userId: 1.5, periodType: "daily", periodKey: "2026-10-21" }));
  assert.throws(() => questPool("monthly"));
});

// ════════════════════════════════════════════════════════════════════════
// 4. Canonical game ids
// ════════════════════════════════════════════════════════════════════════

test("settlement game keys normalize to canonical ids", () => {
  assert.equal(canonicalQuestGame("keno-pvp"), "keno");
  assert.equal(canonicalQuestGame("rps-pvp"), "rps");
  assert.equal(canonicalQuestGame("lane-rush-duel"), "lane-runner");
  assert.equal(canonicalQuestGame("odds-pvp"), "odds");
  assert.equal(canonicalQuestGame("tic-tac-toe"), "tic-tac-toe");
  assert.equal(canonicalQuestGame("TIC-TAC-TOE"), "tic-tac-toe");
  assert.equal(canonicalQuestGame("  chess  "), "chess");

  // Display names and unknown keys are NOT identities.
  assert.equal(canonicalQuestGame("Tic Tac Toe"), null);
  assert.equal(canonicalQuestGame("Keno PvP"), null);
  assert.equal(canonicalQuestGame("not-a-game"), null);
  assert.equal(canonicalQuestGame(""), null);
  assert.equal(canonicalQuestGame(null), null);
  assert.equal(canonicalQuestGame(42), null);
});

test("the canonical catalog is unique, lowercase and display-free", () => {
  assert.equal(new Set(QUEST_GAME_IDS).size, QUEST_GAME_IDS.length);
  for (const id of QUEST_GAME_IDS) {
    assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `bad canonical id ${id}`);
    assert.equal(canonicalQuestGame(id), id);
  }
  // The four settlement aliases are not separate identities.
  for (const alias of ["keno-pvp", "rps-pvp", "lane-rush-duel", "odds-pvp"]) {
    assert.ok(!QUEST_GAME_IDS.includes(alias), `${alias} leaked into the catalog`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// 5. Eligibility — only a completed human match
// ════════════════════════════════════════════════════════════════════════

test("a completed human match is eligible", () => {
  assert.equal(isQuestEligibleMatch(match()), true);
  assert.equal(isQuestEligibleMatch(match({ outcome: "loss" })), true);
  assert.equal(isQuestEligibleMatch(match({ outcome: "draw" })), true);
  assert.equal(isQuestEligibleMatch(match({ gameKey: "keno-pvp" })), true);
});

test("AI, bot, guest, lobby and unfinished matches are never eligible", () => {
  const rejected = [
    ["not completed", { completed: false }],
    ["missing completed", { completed: undefined }],
    ["AI opponent", { opponentKind: "ai" }],
    ["bot opponent", { opponentKind: "bot" }],
    ["no opponent", { opponentKind: "none" }],
    ["missing opponent", { opponentKind: undefined }],
    ["empty match id", { matchId: "" }],
    ["missing match id", { matchId: undefined }],
    ["unknown outcome", { outcome: "cancelled" }],
    ["missing outcome", { outcome: undefined }],
    ["display-name game", { gameKey: "Tic Tac Toe" }],
    ["unknown game", { gameKey: "mystery-game" }],
    ["empty game", { gameKey: "" }],
    ["missing game", { gameKey: null }],
  ];

  for (const [label, overrides] of rejected) {
    assert.equal(
      isQuestEligibleMatch(match(overrides)),
      false,
      `${label} must not be eligible`,
    );
  }
  assert.equal(isQuestEligibleMatch(null), false);
  assert.equal(isQuestEligibleMatch(undefined), false);
});

test("an ineligible match leaves quest progress untouched", () => {
  const row = questRow({ target: 3, progress: 1 });

  for (const evidence of [
    match({ completed: false }),
    match({ opponentKind: "ai" }),
    match({ opponentKind: "bot" }),
    match({ opponentKind: "none" }),
    match({ gameKey: "not-a-game" }),
    match({ outcome: "invalid" }),
  ]) {
    const result = advanceQuest(row, evidence);
    assert.equal(result.advanced, false);
    assert.equal(result.reason, "ineligible");
    assert.deepEqual(result.row, row);
  }
});

// ════════════════════════════════════════════════════════════════════════
// 6. Progress rules
// ════════════════════════════════════════════════════════════════════════

test("a play-N quest counts every completed human match, win or lose", () => {
  let row = questRow({ target: 3, progress: 0 });

  let result = advanceQuest(row, match({ outcome: "win", matchId: "m1" }));
  assert.equal(result.advanced, true);
  assert.equal(result.row.progress, 1);
  assert.equal(result.row.completedAt, null);
  row = result.row;

  result = advanceQuest(row, match({ outcome: "loss", matchId: "m2" }));
  assert.equal(result.row.progress, 2);
  row = result.row;

  const at = new Date("2026-10-21T18:00:00.000Z");
  result = advanceQuest(row, match({ outcome: "draw", matchId: "m3" }), at);
  assert.equal(result.row.progress, 3);
  assert.equal(result.row.completedAt, at);
  assert.equal(isQuestComplete(result.row), true);

  // Once complete, further matches are a no-op (and cannot re-stamp the date).
  const after = advanceQuest(result.row, match({ matchId: "m4" }));
  assert.equal(after.advanced, false);
  assert.equal(after.reason, "complete");
  assert.deepEqual(after.row, result.row);
});

test("a win quest counts wins only", () => {
  const row = questRow({ questType: "pvp_wins", target: 2, progress: 0 });

  const loss = advanceQuest(row, match({ outcome: "loss" }));
  assert.equal(loss.advanced, false);
  assert.equal(loss.reason, "not-a-win");
  assert.deepEqual(loss.row, row);

  const draw = advanceQuest(row, match({ outcome: "draw" }));
  assert.equal(draw.advanced, false);
  assert.equal(draw.reason, "not-a-win");

  const win = advanceQuest(row, match({ outcome: "win" }));
  assert.equal(win.advanced, true);
  assert.equal(win.row.progress, 1);
});

test("a distinct-games quest counts each canonical game exactly once", () => {
  const row = questRow({ questType: "pvp_games", target: 3, progress: 0 });

  const first = advanceQuest(row, match({ gameKey: "tic-tac-toe", matchId: "m1" }));
  assert.equal(first.row.progress, 1);
  assert.deepEqual(first.row.meta.games, ["tic-tac-toe"]);

  // Same game again: no progress, no duplicate entry.
  const same = advanceQuest(first.row, match({ gameKey: "tic-tac-toe", matchId: "m2" }));
  assert.equal(same.advanced, false);
  assert.equal(same.reason, "already-counted");
  assert.deepEqual(same.row.meta.games, ["tic-tac-toe"]);

  const keno = advanceQuest(first.row, match({ gameKey: "keno-pvp", matchId: "m3" }));
  assert.equal(keno.row.progress, 2);
  assert.deepEqual(keno.row.meta.games, ["tic-tac-toe", "keno"]);

  const chess = advanceQuest(keno.row, match({ gameKey: "chess", matchId: "m4" }));
  assert.equal(chess.row.progress, 3);
  assert.deepEqual(chess.row.meta.games, ["tic-tac-toe", "keno", "chess"]);
  assert.equal(isQuestComplete(chess.row), true);
});

test("aliases of one game cannot double-count a distinct-games quest", () => {
  const row = questRow({ questType: "pvp_games", target: 2, progress: 0 });

  const odds = advanceQuest(row, match({ gameKey: "odds", matchId: "m1" }));
  assert.equal(odds.row.progress, 1);

  const alias = advanceQuest(odds.row, match({ gameKey: "odds-pvp", matchId: "m2" }));
  assert.equal(alias.advanced, false);
  assert.equal(alias.reason, "already-counted");
  assert.deepEqual(alias.row.meta.games, ["odds"]);
});

test("a game-scoped quest ignores every other game", () => {
  const row = questRow({ questType: "pvp_matches", gameKey: "chess", target: 2 });

  const other = advanceQuest(row, match({ gameKey: "tic-tac-toe" }));
  assert.equal(other.advanced, false);
  assert.equal(other.reason, "wrong-game");
  assert.deepEqual(other.row, row);

  // An alias of a DIFFERENT game is still another game.
  const keno = advanceQuest(row, match({ gameKey: "keno-pvp" }));
  assert.equal(keno.reason, "wrong-game");

  const chess = advanceQuest(row, match({ gameKey: "chess" }));
  assert.equal(chess.advanced, true);
  assert.equal(chess.row.progress, 1);
});

test("progress clamps at the target and completion is sticky", () => {
  const row = questRow({ target: 1, progress: 0 });
  const at = new Date("2026-10-21T19:00:00.000Z");

  const first = advanceQuest(row, match(), at);
  assert.equal(first.row.progress, 1);
  assert.equal(first.row.completedAt, at);

  // A second eligible match cannot push progress past the target nor move the
  // completion stamp.
  const second = advanceQuest(first.row, match({ matchId: "m2" }), new Date("2026-10-22T00:00:01.000Z"));
  assert.equal(second.advanced, false);
  assert.equal(second.row.progress, 1);
  assert.equal(second.row.completedAt.toISOString(), at.toISOString());
});

test("a corrupt target never completes or stamps a completion", () => {
  // Defensive: rows are generated from valid definitions, but a bad target must
  // not turn into a free claim or a fake completion date.
  for (const target of [0, -1, Number.NaN]) {
    const row = questRow({ target, progress: 0 });
    const result = advanceQuest(row, match());
    assert.equal(isQuestComplete(result.row), false, `target ${String(target)}`);
    assert.equal(canClaimQuest(result.row), false, `target ${String(target)}`);
    assert.equal(result.row.completedAt, null, `target ${String(target)}`);
  }
});

test("a claimed quest is frozen", () => {
  const row = questRow({ target: 5, progress: 4, claimed: true });
  const result = advanceQuest(row, match());
  assert.equal(result.advanced, false);
  assert.equal(result.reason, "claimed");
  assert.deepEqual(result.row, row);
});

test("completion and claim eligibility follow progress and the claimed flag", () => {
  assert.equal(isQuestComplete(questRow({ target: 3, progress: 2 })), false);
  assert.equal(isQuestComplete(questRow({ target: 3, progress: 3 })), true);
  assert.equal(isQuestComplete(questRow({ target: 3, progress: 4 })), true);
  // A nonsensical target never completes.
  assert.equal(isQuestComplete(questRow({ target: 0, progress: 0 })), false);
  assert.equal(isQuestComplete(questRow({ target: 0, progress: 9 })), false);
  assert.equal(isQuestComplete(questRow({ target: Number.NaN, progress: 9 })), false);

  assert.equal(canClaimQuest(questRow({ target: 3, progress: 2 })), false);
  assert.equal(canClaimQuest(questRow({ target: 3, progress: 3 })), true);
  assert.equal(
    canClaimQuest(questRow({ target: 3, progress: 3, claimed: true })),
    false,
    "a claimed quest cannot pay twice",
  );
  // Claim eligibility never depends on when the row completed.
  assert.equal(
    canClaimQuest(
      questRow({
        target: 3,
        progress: 3,
        completedAt: new Date("2026-10-21T10:00:00.000Z"),
      }),
    ),
    true,
  );
});

// ════════════════════════════════════════════════════════════════════════
// 7. Row normalization and the UI projection
// ════════════════════════════════════════════════════════════════════════

test("numeric strings and snake_case rows are normalized", () => {
  const row = normalizeQuestRow({
    id: "12",
    user_id: 7,
    period_type: "weekly",
    period_key: "2026-W43",
    slot: "1",
    quest_type: "pvp_wins",
    game_key: null,
    target: "3.00",
    reward: "50",
    progress: "2.00",
    claimed: false,
    meta: { definitionId: "weekly-eight-wins", games: ["keno"] },
    completed_at: "2026-10-21T10:00:00.000Z",
  });

  assert.equal(row.id, 12);
  assert.equal(row.userId, 7);
  assert.equal(row.periodType, "weekly");
  assert.equal(row.periodKey, "2026-W43");
  assert.equal(row.slot, 1);
  assert.equal(row.questType, "pvp_wins");
  assert.equal(row.target, 3);
  assert.equal(row.reward, 50);
  assert.equal(row.progress, 2);
  assert.ok(row.completedAt instanceof Date);
  assert.deepEqual(row.meta.games, ["keno"]);
});

test("the quest view carries objective, target, progress, reward, period and state", () => {
  const row = questRow({
    questType: "pvp_wins",
    target: 2,
    progress: 2,
    meta: { definitionId: "daily-two-wins", games: [] },
  });

  const view = toQuestView(row);
  assert.equal(view.title, "Winning form");
  assert.match(view.description, /Win 2 matches/);
  assert.equal(view.objective, "pvp_wins");
  assert.equal(view.target, 2);
  assert.equal(view.progress, 2);
  assert.equal(view.reward, 50);
  assert.equal(view.periodType, "daily");
  assert.equal(view.periodKey, "2026-10-21");
  assert.equal(view.completed, true);
  assert.equal(view.claimed, false);
  assert.equal(view.claimable, true);

  const claimed = toQuestView({ ...row, claimed: true });
  assert.equal(claimed.claimable, false);

  // A row whose definition no longer exists still explains itself.
  const orphan = toQuestView(questRow({ meta: {}, questType: "pvp_games", target: 4, progress: 1 }));
  assert.equal(orphan.definitionId, null);
  assert.equal(orphan.title, "Daily quest");
  assert.match(orphan.description, /4 different games/);
  assert.equal(orphan.completed, false);
  assert.equal(orphan.claimable, false);
});

test("objective text is readable for every objective", () => {
  assert.match(describeQuestObjective("pvp_matches", 1), /Play 1 match /);
  assert.match(describeQuestObjective("pvp_matches", 3), /Play 3 matches /);
  assert.match(describeQuestObjective("pvp_wins", 2), /Win 2 matches /);
  assert.match(describeQuestObjective("pvp_games", 2), /2 different games/);
});

// ════════════════════════════════════════════════════════════════════════
// 8. Wiring — schema, journaled migration, isolation
// ════════════════════════════════════════════════════════════════════════

test("user_quests is in the Drizzle schema with its deterministic identity", () => {
  const schema = read("src/db/schema.ts");
  assert.match(schema, /pgTable\(\s*"user_quests"/);
  assert.match(schema, /unique\("user_quests_user_period_slot_unique"\)/);
  assert.match(schema, /completedAt: timestamp\("completed_at"\)/);
  // numeric(14,2) keeps the 0132 column type, so a legacy table is compatible.
  assert.match(schema, /numeric\("target", \{ precision: 14, scale: 2, mode: "number" \}\)/);
  assert.match(schema, /numeric\("progress", \{ precision: 14, scale: 2, mode: "number" \}\)/);
});

test("the quests migration is present, journaled and additive", () => {
  const file = "src/db/migrations/0225_quests.sql";
  assert.ok(fs.existsSync(file), `${file} is missing`);

  const sql = read(file);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "user_quests"/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "completed_at"/);
  // Additive only: no drops, no type rewrites of existing data.
  assert.doesNotMatch(sql, /DROP\s+TABLE/i);
  assert.doesNotMatch(sql, /ALTER\s+COLUMN/i);

  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
  const entry = journal.entries.find((item) => item.tag === "0225_quests");
  assert.ok(entry, "the quests migration must be journaled");
  assert.equal(entry.idx, journal.entries.indexOf(entry));
  assert.equal(
    journal.entries.filter((item) => item.tag === "0225_quests").length,
    1,
    "the migration must be journaled exactly once",
  );
  assert.ok(
    fs.existsSync(path.join("src/db/migrations", `${entry.tag}.sql`)),
    "journal entry must resolve to a real file",
  );
});

test("the quest domain does not touch rating, trophies, wagers or daily rewards", () => {
  // Quest rewards are coins paid by their own claim path; the domain module may
  // not read or write any other progression system.
  for (const file of [
    "src/lib/quests/definitions.ts",
    "src/lib/quests/progress.ts",
    "src/lib/quests/periods.ts",
    "src/lib/quests/games.ts",
    "src/lib/quests/types.ts",
  ]) {
    const src = read(file);
    // Imports and call sites, not prose: the comments are allowed to NAME the
    // systems this module deliberately does not touch.
    assert.doesNotMatch(
      src,
      /import[^;\n]*from "\.\.\/(rating|elo|trophyStore|leaderboardCounters|tokens)/,
      file,
    );
    assert.doesNotMatch(
      src,
      /\b(applyRatingResult|applyTrophyResult|settlePayout|creditUserBalance|claimDailyReward)\s*\(/,
      file,
    );
    // Pure domain: no database client in the module graph.
    assert.doesNotMatch(src, /import[^;\n]*db\/(client|schema)/, file);
  }
});

test("the quest store is deterministic on create and never updates progress", () => {
  const store = read("src/lib/quests/store.ts");
  assert.match(store, /onConflictDoNothing/);
  assert.match(store, /userQuests\.userId/);
  assert.match(store, /userQuests\.periodKey/);
  // The store must not be a back door around the progress rules: it creates and
  // reads rows only.
  assert.doesNotMatch(store, /\.update\(userQuests\)/);
  assert.doesNotMatch(store, /progress:\s*[^0\s]/);
});
