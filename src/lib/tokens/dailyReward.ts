// src/lib/tokens/dailyReward.ts
//
// The daily login reward — a small, curated token payout for coming back each
// day, gated on having actually PLAYED something today.
//
// ── Why there is a gate ─────────────────────────────────────────────────────
//
// A logged-in claim that pays out for nothing is just a faucet with extra
// steps: a player could open the app, claim, close it. So a claim requires
// `users.lastPlayedGameDate` to be today — the marker written by
// `/api/game-plays` when a real game session starts (see that route for the
// exact signal). That covers both requirement paths: a 1v1 PvP match and a
// vs-AI match both start through the same game-session edge, so both satisfy
// the gate. Playing is the price of the reward, exactly as intended.
//
// ── How much ────────────────────────────────────────────────────────────────
//
// The amount escalates over a 14-day cycle (`DAILY_REWARD_CYCLE` in
// src/lib/games/economy.ts) and is indexed by the player's daily login streak,
// so the reward and the streak always agree: miss a day and the streak (and the
// reward) falls back to day 1, and finishing the fortnight wraps back to day 1
// on the 15th day. See that constant for the calibration argument — the short
// version is that a full fortnight is under three daily energy-grant top-ups, so
// the reward is a nudge back into a game, never an income that could replace
// playing.
//
// ── The advertised amount IS the paid amount ────────────────────────────────
//
// The status read and the claim both derive the streak day through the SAME
// function (`projectDailyStreakDay` in src/lib/dailyStreak.js), so the number on
// the button is the number that lands in the wallet. Reading the STORED streak
// here instead — which is what this used to do — is what let a player who had
// missed a day be shown "Claim 250" and then paid day 1's 30: the reset only
// happens when something advances the streak.
//
// ── Idempotency ─────────────────────────────────────────────────────────────
//
// Two independent guards, because a reward that can be claimed twice is a
// faucet:
//   1. `users.last_daily_reward_claimed` — the day-keyed claim date, read and
//      written inside one `SELECT ... FOR UPDATE` transaction.
//   2. one `token_transactions` row keyed `(reference_type, reference_id)` =
//      `("daily-reward", "<utc-day>:<clerkId>")`, mirroring the energy grant.
// The transaction is what makes the claim safe under a double-click; the ledger
// row is what makes the payout auditable after the fact.

import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { tokenTransactions, users } from "../../db/schema";
import { DAILY_REWARD_CYCLE, WALLET_HARD_CAP } from "../games/economy";
import { daysBetween, projectDailyStreakDay, toDateStr, updateDailyStreak } from "../dailyStreak";
import { hasItem } from "../shopItems";
import { checkUnlocks } from "../specialTitles";

export const DAILY_REWARD_REFERENCE = "daily-reward";

/** The consumable that absorbs exactly one missed day (see `updateDailyStreak`). */
export const STREAK_SHIELD_ITEM_KEY = "streak_shield";

/**
 * The streak day a claim made RIGHT NOW would land on, read-only.
 *
 * This is the read-side twin of the write in `updateDailyStreak`: it derives the
 * day through `projectDailyStreakDay` and reports whether a streak shield is
 * there to absorb a missed day — WITHOUT consuming it. That means the status a
 * player sees and the amount they are paid are computed from one rule, so they
 * can never disagree.
 */
async function projectedStreakDay(
  user: {
    id: number;
    streak: number | null;
    lastLogin: string | Date | null;
  },
  now: Date
): Promise<number> {
  const lastLogin = toDateStr(user.lastLogin);
  const todayStr = toDateStr(now);
  // A shield only matters when a day was actually missed (the same branch
  // `updateDailyStreak` consumes it in).
  const missedADay =
    Boolean(lastLogin) && daysBetween(lastLogin as string, todayStr as string) !== 1;
  const shieldAvailable = missedADay ? await hasItem(user.id, STREAK_SHIELD_ITEM_KEY, 1) : false;

  return projectDailyStreakDay(
    {
      lastLoginDate: user.lastLogin,
      current: user.streak,
      shieldAvailable,
    },
    now
  );
}

/** Days in one reward cycle. The curve repeats after this many days. */
export const DAILY_REWARD_CYCLE_DAYS = DAILY_REWARD_CYCLE.length;

/** The UTC calendar day a claim belongs to (`YYYY-MM-DD`). */
export function utcDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Which day of the 14-day cycle a streak day lands on (1-based). A streak of 1
 * is cycle day 1; a streak of 15 starts the curve over at cycle day 1 — which
 * is the "14 days completed, the 15th day is day 1 again" rule. A non-positive
 * or non-finite streak day is treated as day 1, so a claim can never index the
 * curve out of bounds.
 */
export function dailyRewardCycleDay(streakDay: number): number {
  const day = Math.floor(Number(streakDay));
  if (!Number.isFinite(day) || day < 1) return 1;
  return ((day - 1) % DAILY_REWARD_CYCLE_DAYS) + 1;
}

/**
 * The tokens a player on `streakDay` of their daily login streak earns today.
 * Pure, so the whole curve is unit-testable without a database.
 */
export function dailyRewardAmount(streakDay: number): number {
  return DAILY_REWARD_CYCLE[dailyRewardCycleDay(streakDay) - 1];
}

/**
 * Whether today's reward is unlocked: the player must have played a game today
 * (the `last_played_game_date` marker). Compared as `YYYY-MM-DD` strings so a
 * stored DATE and a JS Date can never disagree about the day.
 */
export function isPlayGateSatisfied(
  lastPlayedGameDate: string | Date | null | undefined,
  today: string
): boolean {
  if (!lastPlayedGameDate) return false;
  const played =
    lastPlayedGameDate instanceof Date
      ? utcDateKey(lastPlayedGameDate)
      : String(lastPlayedGameDate).slice(0, 10);
  return played === today;
}

export type DailyRewardStatus = {
  /** True when today's reward has not been claimed yet. */
  claimable: boolean;
  /** True when the player has played a game today (the claim gate). */
  playGateSatisfied: boolean;
  /** Today's streak day, the index into the reward curve. */
  streakDay: number;
  /** Which day of the 14-day cycle today falls on (1-based). */
  cycleDay: number;
  /** How many days the cycle runs for, so the UI never hardcodes it. */
  cycleDays: number;
  /** What today's claim is worth. */
  reward: number;
  /** The day key the claim is recorded against. */
  today: string;
  /** The full curve, so the UI can show the whole fortnight at a glance. */
  cycle: number[];
};

export type DailyRewardResult =
  | { ok: true; status: DailyRewardStatus; claimed: boolean; balance: number }
  | { ok: false; error: string; status: number };

// The claim transaction's own result — a proper discriminated union so the
// branch below narrows, and so the successful credit is visible to the code
// that builds the public `DailyRewardResult`.
type ClaimTxResult =
  | { ok: true; credit: number; balance: number }
  | { ok: false; error: string; status: number };

/**
 * Today's reward state for a signed-in player, plus the balance it would be
 * credited into. Read-only: never claims, never credits. Returns `null` when no
 * local user row exists for the Clerk id.
 */
export async function getDailyRewardStatus(
  clerkId: string,
  { now = new Date() }: { now?: Date } = {}
): Promise<(DailyRewardStatus & { balance: number }) | null> {
  if (!clerkId) return null;

  const [user] = await db
    .select({
      id: users.id,
      balance: users.balance,
      streak: users.dailyStreakCurrent,
      lastLogin: users.lastLoginDate,
      lastPlayed: users.lastPlayedGameDate,
      claimed: users.lastDailyRewardClaimed,
    })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);
  if (!user) return null;

  const today = utcDateKey(now);
  // The PROJECTED day, not the stored one: the stored streak is stale until
  // something advances it, so a player who missed a day would otherwise be
  // shown a payday they cannot collect (see `projectedStreakDay`).
  const streakDay = await projectedStreakDay(user, now);

  return {
    claimable: String(user.claimed ?? "").slice(0, 10) !== today,
    playGateSatisfied: isPlayGateSatisfied(user.lastPlayed, today),
    streakDay,
    cycleDay: dailyRewardCycleDay(streakDay),
    cycleDays: DAILY_REWARD_CYCLE_DAYS,
    reward: dailyRewardAmount(streakDay),
    today,
    cycle: [...DAILY_REWARD_CYCLE],
    balance: Number(user.balance ?? 0),
  };
}

/**
 * Claim today's login reward for a signed-in player.
 *
 * Refuses (with a specific reason the UI can act on) when the reward was
 * already claimed today, or when the player has not played a game today. On
 * success the player's streak is advanced first, so the amount paid matches the
 * streak the player will see, and the credit is written atomically with a
 * ledger row.
 */
export async function claimDailyReward(
  clerkId: string,
  { now = new Date() }: { now?: Date } = {}
): Promise<DailyRewardResult> {
  if (!clerkId) return { ok: false, error: "Missing user", status: 400 };

  // Advance the login streak first. Idempotent per UTC day, so calling it here
  // is safe even though /api/user/daily-streak may already have run on login —
  // it is the shared authority for the streak, including streak shields.
  const streak = await updateDailyStreak(clerkId);
  if (!streak) return { ok: false, error: "User not found", status: 404 };

  const today = utcDateKey(now);
  const streakDay = Math.max(1, Number(streak.dailyStreakCurrent) || 1);
  const reward = dailyRewardAmount(streakDay);

  const result = await db.transaction(async (tx): Promise<ClaimTxResult> => {
    const [user] = await tx
      .select({
        id: users.id,
        balance: users.balance,
        lastPlayed: users.lastPlayedGameDate,
        claimed: users.lastDailyRewardClaimed,
      })
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .for("update");
    if (!user) return { ok: false as const, error: "User not found", status: 404 };

    const balance = Number(user.balance ?? 0);

    if (String(user.claimed ?? "").slice(0, 10) === today) {
      return {
        ok: false as const,
        error: "Already claimed today",
        status: 409,
      };
    }

    if (!isPlayGateSatisfied(user.lastPlayed, today)) {
      return {
        ok: false as const,
        error: "Play a game to unlock today's reward",
        status: 403,
      };
    }

    // Ledger first (the durable idempotency key), then the credit. Both live in
    // this transaction, so a failure rolls back the day marker with them.
    const referenceId = `${today}:${clerkId}`;
    const existing = await tx
      .select({ id: tokenTransactions.id })
      .from(tokenTransactions)
      .where(
        and(
          eq(tokenTransactions.referenceType, DAILY_REWARD_REFERENCE),
          eq(tokenTransactions.referenceId, referenceId)
        )
      )
      .limit(1);
    if (existing.length > 0) {
      return { ok: false as const, error: "Already claimed today", status: 409 };
    }

    // Same wallet ceiling as every other credit.
    const credit = Math.min(reward, Math.max(0, WALLET_HARD_CAP - balance));

    let newBalance = balance;
    if (credit > 0) {
      const [updated] = await tx
        .update(users)
        .set({
          balance: sql`${users.balance} + ${credit}`,
          peakBalance: sql`GREATEST(${users.peakBalance}, ${users.balance} + ${credit})`,
        })
        .where(eq(users.id, user.id))
        .returning({ balance: users.balance });
      newBalance = Number(updated.balance);
    }

    await tx.update(users).set({ lastDailyRewardClaimed: today }).where(eq(users.id, user.id));

    await tx.insert(tokenTransactions).values({
      clerkId,
      type: "reward",
      amount: credit,
      referenceType: DAILY_REWARD_REFERENCE,
      referenceId,
      note: `Daily login reward (streak day ${streakDay})`,
    });

    return { ok: true as const, credit, balance: newBalance };
  });

  // `in` narrowing, not `if (!result.ok)`: this project compiles with
  // `strict: false`, where truthiness narrowing of a discriminated union is
  // not applied.
  if ("error" in result) {
    return { ok: false, error: result.error, status: result.status };
  }

  // Login-claim progression (special titles / secret stats). Display-only and
  // never fatal to the payout, so a failure is swallowed after logging.
  try {
    await checkUnlocks(clerkId, "login_claim", {
      balanceAfter: result.balance,
    });
  } catch (error) {
    console.error("[DAILY_REWARD] title unlock check failed (non-fatal):", error);
  }

  return {
    ok: true,
    claimed: true,
    balance: result.balance,
    status: {
      claimable: false,
      playGateSatisfied: true,
      streakDay,
      cycleDay: dailyRewardCycleDay(streakDay),
      cycleDays: DAILY_REWARD_CYCLE_DAYS,
      reward,
      today,
      cycle: [...DAILY_REWARD_CYCLE],
    },
  };
}
