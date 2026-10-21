// src/lib/quests/store.ts
//
// Persistence for quest slots: create this period's slots for a player (once),
// then read them back.
//
// NOT WIRED YET — deliberately. Nothing in this file reports a match result and
// no settlement writer imports it, so no quest can advance until the settlement
// hook is added deliberately (the next step). That keeps this landing small and
// keeps the "only a real human PvP match counts" rule in one reviewable place.
//
// Duplicate prevention is two-layered:
//   1. `buildQuestRows` is a pure function of (userId, periodType, periodKey),
//      so a retry derives the SAME (slot, quest) pairs;
//   2. the insert is `ON CONFLICT DO NOTHING` against the unique
//      (user_id, period_type, period_key, slot) constraint, so two concurrent
//      first-reads cannot create two rows for one slot.
//
// Reading is always scoped to the current period key, so yesterday's rows stay
// exactly as they ended (claimable history) and today starts clean.

import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { userQuests } from "../../db/schema";
import { buildQuestRows } from "./definitions";
import { periodKeyFor } from "./periods";
import { normalizeQuestRow, toQuestView } from "./progress";
import type { QuestPeriodType, QuestRow, QuestView } from "./types";

/**
 * The shared `db` or a transaction around it. Typed loosely on purpose — the
 * same rationale as src/lib/tokens/creditTokens.ts and tokens/wager.ts: both
 * expose the same chained `.insert()/.select()` shape, and a claim that must be
 * atomic has to pass whichever one it holds.
 */
type QuestDb = any;

/**
 * Make sure the player's slots for the period containing `now` exist, then
 * return them in slot order. Idempotent: safe to call on every read.
 */
export async function ensurePeriodQuests(
  userId: number,
  periodType: QuestPeriodType,
  { now = new Date(), tx = db }: { now?: Date; tx?: QuestDb } = {},
): Promise<QuestRow[]> {
  const periodKey = periodKeyFor(periodType, now);
  const drafts = buildQuestRows({ userId, periodType, periodKey });

  if (drafts.length > 0) {
    await tx
      .insert(userQuests)
      .values(drafts)
      .onConflictDoNothing({
        target: [
          userQuests.userId,
          userQuests.periodType,
          userQuests.periodKey,
          userQuests.slot,
        ],
      });
  }

  return listPeriodQuests(userId, periodType, { now, tx });
}

/** The player's stored slots for the period containing `now`, in slot order. */
export async function listPeriodQuests(
  userId: number,
  periodType: QuestPeriodType,
  { now = new Date(), tx = db }: { now?: Date; tx?: QuestDb } = {},
): Promise<QuestRow[]> {
  const rows: unknown[] = await tx
    .select()
    .from(userQuests)
    .where(
      and(
        eq(userQuests.userId, userId),
        eq(userQuests.periodType, periodType),
        eq(userQuests.periodKey, periodKeyFor(periodType, now)),
      ),
    )
    .orderBy(userQuests.slot);

  return rows.map(normalizeQuestRow);
}

/**
 * Both boards for a player — daily and weekly for the current UTC periods,
 * each row projected to what the UI renders.
 */
export async function getQuestBoard(
  userId: number,
  { now = new Date(), tx = db }: { now?: Date; tx?: QuestDb } = {},
): Promise<{ daily: QuestView[]; weekly: QuestView[] }> {
  const [daily, weekly] = await Promise.all([
    ensurePeriodQuests(userId, "daily", { now, tx }),
    ensurePeriodQuests(userId, "weekly", { now, tx }),
  ]);

  return { daily: daily.map(toQuestView), weekly: weekly.map(toQuestView) };
}
