/**
 * daily-reward.test.mjs
 *
 * The daily login reward is a curated token payout gated on having won a rated
 * match today (online or vs the AI), and the zero-balance rescue is the "one last game" floor
 * beneath it. Both are free coin faucets, so their bounds have to be pinned: too
 * low and they are pointless, too much and they replace playing.
 *
 * These tests cover the three halves of that contract:
 *   1. the PURE numbers — the 14-day curve, the cycle wrap, the win gate and
 *      the rescue amount, all checked against the shipped constants;
 *   2. the STREAK PROJECTION — the read-side day (`projectDailyStreakDay`) that
 *      the status read reports. It MUST be the day the claim actually pays,
 *      because the shipped bug was a board that advertised "250" and a wallet
 *      that received 30: the status read used the stale stored streak.
 *   3. the WIRING — the idempotency guards (day-keyed column + ledger row), the
 *      UTC-day comparison, and the fact that the win-gate marker is stamped by
 *      the authoritative rating writer and read by the reward.
 *
 * Run:  npm run test:daily-rewards
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  DAILY_REWARD_CYCLE_DAYS,
  DAILY_REWARD_REFERENCE,
  STREAK_SHIELD_ITEM_KEY,
  dailyRewardAmount,
  dailyRewardCredit,
  dailyRewardCycleDay,
  dailyRewardFitsInWallet,
  isWinGateSatisfied,
  utcDateKey,
} from "../src/lib/tokens/dailyReward.ts";
import { markDailyRewardWin, utcWinDay } from "../src/lib/dailyRewardWin.ts";
import {
  isClientSettledPracticeGame,
  isPracticeSessionToday,
  markClientPracticeWin,
} from "../src/lib/practiceWin.ts";
import {
  daysBetween,
  projectDailyStreakDay,
  toDateStr,
} from "../src/lib/dailyStreak.js";
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

test("the reward curve is a 14-day, strictly escalating fortnight", () => {
  assert.equal(DAILY_REWARD_CYCLE.length, 14);
  assert.equal(DAILY_REWARD_CYCLE_DAYS, 14);
  for (let i = 1; i < DAILY_REWARD_CYCLE.length; i += 1) {
    assert.ok(
      DAILY_REWARD_CYCLE[i] > DAILY_REWARD_CYCLE[i - 1],
      `day ${i + 1} (${DAILY_REWARD_CYCLE[i]}) must pay more than day ${i}`,
    );
  }
});

test("the 15th day of a 14-day streak is day 1 again", () => {
  // The rule the board implements: complete the fortnight and the next login
  // starts the cycle over, rather than paying day 15 of an endless ladder.
  assert.equal(dailyRewardCycleDay(14), 14);
  assert.equal(dailyRewardCycleDay(15), 1);
  assert.equal(dailyRewardAmount(14), DAILY_REWARD_CYCLE[13]);
  assert.equal(dailyRewardAmount(15), DAILY_REWARD_CYCLE[0]);
  assert.equal(dailyRewardAmount(16), DAILY_REWARD_CYCLE[1]);

  // A much longer streak keeps wrapping rather than running off the curve.
  assert.equal(dailyRewardCycleDay(1), 1);
  assert.equal(dailyRewardCycleDay(28), 14);
  assert.equal(dailyRewardCycleDay(29), 1);
  assert.equal(dailyRewardCycleDay(57), 1);
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

test("a full fortnight of rewards stays under three daily allowances", () => {
  const fortnight = DAILY_REWARD_CYCLE.reduce((sum, n) => sum + n, 0);
  // Doubling the CYCLE must not double what a player takes in: the ramp is
  // flatter per day (≈96/day vs the old week's ≈104), so a full 14-day cycle is
  // worth only 1,350 — under three 500-token energy top-ups.
  assert.equal(fortnight, 1350);
  assert.ok(
    fortnight <= ENERGY_GRANT_FLOOR * 3,
    "a fortnight must not dwarf the daily allowance",
  );
  assert.ok(
    fortnight / DAILY_REWARD_CYCLE.length < DAILY_ENERGY_GRANT,
    "the daily average must stay under the daily energy grant",
  );
  // Per-day average is not more generous than the cycle it replaced.
  assert.ok(fortnight / DAILY_REWARD_CYCLE.length <= 725 / 7);
});

test("no single day is worth more than a few max bets", () => {
  const best = Math.max(...DAILY_REWARD_CYCLE);
  assert.equal(best, 200);
  assert.ok(best <= GLOBAL_MAX_BET * 3, "the payday must not fund a spending spree");
  assert.ok(best <= STARTING_COINS / 4, "no single day may rival the starting balance");
  assert.ok(best <= WALLET_HARD_CAP, "the wallet ceiling is the hard ceiling");
});

test("the wallet ceiling caps the credit, never the advertised amount", () => {
  // Room for the whole reward → the whole reward.
  assert.equal(dailyRewardCredit(30, 1000), 30);
  // At (or above) the hard ceiling there is no room at all. The claim must
  // REFUSE this rather than pay 0 and consume the day.
  assert.equal(dailyRewardCredit(30, WALLET_HARD_CAP), 0);
  assert.equal(dailyRewardCredit(30, WALLET_HARD_CAP + 500), 0);
  // Partial room is reported as partial, so the claim can refuse instead of
  // paying less than the button advertised.
  assert.equal(dailyRewardCredit(30, WALLET_HARD_CAP - 10), 10);
  // Malformed inputs never invent coins.
  assert.equal(dailyRewardCredit(0, 100), 0);
  assert.equal(dailyRewardCredit(-5, 100), 0);
  assert.equal(dailyRewardCredit(30, Number.NaN), 0);
  assert.equal(dailyRewardCredit(30, -50), 30);
});

test("a wallet with no room for the reward is reported as full", () => {
  assert.equal(dailyRewardFitsInWallet(35, 100000), false);
  // Partial room is not room: the advertised amount must fit ENTIRELY.
  assert.equal(dailyRewardFitsInWallet(35, 99970), false);
  assert.equal(dailyRewardFitsInWallet(35, 99965), true);
  assert.equal(dailyRewardFitsInWallet(35, 0), true);
});

test("the status read carries the wallet verdict so the UI can warn early", () => {
  // The pre-click state cannot be dropped server-side without the card and the
  // widget silently going back to offering a claim that can only be refused.
  const src = read("src/lib/tokens/dailyReward.ts");
  assert.match(src, /walletFull: !dailyRewardFitsInWallet\(reward, balance\)/);
  assert.match(src, /walletCap: WALLET_HARD_CAP/);
  assert.match(read("src/hooks/useDailyReward.ts"), /walletFull: boolean/);
});

test("the reward is never zero — every day of the cycle pays something", () => {
  for (const day of DAILY_REWARD_CYCLE.map((_, index) => index + 1)) {
    const amount = dailyRewardAmount(day);
    assert.ok(Number.isInteger(amount) && amount > 0, `day ${day} pays ${amount}`);
    // Above the noise floor of a real wager, so day 1 is not an insult.
    assert.ok(amount >= HIGH_VARIANCE_MAX_BET, `day ${day} pays ${amount}`);
  }
});

// ── The streak projection: the advertised amount IS the paid amount ─────────
//
// The reported regression: the card said "Claim 250 coins" and the claim paid
// 30. The status read reported the STORED streak, which is stale until
// something advances it, while the claim advances the streak first and pays the
// NEW day. `projectDailyStreakDay` is the one rule both sides now share.

// Built from LOCAL calendar parts so these assertions hold in every timezone
// (the streak columns are keyed on the local day — see `toDateStr`).
const on = (year, month, dayOfMonth) => new Date(year, month - 1, dayOfMonth, 12, 0, 0);

const TODAY = on(2026, 10, 16);

const project = (overrides = {}) =>
  projectDailyStreakDay(
    { lastLoginDate: "2026-10-16", current: 1, ...overrides },
    TODAY,
  );

test("the projection is the day a claim made right now would land on", () => {
  // Never logged in before → day 1.
  assert.equal(project({ lastLoginDate: null, current: 0 }), 1);

  // Already logged in today: the stored streak was ALREADY advanced today, so
  // the claim pays the day the player is on — not one more.
  assert.equal(project({ lastLoginDate: "2026-10-16", current: 6 }), 6);

  // Logged in yesterday: today advances the streak by one.
  assert.equal(project({ lastLoginDate: "2026-10-15", current: 6 }), 7);

  // Missed a day: the claim resets to day 1, so the status must say day 1.
  assert.equal(project({ lastLoginDate: "2026-10-14", current: 6 }), 1);
  assert.equal(project({ lastLoginDate: "2026-09-01", current: 14 }), 1);

  // A streak shield absorbs exactly one missed day on both sides.
  assert.equal(
    project({ lastLoginDate: "2026-10-14", current: 6, shieldAvailable: true }),
    6,
  );

  // A stored streak of 0/garbage is never reported as a day below 1.
  for (const current of [0, -5, NaN, undefined, null, "abc"]) {
    const day = project({ lastLoginDate: null, current });
    assert.ok(Number.isInteger(day) && day >= 1, `current ${String(current)} → ${day}`);
  }
});

test("the projection agrees with the login-streak day arithmetic", () => {
  // A gap is measured in whole local days; a DST boundary cannot turn
  // "yesterday" into 0 or 2 days.
  assert.equal(daysBetween("2026-10-15", "2026-10-16"), 1);
  assert.equal(daysBetween("2026-10-14", "2026-10-16"), 2);
  assert.equal(daysBetween("2026-03-07", "2026-03-09"), 2); // US DST spring-forward
  assert.equal(daysBetween("2026-10-31", "2026-11-01"), 1);

  // The date string the streak columns are written with is a LOCAL day key, so
  // a stored DATE and a JS Date can never disagree about "today".
  assert.equal(toDateStr(TODAY), "2026-10-16");
  assert.equal(toDateStr("2026-10-16T23:59:00.000Z"), "2026-10-16");
  assert.equal(toDateStr(null), null);
});

test("the day the board advertises is the day the wallet is paid", () => {
  // The whole point: for every (stored streak, last login) pair, the projected
  // day's amount is what the claim pays, and the two never disagree.
  const cases = [
    { lastLoginDate: "2026-10-16", current: 14, expected: 14 },
    { lastLoginDate: "2026-10-15", current: 14, expected: 15 }, // wraps to day 1
    { lastLoginDate: "2026-10-15", current: 6, expected: 7 },
    { lastLoginDate: "2026-10-13", current: 9, expected: 1 },
  ];

  for (const { lastLoginDate, current, expected } of cases) {
    const projected = project({ lastLoginDate, current });
    assert.equal(projected, expected, `${lastLoginDate} / streak ${current}`);
    assert.equal(
      dailyRewardAmount(projected),
      dailyRewardAmount(expected),
      "the advertised amount must be the paid amount",
    );
  }

  // The regression in one assertion: a stored streak of 14 with a two-day gap
  // must NOT advertise day 14's 200.
  const staleDay = 14;
  const projected = project({ lastLoginDate: "2026-10-13", current: staleDay });
  assert.equal(projected, 1);
  assert.equal(dailyRewardAmount(projected), 30);
  assert.notEqual(dailyRewardAmount(staleDay), 30);
});

test("the status read and the claim share one streak rule", () => {
  const reward = read("src/lib/tokens/dailyReward.ts");
  // The status read PROJECTS the day; reporting the stored column is the bug.
  assert.match(reward, /const streakDay = await projectedStreakDay\(user, now\)/);
  assert.match(reward, /return projectDailyStreakDay\(/);
  // The shield is READ (not consumed) on the status side...
  assert.match(reward, /hasItem\(user\.id, STREAK_SHIELD_ITEM_KEY, 1\)/);

  const streak = read("src/lib/dailyStreak.js");
  // ...and the WRITE path derives its day from the same exported function, so
  // the two can never drift apart again.
  assert.match(streak, /export function projectDailyStreakDay\(/);
  assert.match(streak, /const newDailyCurrent = projectDailyStreakDay\(/);
  assert.match(streak, /await consumeItem\(user\.id, "streak_shield", 1\)/);
});

// ── The win gate ────────────────────────────────────────────────────────────

test("the win gate only unlocks on the same UTC day", () => {
  const today = "2026-10-13";
  assert.equal(isWinGateSatisfied(today, today), true);
  assert.equal(isWinGateSatisfied("2026-10-12", today), false);
  assert.equal(isWinGateSatisfied("2026-10-14", today), false);
});

test("the win gate fails closed for a missing or malformed marker", () => {
  for (const value of [null, undefined, "", "not-a-date"]) {
    assert.equal(
      isWinGateSatisfied(value, "2026-10-13"),
      false,
      `marker ${String(value)} must not unlock the reward`,
    );
  }
  // A Date is compared as its UTC day, so the DATE column and a JS Date agree.
  assert.equal(
    isWinGateSatisfied(new Date("2026-10-13T23:59:00.000Z"), "2026-10-13"),
    true,
  );
  assert.equal(
    isWinGateSatisfied(new Date("2026-10-14T00:00:00.000Z"), "2026-10-13"),
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

test("a full wallet refuses the claim instead of burning the day for 0 coins", () => {
  const src = read("src/lib/tokens/dailyReward.ts");
  // The guard compares the wallet's actual room against the advertised amount.
  assert.match(src, /const credit = dailyRewardCredit\(reward, balance\)/);
  assert.match(src, /if \(credit < reward\)/);
  // It runs BEFORE the day marker and the ledger row, so a refused claim
  // leaves both untouched and today's reward claimable once room is made.
  const guardAt = src.indexOf("if (credit < reward)");
  assert.ok(guardAt > 0, "the wallet-room guard must exist");
  assert.ok(
    guardAt < src.indexOf("lastDailyRewardClaimed: today"),
    "the refusal must precede the day marker",
  );
  assert.ok(
    guardAt < src.indexOf("tx.insert(tokenTransactions)"),
    "the refusal must precede the ledger row",
  );
  // The player is told why, with the amount they would have been paid.
  assert.match(src, /wallet is full/i);
  assert.match(src, /WALLET_HARD_CAP\.toLocaleString/);
  assert.match(src, /\$\{reward\}/);
});

test("the claim reports what was credited and the UI shows that figure", () => {
  assert.match(
    read("src/app/api/rewards/daily/route.ts"),
    /credited:\s*result\.credit/,
  );
  assert.match(
    read("src/hooks/useDailyReward.ts"),
    /json\.credited \?\? json\.reward/,
  );
});

test("the rescue is idempotent per UTC day through its own ledger key", () => {
  const src = read("src/lib/tokens/energyGrant.ts");
  assert.ok(src.includes(RESCUE_GRANT_REFERENCE));
  assert.notEqual(RESCUE_GRANT_REFERENCE, "energy-grant", "the two faucets must not share a key");
  // Same reference-id shape as the energy grant, so a retry is a no-op.
  assert.match(src, /referenceId = `\$\{utcDayKey\(now\)\}:\$\{clerkId\}`/);
});

test("the shared win marker writes the UTC day and ignores a missing winner", async () => {
  const writes = [];
  const tx = {
    update() {
      return {
        set(values) {
          writes.push(values);
          return this;
        },
        where() {
          return this;
        },
        async returning() {
          return [{ id: 1 }];
        },
      };
    },
  };

  assert.equal(await markDailyRewardWin(tx, "user_winner"), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].lastWonGameDate, utcWinDay());

  // A missing id is a no-op: a bot seat / guest has no account to stamp.
  assert.equal(await markDailyRewardWin(tx, null), false);
  assert.equal(writes.length, 1);
});

test("a server-settled vs-AI win also stamps the daily-reward marker", () => {
  // The marker is the one gate the reward reads, so every authoritative
  // practice settlement marks the human winner through the shared helper. The
  // bot seat has no users row, so the helper's UPDATE is a no-op for a bot win.
  const helper = read("src/lib/dailyRewardWin.ts");
  assert.match(helper, /lastWonGameDate: utcWinDay\(\)/);
  assert.match(helper, /eq\(users\.clerkId, String\(clerkId\)\)/);

  const practiceSettlements = [
    "src/lib/tic-tac-toe/serverStore.ts",
    "src/lib/dotsAndBoxesServer.js",
    "src/app/api/dice-flush/_lib.js",
    "src/app/api/chess/move/route.js",
    "src/app/api/chess/game-state/route.js",
    "src/app/api/hex-duel/end-game/route.ts",
    "src/lib/keno-pvp/serverStore.js",
    "src/lib/lane-rush-duel/serverStore.js",
    "src/lib/memory-grid/serverStore.js",
    "src/lib/mines-pvp/serverStore.js",
    "src/lib/mini-golf/serverStore.ts",
    "src/app/api/pool/submit-shot/route.ts",
    "src/lib/precision/finishMatch.ts",
    "src/lib/solitaire-duel/serverStore.ts",
    "src/lib/speed-typing/serverStore.ts",
    "src/lib/sudoku-duel/serverStore.ts",
    "src/app/api/uno/determine-winner/route.js",
    "src/app/api/odds/ai/end/route.ts",
    "src/lib/tower-arena/serverStore.ts",
  ];
  for (const file of practiceSettlements) {
    assert.match(read(file), /markDailyRewardWin\(/, `${file} must stamp a practice win`);
  }
});

test("a client-settled practice report is allowlisted and needs today's session", async () => {
  // The browser is the authority for these modes, so the endpoint's own
  // guards are the only thing between a stray POST and the reward: an unknown
  // game key and a missing session must both be refused before any marker is
  // written.
  assert.equal(isClientSettledPracticeGame("four-in-a-row"), true);
  assert.equal(isClientSettledPracticeGame("rps"), true);
  assert.equal(isClientSettledPracticeGame("barrier-blitz"), true);
  assert.equal(isClientSettledPracticeGame("chess"), false);
  assert.equal(isClientSettledPracticeGame(null), false);

  const today = "2026-10-19";
  assert.equal(isPracticeSessionToday(today, today), true);
  assert.equal(isPracticeSessionToday(new Date(`${today}T23:00:00Z`), today), true);
  assert.equal(isPracticeSessionToday("2026-10-18", today), false);
  assert.equal(isPracticeSessionToday(null, today), false);

  // These two refusals return before the DB proxy is touched, so they are
  // safe to exercise without a database.
  assert.deepEqual(await markClientPracticeWin(null, "rps"), {
    ok: false,
    status: 401,
    error: "Not authenticated",
  });
  assert.deepEqual(await markClientPracticeWin("user_1", "chess"), {
    ok: false,
    status: 400,
    error: "Unknown practice game",
  });
});

test("a client-settled practice win reports the same daily-reward marker", () => {
  // Four-in-a-Row, RPS and Barrier Blitz have no server match row, so their
  // browser result is the only settlement signal. The report path must still
  // go through the ONE marker helper, and the endpoint must refuse an unknown
  // game or a day on which no practice session was started.
  const helper = read("src/lib/practiceWin.ts");
  assert.match(
    helper,
    /CLIENT_SETTLED_PRACTICE_GAMES = \[[\s\S]*"four-in-a-row"[\s\S]*"rps"[\s\S]*"barrier-blitz"/,
  );
  assert.match(helper, /markDailyRewardWin\(db, clerkId\)/);
  assert.match(helper, /if \(!isClientSettledPracticeGame\(game\)\)/);
  assert.match(helper, /isPracticeSessionToday\(user\.lastPlayed, today\)/);

  const route = read("src/app/api/practice/win/route.ts");
  assert.match(route, /await auth\(\)/);
  assert.match(route, /markClientPracticeWin\(clerkId, body\?\.game\)/);

  const client = read("src/lib/practiceWinClient.ts");
  assert.match(client, /fetch\("\/api\/practice\/win"/);
  assert.match(client, /notifyDailyRewardWin\(\)/);

  for (const page of [
    "src/app/casino/four-in-a-row/play-ai/PageClient.tsx",
    "src/app/casino/rps/play-ai/PageClient.tsx",
    "src/app/casino/barrier-blitz/play-ai/PageClient.tsx",
  ]) {
    assert.match(read(page), /reportPracticeWin\("/, `${page} must report its terminal win`);
  }
});

test("the win-gate marker is stamped by the authoritative rating writer", () => {
  const rating = read("src/lib/rating.js");
  // Only a rated online match reaches this writer, and the winner is derived
  // server-side, so the marker is a real win. A draw must not unlock the daily
  // reward. Vs-AI practice wins stamp through the shared helper tested above.
  assert.match(rating, /SET last_won_game_date = \$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}/);
  assert.match(rating, /if \(!isDraw\) \{/);

  // PvP games that settle outside Elo (UNO, Hex Duel) stamp the same marker
  // through the shared leaderboard-counter writer, and only for a real
  // human-vs-human win.
  const counters = read("src/lib/leaderboardCounters.js");
  assert.match(counters, /last_won_game_date = CASE WHEN \$\{isPvpWin && isWin\}/);
  assert.match(counters, /const utcDay = new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
});

test("the reward reads exactly the marker the settlement writers write", () => {
  const reward = read("src/lib/tokens/dailyReward.ts");
  assert.match(reward, /isWinGateSatisfied\(user\.lastWon, today\)/);
  assert.match(reward, /Win a match to unlock/);
  const schema = read("src/db/schema.ts");
  assert.match(schema, /lastWonGameDate: date\("last_won_game_date"\)/);
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

test("the win-gate column ships with a journaled migration", () => {
  const sql = read("src/db/migrations/0220_daily_reward_win_gate.sql");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "last_won_game_date" date/);
  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
  // The entry is looked up BY TAG rather than taken from the end of the array:
  // this asserts that the daily-reward migration is journalled and consistent
  // (drizzle runs only journalled entries), not that it is the newest one — a
  // later migration of an unrelated feature must not fail this test.
  const index = journal.entries.findIndex(
    (candidate) => candidate.tag === "0220_daily_reward_win_gate",
  );
  assert.notEqual(index, -1, "0220_daily_reward_win_gate must be in the journal");
  assert.equal(journal.entries[index].idx, index);
});
