// app/api/shop/items/buy/route.js
//
// POST /api/shop/items/buy  { itemKey }
//
// Token-priced shop purchase. Debited from users.balance inside the same
// transaction that writes the `spend` ledger row (token_transactions) and
// grants the item, so the balance, the ledger, and the inventory can never
// disagree. Idempotent per request via claimIdempotency (a double-submit
// can't double-charge — the second request is rejected as a duplicate).

import { auth } from "@clerk/nextjs/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../../../../db";
import {
  tokenTransactions,
  userItemEffects,
  userItems,
  users,
} from "../../../../../db/schema";
import { claimIdempotency } from "../../../../../lib/security/idempotency";
import { shopItemByKey } from "../../../../../lib/shopItems";
import { userIdByClerkId } from "../../../../../lib/quests";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return Response.json(
        { success: false, error: "Not authenticated" },
        { status: 401 }
      );
    }

    const idem = await claimIdempotency(req, "shop:items:buy", 180);
    if (idem.enforced && !idem.allowed) {
      return Response.json(
        { success: false, error: "Duplicate request" },
        { status: 409 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const itemKey = typeof body?.itemKey === "string" ? body.itemKey.trim() : "";
    const item = shopItemByKey(itemKey);
    if (!item) {
      return Response.json(
        { success: false, error: "Unknown item" },
        { status: 400 }
      );
    }

    const localUserId = await userIdByClerkId(userId);
    if (!localUserId) {
      return Response.json(
        { success: false, error: "User not found" },
        { status: 404 }
      );
    }

    const price = item.price;

    const result = await db.transaction(async (tx) => {
      // Lock the user row and check the balance inside the transaction so
      // two concurrent purchases can't both pass the check.
      const [user] = await tx
        .select({ id: users.id, balance: users.balance })
        .from(users)
        .where(eq(users.clerkId, userId))
        .for("update");

      if (!user) throw new Error("User not found");
      const balance = Number(user.balance ?? 0);
      if (balance < price) {
        const err = new Error("Insufficient balance");
        err.code = "INSUFFICIENT_BALANCE";
        throw err;
      }

      // 1) Debit balance.
      await tx
        .update(users)
        .set({ balance: sql`${users.balance} - ${price}` })
        .where(eq(users.id, user.id));

      // 2) Ledger — the dormant `spend` type finally gets its rows.
      await tx.insert(tokenTransactions).values({
        clerkId: userId,
        type: "spend",
        amount: -price,
        referenceType: "shop_item",
        referenceId: itemKey,
        note: item.name,
      });

      // 3) Grant the item.
      if (item.category === "timed" && item.hours) {
        // Timed boost: extend the active window rather than stacking rows.
        await tx
          .insert(userItemEffects)
          .values({
            userId: user.id,
            effectKey: item.key,
            expiresAt: new Date(Date.now() + item.hours * 3600 * 1000),
          })
          .onConflictDoUpdate({
            target: [userItemEffects.userId, userItemEffects.effectKey],
            set: {
              expiresAt: sql`GREATEST(${userItemEffects.expiresAt}, now()) + make_interval(hours => ${item.hours})`,
              updatedAt: new Date(),
            },
          });
      } else {
        const addQty = item.qtyPerUse ?? 1;
        await tx
          .insert(userItems)
          .values({ userId: user.id, itemKey: item.key, qty: addQty })
          .onConflictDoUpdate({
            target: [userItems.userId, userItems.itemKey],
            set: {
              qty: sql`${userItems.qty} + ${addQty}`,
              updatedAt: new Date(),
            },
          });
      }

      return { newBalance: balance - price };
    });

    return Response.json({
      success: true,
      itemKey: item.key,
      balance: result.newBalance,
    });
  } catch (err) {
    console.error("[SHOP_ITEMS_BUY_ERROR]", err);
    if (err?.code === "INSUFFICIENT_BALANCE") {
      return Response.json(
        { success: false, error: "Insufficient balance" },
        { status: 400 }
      );
    }
    return Response.json(
      { success: false, error: "Failed to buy item" },
      { status: 500 }
    );
  }
}