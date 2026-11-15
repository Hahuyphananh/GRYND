// src/lib/streaks/trial.ts
//
// THE PRO TRIAL CHECK — the second (and only other) way an account is PRO.
//
// A trial is a predicate, never a subscription row: nothing here creates or
// fakes a Stripe object. `pro_trial_expires_at` is written only by the streak
// milestones, and an account is a member while that instant is in the future.
//
// FAILURE POLICY — FAILS CLOSED. A trial is a paid entitlement, so an
// unreadable store must not hand one out: a database error reads as "no trial"
// and the account keeps whatever paid subscription it already has.

import { sql } from "drizzle-orm";

import { db } from "../../db";

/** True while the account holds an unexpired streak PRO trial. */
export async function hasActiveProTrial(
  clerkId: string | null | undefined,
  now: Date = new Date(),
): Promise<boolean> {
  if (!clerkId) return false;
  try {
    const result = await db.execute(sql`
      select 1
        from "user_streaks" s
        join "users" u on u."id" = s."user_id"
       where u."clerk_id" = ${clerkId}
         and s."pro_trial_expires_at" is not null
         and s."pro_trial_expires_at" > ${now}
       limit 1
    `);
    const rows = (result as { rows?: unknown }).rows ?? result;
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}
