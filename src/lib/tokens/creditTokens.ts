// src/lib/tokens/creditTokens.ts
//
// THE single authority for crediting the virtual-token balance. Tokens live
// in the existing `users.balance` column (there is no second currency).
//
// Every path that adds purchased/won/donated tokens funnels through
// creditUserBalance so there is exactly one way to move `balance` upward:
//   * the signed payment webhook  (/api/webhooks/payments)
//   * the Stripe webhook          (/api/stripe/webhook)
//
// The credit is a single atomic `UPDATE ... SET balance = balance + X`, so a
// concurrent webhook retry can never overwrite a higher balance. Callers are
// responsible for idempotency (durable keys / ledger rows) BEFORE crediting.

import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { users } from "../../db/schema";

// The executor is either the shared `db` or a transaction (`tx`) created by
// `db.transaction(...)` so callers can credit atomically with other writes.
// Typed loosely on purpose — both expose the same chained `.update().set()...
// WHERE eq(clerk_id, ?) ... RETURNING balance` shape.
type CreditDb = { update: (table: any) => any };

/**
 * Atomically add `amount` tokens to a user's `balance` (identified by their
 * Clerk id) and return the new balance. Returns `null` when no user exists.
 */
export async function creditUserBalance(
  clerkId: string,
  amount: number,
  ctx: CreditDb = db
): Promise<number | null> {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Invalid credit amount");
  }
  const [updated] = await ctx
    .update(users)
    .set({ balance: sql`${users.balance} + ${Number(amount.toFixed(2))}` })
    .where(eq(users.clerkId, clerkId))
    .returning({ balance: users.balance });
  return updated ? Number(updated.balance) : null;
}
