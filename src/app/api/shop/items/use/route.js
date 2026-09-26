// app/api/shop/items/use/route.js
//
// POST /api/shop/items/use  { itemKey }
//
// Server-authoritative activation for stockpiled timed boosts (items that are
// bought as inventory charges and started later). Consumes exactly one charge
// and starts (or extends) the timed effect. Duplicate-activation guard: an
// already-running copy of the same effect refuses a second activation (409),
// and the request-level idempotency key rejects double-submits — so an
// activation can never be double-spent.

import { auth } from "@clerk/nextjs/server";
import { claimIdempotency } from "../../../../../lib/security/idempotency";
import {
  hasActiveEffect,
  shopItemByKey,
  useItemAsEffect,
  userIdByClerkId,
} from "../../../../../lib/shopItems";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return Response.json(
        { success: false, error: "Not authenticated" },
        { status: 401 }
      );
    }

    const idem = await claimIdempotency(req, "shop:items:use", 60);
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
    if (item.category !== "consumable" || !item.effect) {
      return Response.json(
        { success: false, error: "This item can't be activated" },
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

    // Duplicate-activation guard: don't stack a second running copy.
    if (await hasActiveEffect(localUserId, item.effect.effectKey)) {
      return Response.json(
        { success: false, error: "This boost is already active" },
        { status: 409 }
      );
    }

    const activeUntil = await useItemAsEffect(
      localUserId,
      item.key,
      item.effect.effectKey,
      item.effect.hours
    );
    if (!activeUntil) {
      return Response.json(
        { success: false, error: "You don't own this item" },
        { status: 400 }
      );
    }

    return Response.json({
      success: true,
      itemKey: item.key,
      effectKey: item.effect.effectKey,
      activeUntil,
    });
  } catch (err) {
    console.error("[SHOP_ITEMS_USE_ERROR]", err);
    return Response.json(
      { success: false, error: "Failed to activate item" },
      { status: 500 }
    );
  }
}