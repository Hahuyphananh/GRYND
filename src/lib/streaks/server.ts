// src/lib/streaks/server.ts
//
// THE UTC DAILY STREAK — server-authoritative.
//
// A streak day is credited by exactly one function, `recordStreakCompletion`,
// which every completion handler calls after it has verified the completion
// itself (the daily route has replayed the moves; the duel route has a
// server-resolved race). The client cannot post a streak, choose a day, or name
// an unlock.
//
// WHY THE ROW IS LOCKED: two completions can land at the same instant (a daily
// finish and a duel finish in two tabs). The `SELECT … FOR UPDATE` on the
// player's streak row serialises them, so the second one sees `last_completed_utc
// _date = today` and becomes a no-op instead of double-crediting the day.
//
// NO SHIELDS, NO FREEZES. A missed UTC day is a reset to 1 on the next
// completion; that is the product rule and there is no branch that preserves a
// streak across a gap.
//
// PRO TRIALS ARE PREDICATES. Nothing here writes a subscription: a milestone
// only extends `pro_trial_expires_at`, which `hasActiveProTrial` reads. A paying
// member never receives a trial (their subscription already covers it), and the
// milestone claim is still recorded so the Day-7 trial cannot be re-granted.
//
// FAILURE POLICY: a completion must never fail because the streak could not be
// recorded. Every caller treats a thrown error as "no streak update" — see the
// try/catch in the completion routes.

import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../../db";
import { userStreaks, userUnlocks, users } from "../../db/schema";
import { findActiveSubscription } from "../stripe/subscriptions";
import { boardItem } from "../solitaire-duel/boardCosmetics";
import {
  MAX_BESPOKE_DAY,
  POST_365_TRIAL_DAYS,
  advanceStreak,
  isPrestigeHit,
  milestoneForDay,
  nextMilestone,
  unlocksForRange,
  utcDateKey,
} from "./schedule";

export type StreakState = {
  /** The UTC day the streak is currently credited for (null before the first). */
  lastCompletedUtcDate: string | null;
  currentStreak: number;
  longestStreak: number;
  prestigePips: number;
  proTrialExpiresAt: string | null;
  /** Item ids this account permanently owns. */
  unlocks: string[];
  /** The next milestone ahead, or null once Day 365 is passed. */
  nextMilestone: { day: number; items: string[] } | null;
  /** Equipped board cosmetics, resolved from the user's columns. */
  equipped: {
    felt: string;
    cardBack: string;
    deckSkin: string;
  };
};

export type StreakCompletion = {
  credited: boolean;
  currentStreak: number;
  longestStreak: number;
  prestigePips: number;
  proTrialExpiresAt: string | null;
  /** Items granted by THIS completion (empty when nothing new was crossed). */
  newlyUnlocked: string[];
  nextMilestone: { day: number; items: string[] } | null;
  /** True when this completion extended an unexpired PRO trial. */
  trialExtended: boolean;
};

function firstRow(result: unknown): Record<string, unknown> | undefined {
  if (!result) return undefined;
  const rows = (result as { rows?: unknown }).rows ?? result;
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const rows = (result as { rows?: unknown }).rows ?? result;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** `YYYY-MM-DD` from a date column that a driver may return as Date or string. */
function dateKeyOf(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return utcDateKey(value);
  return String(value).slice(0, 10);
}

function isoOrNull(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

async function isPayingMember(clerkId: string): Promise<boolean> {
  try {
    return Boolean(await findActiveSubscription(clerkId));
  } catch {
    // Unreadable subscription state grants nothing, exactly like every other
    // PRO check — but it also must not hand out a trial, so it reads as paid
    // only when the row answered.
    return false;
  }
}

/**
 * Credit one completion for the player's current UTC day.
 *
 * Idempotent per UTC day, safe to call from more than one completion path, and
 * it never throws for a missing account (returns null instead).
 */
export async function recordStreakCompletion(
  clerkId: string | null | undefined,
  now: Date = new Date(),
): Promise<StreakCompletion | null> {
  if (!clerkId) return null;
  const todayKey = utcDateKey(now);

  const result = await db.transaction(async (tx) => {
    // Create the row on first use. `SELECT id FROM users` is also the account
    // check: a Clerk id with no app user writes nothing.
    await tx.execute(sql`
      insert into "user_streaks" ("user_id")
      select "id" from "users" where "clerk_id" = ${clerkId}
      on conflict ("user_id") do nothing
    `);

    const locked = await tx.execute(sql`
      select s."user_id",
             s."current_streak",
             s."longest_streak",
             s."last_completed_utc_date",
             s."initial_pro_trial_claimed",
             s."pro_trial_expires_at",
             s."prestige_pips"
        from "user_streaks" s
        join "users" u on u."id" = s."user_id"
       where u."clerk_id" = ${clerkId}
       for update of s
    `);
    const row = firstRow(locked);
    if (!row) return null;

    const userId = Number(row.user_id);
    const previousCurrent = Number(row.current_streak) || 0;
    const previousLongest = Number(row.longest_streak) || 0;
    const lastDate = dateKeyOf(row.last_completed_utc_date);
    const prestigePips = Number(row.prestige_pips) || 0;
    const trialClaimed = row.initial_pro_trial_claimed === true;
    const previousTrial = isoOrNull(row.pro_trial_expires_at);

    const advanced = advanceStreak(
      { current: previousCurrent, longest: previousLongest, lastDate },
      todayKey,
    );

    // Same UTC day: the day is already credited. Report the stored state and
    // grant nothing — a second finish must not re-cross a milestone.
    if (!advanced.credited) {
      return {
        credited: false,
        currentStreak: previousCurrent,
        longestStreak: previousLongest,
        prestigePips,
        proTrialExpiresAt: previousTrial,
        newlyUnlocked: [],
        nextMilestone: nextMilestone(previousCurrent),
        trialExtended: false,
      } satisfies StreakCompletion;
    }

    const candidateItems = unlocksForRange(previousCurrent, advanced.current);
    const newlyUnlocked: string[] = [];
    for (const itemId of candidateItems) {
      const granted = await tx
        .insert(userUnlocks)
        .values({ userId, itemId })
        .onConflictDoNothing({
          target: [userUnlocks.userId, userUnlocks.itemId],
        })
        .returning({ itemId: userUnlocks.itemId });
      if (granted.length > 0) newlyUnlocked.push(itemId);
    }

    // Day-7 one-time trial. The claim flag is set even for a paying member, so
    // the trial can never be collected later by cancelling.
    let claim = trialClaimed;
    let trialDays = 0;
    const day7 = milestoneForDay(7);
    if (!trialClaimed && advanced.current >= 7) {
      claim = true;
      const paid = await isPayingMember(clerkId);
      if (!paid) trialDays = Math.max(trialDays, day7?.proTrialDays ?? 0);
    }

    // Post-365 evergreen loop: one pip and a 2-day trial per completed 30 days.
    const prestige = isPrestigeHit(advanced.current);
    const nextPips = prestige ? prestigePips + 1 : prestigePips;
    if (prestige && !(await isPayingMember(clerkId))) {
      trialDays = Math.max(trialDays, POST_365_TRIAL_DAYS);
    }

    let trialExpression = sql`"pro_trial_expires_at"`;
    if (trialDays > 0) {
      trialExpression = sql`greatest(coalesce("pro_trial_expires_at", now()), now()) + (${trialDays} || ' days')::interval`;
    }

    await tx.execute(sql`
      update "user_streaks"
         set "current_streak" = ${advanced.current},
             "longest_streak" = ${advanced.longest},
             "last_completed_utc_date" = ${todayKey}::date,
             "initial_pro_trial_claimed" = ${claim},
             "prestige_pips" = ${nextPips},
             "pro_trial_expires_at" = ${trialExpression},
             "updated_at" = now()
       where "user_id" = ${userId}
    `);

    const updated = await tx.execute(sql`
      select "pro_trial_expires_at" from "user_streaks" where "user_id" = ${userId}
    `);

    return {
      credited: true,
      currentStreak: advanced.current,
      longestStreak: advanced.longest,
      prestigePips: nextPips,
      proTrialExpiresAt: isoOrNull(firstRow(updated)?.pro_trial_expires_at),
      newlyUnlocked,
      nextMilestone: nextMilestone(advanced.current),
      trialExtended: trialDays > 0,
    } satisfies StreakCompletion;
  });

  return result ?? null;
}

/** Read the streak state + unlocks + equipped cosmetics for one account. */
export async function readStreakState(
  clerkId: string | null | undefined,
): Promise<StreakState | null> {
  if (!clerkId) return null;

  const account = await db.query.users.findFirst({
    where: eq(users.clerkId, clerkId),
    columns: {
      id: true,
      equippedFelt: true,
      equippedCardBack: true,
      equippedDeckSkin: true,
    },
  });
  if (!account) return null;

  const [streak] = await db
    .select()
    .from(userStreaks)
    .where(eq(userStreaks.userId, account.id))
    .limit(1);

  const unlockRows = await db
    .select({ itemId: userUnlocks.itemId })
    .from(userUnlocks)
    .where(eq(userUnlocks.userId, account.id));

  const currentStreak = Number(streak?.currentStreak) || 0;

  return {
    lastCompletedUtcDate: dateKeyOf(streak?.lastCompletedUtcDate),
    currentStreak,
    longestStreak: Number(streak?.longestStreak) || 0,
    prestigePips: Number(streak?.prestigePips) || 0,
    proTrialExpiresAt: isoOrNull(streak?.proTrialExpiresAt),
    unlocks: unlockRows.map((row) => row.itemId),
    nextMilestone: nextMilestone(currentStreak),
    equipped: {
      felt: account.equippedFelt || "felt_default",
      cardBack: account.equippedCardBack || "card_back_default",
      deckSkin: account.equippedDeckSkin || "deck_default",
    },
  };
}

/** True when the account owns `itemId` (defaults are always owned). */
export async function ownsStreakItem(
  userId: number,
  itemId: string,
  streakDay: number,
): Promise<boolean> {
  if (streakDay <= 0) return true;
  const rows = await db
    .select({ itemId: userUnlocks.itemId })
    .from(userUnlocks)
    .where(and(eq(userUnlocks.userId, userId), eq(userUnlocks.itemId, itemId)))
    .limit(1);
  return rows.length > 0;
}

export type EquipBoardResult =
  | { ok: true; slot: "felt" | "card_back" | "deck_skin"; itemId: string }
  | { ok: false; error: string; status: number };

/**
 * Equip one board cosmetic, server-side.
 *
 * Ownership is the `user_unlocks` row the streak engine wrote — never a counter
 * claimed by the client. The three slot columns are the only write targets.
 */
export async function equipBoardCosmetic(
  clerkId: string,
  itemId: unknown,
  slot: "felt" | "card_back" | "deck_skin",
): Promise<EquipBoardResult> {
  if (typeof itemId !== "string" || !itemId.trim()) {
    return { ok: false, error: "An item id is required.", status: 400 };
  }
  const id = itemId.trim();

  const item = boardItem(id);
  // `felt_default` is the schema default and means Classic Green.
  const resolved = id === "felt_default" ? { kind: "felt" as const, streakDay: 0 } : item;
  if (!resolved || resolved.kind !== slot) {
    return { ok: false, error: "Unknown cosmetic for that slot.", status: 400 };
  }

  const account = await db.query.users.findFirst({
    where: eq(users.clerkId, clerkId),
    columns: { id: true },
  });
  if (!account) return { ok: false, error: "User not found", status: 404 };

  if (!(await ownsStreakItem(account.id, id, resolved.streakDay))) {
    return {
      ok: false,
      error: `Unlock this at a ${resolved.streakDay}-day streak.`,
      status: 403,
    };
  }

  const patch =
    slot === "felt"
      ? { equippedFelt: id }
      : slot === "card_back"
        ? { equippedCardBack: id }
        : { equippedDeckSkin: id };

  await db.update(users).set(patch).where(eq(users.id, account.id));
  return { ok: true, slot, itemId: id };
}

/** Bulk unlock lookup, for surfaces that decorate many players at once. */
export async function streakUnlocksForUsers(
  userIds: readonly number[],
): Promise<Map<number, Set<string>>> {
  const map = new Map<number, Set<string>>();
  const ids = Array.from(new Set(userIds.filter((id) => Number.isFinite(id))));
  if (ids.length === 0) return map;
  const rows = await db
    .select({ userId: userUnlocks.userId, itemId: userUnlocks.itemId })
    .from(userUnlocks)
    .where(inArray(userUnlocks.userId, ids));
  for (const row of rows) {
    if (!map.has(row.userId)) map.set(row.userId, new Set());
    map.get(row.userId)!.add(row.itemId);
  }
  return map;
}

export { MAX_BESPOKE_DAY };
