// app/api/shop/items/route.js
//
// GET /api/shop/items
//
// Returns the token-priced item catalog with the player's owned quantities
// and active timed effects, plus their balance — everything the shop UI
// needs in one request.

import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { getOwnedItems, SHOP_ITEMS } from "../../../../lib/shopItems";
import { userIdByClerkId } from "../../../../lib/quests";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return Response.json(
        { success: false, error: "Not authenticated" },
        { status: 401 }
      );
    }

    const localUserId = await userIdByClerkId(userId);
    if (!localUserId) {
      return Response.json(
        { success: false, error: "User not found" },
        { status: 404 }
      );
    }

    const [user, owned] = await Promise.all([
      db
        .select({ balance: users.balance })
        .from(users)
        .where(eq(users.clerkId, userId))
        .limit(1),
      getOwnedItems(localUserId),
    ]);

    const balance = user.length ? Number(user[0].balance ?? 0) : 0;

    const items = SHOP_ITEMS.map((item) => {
      const isTimed = item.category === "timed";
      const effectKey =
        item.effect?.effectKey ?? (isTimed ? item.key : null);
      return {
        key: item.key,
        name: item.name,
        desc: item.desc,
        price: item.price,
        category: item.category,
        badge: item.badge ?? null,
        color: item.color ?? null,
        owned: isTimed ? null : owned.items[item.key] ?? 0,
        activeUntil: effectKey ? owned.effects[effectKey] ?? null : null,
        // Stockpiled boost: bought as inventory, started later via
        // POST /api/shop/items/use. `scope` helps the UI nudge the player to
        // the right page for consumables that act elsewhere.
        activatable: Boolean(item.effect),
        effectKey,
        effectHours: item.effect?.hours ?? item.hours ?? null,
        scope: item.key === "quest_reroll" ? "quests" : "shop",
      };
    });

    return Response.json({ success: true, balance, items });
  } catch (err) {
    console.error("[SHOP_ITEMS_GET_ERROR]", err);
    return Response.json(
      { success: false, error: "Failed to load items" },
      { status: 500 }
    );
  }
}