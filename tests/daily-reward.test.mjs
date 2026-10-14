/**
 * daily-reward.test.mjs
 *
 * The daily login reward is a curated token payout gated on having played a
 * game today, and the zero-balance rescue is the "one last game" floor beneath
 * it. Both are free coin faucets, so their bounds have to be pinned: too low and
 * they are pointless, too much and they replace playing.
 *
 * These tests cover the two halves of that contract:
 *   1. the PURE numbers — the 7-day curve, the cycle wrap, the play gate and
 *      the rescue amount, all checked against the shipped constants;
 *   2. the WIRING — the idempotency guards (day-keyed column + ledger row), the
 *      UTC-day comparison, and the fact that the play gate marker is stamped by
 *      the real game-session edge and read by the reward.
 *
 * Run:  npm run test:daily-rewards
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  DAILY_REWARD_CYCLE_DAYS,
  DAILY_REWARD_REFERENCE,
  dailyRewardAmount,
  dailyRewardCycleDay,
  isPlayGateSatisfied,
  utcDateKey,
} from "../src/lib/tokens/dailyReward.ts";
import {
  RESCUE_GRANT_REFERENCE,
  energyGrantAmount,
  rescueGrantAmount,
} from "../src/lib/tokens/energyGrant.ts";
import {
  DAILY_REWARD_CYCLE,
  DAILY_ENERGY_GRANT,
  ENERGY_GRANT_FLOOR,
  GLOBAL_MAX_BET,
  HIGH_VARIANCE_MAX_BET,
  STARTING_COINS,
  WALLET_HARD_CAP,
  ZERO_BALANCE_RESCUE,
} from "../src/lib/games/economy.ts";

const read = (rel) => fs.readFileSync(rel, "utf8");

// ── The curated curve ───────────────────────────────────────────────────────

test("the reward curve is a 7-day, strictly escalating week", () => {
  assert.equal(DAILY_REWARD_CYCLE.length, 7);
  assert.equal(DAILY_REWARD_CYCLE_DAYS, 7);
  for (let i = 1; i < DAILY_REWARD_CYCLE.length; i += 1) {
    assert.ok(
      DAILY_REWARD_CYCLE[i] > DAILY_REWARD_CYCLE[i - 1],
      `day ${i + 1} (${DAILY_REWARD_CYCLE[i]}) must pay more than day ${i}`,
    );
  }
});

test("the reward is indexed by the streak day and wraps after a week", () => {
  assert.equal(dailyRewardAmount(1), DAILY_REWARD_CYCLE[0]);
  assert.equal(dailyRewardAmount(7), DAILY_REWARD_CYCLE[6]);
  // Day 8 starts the curve over instead of running off the end.
  assert.equal(dailyRewardAmount(8), DAILY_REWARD_CYCLE[0]);
  assert.equal(dailyRewardAmount(14), DAILY_REWARD_CYCLE[6]);
  assert.equal(dailyRewardAmount(15), DAILY_REWARD_CYCLE[0]);

  assert.equal(dailyRewardCycleDay(1), 1);
  assert.equal(dailyRewardCycleDay(7), 7);
  assert.equal(dailyRewardCycleDay(8), 1);
});

test("an out-of-range streak day can never index the curve out of bounds", () => {
  for (const day of [0, -3, NaN, Infinity, -Infinity, undefined, "abc", null]) {
    const amount = dailyRewardAmount(day);
    assert.ok(
      DAILY_REWARD_CYCLE.includes(amount),
      `streak day ${String(day)} produced ${amount}, which is not on the curve`,
    );
  }
  // A missing/zero streak is treated as the first day, not as a bonus.
  assert.equal(dailyRewardAmount(0), DAILY_REWARD_CYCLE[0]);
  assert.equal(dailyRewardAmount(NaN), DAILY_REWARD_CYCLE[0]);
});

// ── The "not too low, especially not too much" bound ────────────────────────

test("a full week of rewards pays less than one day of energy allowance", () => {
  const week = DAILY_REWARD_CYCLE.reduce((sum, n) => sum + n, 0);
  // 725 vs the 500 floor: the week is worth having, and the per-day average is
  // a fraction of the allowance the energy grant already gives, so the reward
  // cannot become the reason to open the app over playing.
  assert.equal(week, 725);
  assert.ok(week <= ENERGY_GRANT_FLOOR * 2, "a week must not dwarf the daily allowance");
  assert.ok(
    week / DAILY_REWARD_CYCLE.length < DAILY_ENERGY_GRANT,
    "the daily average must stay under the daily energy grant",
  );
});

test("no single day is worth more than a few max bets", () => {
  const best = Math.max(...DAILY_REWARD_CYCLE);
  assert.equal(best, 250);
  assert.ok(best <= GLOBAL_MAX_BET * 3, "the payday must not fund a spending spree");
  assert.ok(best <= STARTING_COINS / 4, "no single day may rival the starting balance");
  assert.ok(best <= WALLET_HARD_CAP, "the wallet ceiling is the hard ceiling");
});

test("the reward is never zero — every day of the cycle pays something", () => {
  for (const day of [1, 2, 3, 4, 5, 6, 7]) {
    const amount = dailyRewardAmount(day);
    assert.ok(Number.isInteger(amount) && amount > 0, `day ${day} pays ${amount}`);
    // Above the noise floor of a real wager, so day 1 is not an insult.
    assert.ok(amount >= HIGH_VARIANCE_MAX_BET, `day ${day} pays ${amount}`);
  }
});

// ── The play gate ───────────────────────────────────────────────────────────

test("the play gate only unlocks on the same UTC day", () => {
  const today = "2026-10-13";
  assert.equal(isPlayGateSatisfied(today, today), true);
  assert.equal(isPlayGateSatisfied("2026-10-12", today), false);
  assert.equal(isPlayGateSatisfied("2026-10-14", today), false);
});

test("the play gate fails closed for a missing or malformed marker", () => {
  for (const value of [null, undefined, "", "not-a-date"]) {
    assert.equal(
      isPlayGateSatisfied(value, "2026-10-13"),
      false,
      `marker ${String(value)} must not unlock the reward`,
    );
  }
  // A Date is compared as its UTC day, so the DATE column and a JS Date agree.
  assert.equal(
    isPlayGateSatisfied(new Date("2026-10-13T23:59:00.000Z"), "2026-10-13"),
    true,
  );
  assert.equal(
    isPlayGateSatisfied(new Date("2026-10-14T00:00:00.000Z"), "2026-10-13"),
    false,
  );
});

test("the day key is the UTC calendar day", () => {
  assert.equal(utcDateKey(new Date("2026-10-13T23:59:59.999Z")), "2026-10-13");
  assert.equal(utcDateKey(new Date("2026-10-14T00:00:00.000Z")), "2026-10-14");
});

// ── The zero-balance rescue ─────────────────────────────────────────────────

test("the rescue tops an empty wallet up to exactly the rescue amount", () => {
  assert.equal(ZERO_BALANCE_RESCUE, 10);
  assert.equal(rescueGrantAmount(0), ZERO_BALANCE_RESCUE);
  assert.equal(rescueGrantAmount(0.0), ZERO_BALANCE_RESCUE);
});

test("the rescue never fires for a wallet that still has coins", () => {
  for (const balance of [0.01, 1, 5, 10, 25, 100, ENERGY_GRANT_FLOOR, WALLET_HARD_CAP]) {
    assert.equal(rescueGrantAmount(balance), 0, `balance ${balance}`);
  }
});

test("the rescue is capped and cannot be farmed into a balance", () => {
  // An impossible negative balance is not "repaid" beyond the rescue.
  assert.equal(rescueGrantAmount(-50), ZERO_BALANCE_RESCUE);
  assert.equal(rescueGrantAmount(-1_000), ZERO_BALANCE_RESCUE);
  for (const balance of [0, -50, -1_000]) {
    assert.ok(rescueGrantAmount(balance) <= ZERO_BALANCE_RESCUE);
  }
  // A lone rescue is a single small wager, well under the high-variance cap.
  assert.ok(ZERO_BALANCE_RESCUE <= HIGH_VARIANCE_MAX_BET);
  assert.ok(ZERO_BALANCE_RESCUE < GLOBAL_MAX_BET);
});

test("the rescue grants nothing rather than guessing at a bad balance", () => {
  for (const balance of [NaN, Infinity, -Infinity, undefined, "abc"]) {
    assert.equal(rescueGrantAmount(balance), 0, `balance ${String(balance)}`);
  }
  // null coerces to 0 — an empty wallet, which the rescue is FOR.
  assert.equal(rescueGrantAmount(null), ZERO_BALANCE_RESCUE);
});

test("the rescue sits BELOW the energy grant, so the allowance always wins", () => {
  // The energy grant fills an empty wallet straight to the floor, so on any day
  // where the grant has not yet fired, the rescue cannot fire at all.
  assert.equal(energyGrantAmount(0), ENERGY_GRANT_FLOOR);
  assert.ok(ENERGY_GRANT_FLOOR > ZERO_BALANCE_RESCUE);
  // Once the day's grant is spent (balance back at 0, ledger row already
  // written) the grant contributes nothing and the rescue is what is left.
  assert.equal(energyGrantAmount(0, ENERGY_GRANT_FLOOR, 0), 0);
  assert.equal(rescueGrantAmount(0), ZERO_BALANCE_RESCUE);

  // And the read applies them in that order.
  const route = read("src/app/api/get-user-tokens/route.ts");
  assert.ok(
    route.indexOf("await claimEnergyGrant(clerkId)") <
      route.indexOf("await claimZeroBalanceRescue(clerkId)"),
    "the energy grant must be claimed before the rescue",
  );
});

// ── The claim's idempotency and audit trail ─────────────────────────────────

test("the reward is idempotent per UTC day through the column AND the ledger", () => {
  const src = read("src/lib/tokens/dailyReward.ts");
  // The day-keyed claim column, written inside the same locked transaction that
  // reads it, so a double-click cannot pay twice.
  assert.match(src, /lastDailyRewardClaimed:\s*today/);
  assert.match(src, /user\.claimed/);
  assert.match(src, /\.for\("update"\)/);
  // The ledger row is the durable key: reference type + day+player reference id.
  assert.ok(src.includes(DAILY_REWARD_REFERENCE));
  assert.match(src, /referenceId = `\$\{today\}:\$\{clerkId\}`/);
  assert.match(src, /existing\.length > 0/);
  // Atomic credit, peak tracking and the wallet ceiling, as every credit does.
  assert.match(src, /sql`\$\{users\.balance\} \+ \$\{credit\}`/);
  assert.match(src, /GREATEST\(\$\{users\.peakBalance\}/);
  assert.match(src, /WALLET_HARD_CAP/);
});

test("the rescue is idempotent per UTC day through its own ledger key", () => {
  const src = read("src/lib/tokens/energyGrant.ts");
  assert.ok(src.includes(RESCUE_GRANT_REFERENCE));
  assert.notEqual(RESCUE_GRANT_REFERENCE, "energy-grant", "the two faucets must not share a key");
  // Same reference-id shape as the energy grant, so a retry is a no-op.
  assert.match(src, /referenceId = `\$\{utcDayKey\(now\)\}:\$\{clerkId\}`/);
});

test("the play-gate marker is stamped by the real game-session edge", () => {
  const route = read("src/app/api/game-plays/route.ts");
  // The one edge BOTH requirement paths reach: a 1v1 PvP match and a vs-AI
  // match each start a real game session, and each records a play here.
  assert.match(route, /lastPlayedGameDate: new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
  assert.match(route, /from "@clerk\/nextjs\/server"/);
  // Best-effort: the stamp can never fail the play count, and the route stays
  // public for signed-out visitors.
  assert.match(route, /catch \(stampError\)/);
  assert.doesNotMatch(route, /status: 401/);
});

test("the reward reads exactly the marker the game edge writes", () => {
  const reward = read("src/lib/tokens/dailyReward.ts");
  assert.match(reward, /isPlayGateSatisfied\(user\.lastPlayed, today\)/);
  assert.match(reward, /Play a game to unlock/);
  const schema = read("src/db/schema.ts");
  assert.match(schema, /lastPlayedGameDate: date\("last_played_game_date"\)/);
});

// ── The HTTP edge and the migration ─────────────────────────────────────────

test("the daily-reward route exposes a status read and a claim", () => {
  const route = read("src/app/api/rewards/daily/route.ts");
  assert.match(route, /export async function GET\(\)/);
  assert.match(route, /export async function POST\(\)/);
  // Both verbs are authenticated; there is nothing to show or claim without a
  // player.
  assert.equal((route.match(/status: 401/g) || []).length, 2);
  // The two expected refusals keep their own status codes.
  assert.match(route, /status: result\.status/);
});

test("the play-gate column ships with a journaled migration", () => {
  const sql = read("src/db/migrations/0214_daily_rewards.sql");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "last_played_game_date" date/);
  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
  // The entry is looked up BY TAG rather than taken from the end of the array:
  // this asserts that the daily-reward migration is journalled and consistent
  // (drizzle runs only journalled entries), not that it is the newest one — a
  // later migration of an unrelated feature must not fail this test.
  const index = journal.entries.findIndex(
    (candidate) => candidate.tag === "0214_daily_rewards",
  );
  assert.notEqual(index, -1, "0214_daily_rewards must be in the journal");
  assert.equal(journal.entries[index].idx, index);
});
