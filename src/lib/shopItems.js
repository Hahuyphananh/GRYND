// src/lib/shopItems.js
//
// Token-priced consumable item shop — the economy's token sink. Items are
// bought with users.balance (no cash value), written as `spend` rows in
// token_transactions, and stored in user_items (consumables) or
// user_item_effects (timed boosts).
//
// ── Pricing model (EV-anchored) ───────────────────────────────────────────
// Each price is set at-or-slightly-above the item's expected value so the
// shop is a net token sink (never a token printer):
//
//   * streak_shield — EV ≈ the login rewards a missed-day reset would
//     destroy: the escalating 25×day reward (avg ~187/day over a 14-day
//     cycle, up to 350 on day 14) + milestone bonuses + streak-title
//     progress. Priced at 200, comfortably above the average, below the
//     day-14 top-end so high-streak players still buy.
//
//   * xp_boost_2x_24h — EV ≈ extra battlepass XP for 24h (+200–500 XP for
//     an average active day). XP is progression-only (rewards are
//     cosmetics + functional items, not cashable tokens), so its EV is
//     soft; 150 is a cheap impulse price that still burns balance.
//
//   * quest_boost_3 — EV ≈ 3 × average daily quest reward (~80) = 240
//     tokens, plus the doubled quest XP. Priced at 280: above the token EV
//     (house keeps the edge) but still attractive because the XP rides
//     along.

export const SHOP_ITEMS = [
  {
    key: "streak_shield",
    name: "Daily Streak Shield",
    desc: "Protects your daily login streak for one missed day",
    price: 200,
    category: "consumable",
    badge: "Retention",
    color: "#38bdf8",
  },
  {
    key: "xp_boost_2x_24h",
    name: "2× XP Boost",
    desc: "Double all battlepass XP for 24 hours",
    price: 150,
    category: "timed",
    hours: 24,
    badge: "Progression",
    color: "#a3e635",
  },
  {
    key: "quest_boost_3",
    name: "Quest Boost",
    desc: "Your next 3 quest claims pay double tokens",
    price: 280,
    category: "consumable",
    qtyPerUse: 3,
    badge: "Economy",
    color: "#34d399",
  },
];

export function shopItemByKey(key) {
  return SHOP_ITEMS.find((i) => i.key === key) || null;
}

// ── Inventory helpers ─────────────────────────────────────────────────────

/**
 * Returns { items: {itemKey: qty}, effects: {effectKey: expiresAt} } for a
 * local user id (integer). Consumables are counted; timed effects return
 * their expiry (skipping already-expired rows).
 */
export async function getOwnedItems(userId) {
  const { db } = await import("../db");
  const { eq, gt, sql } = await import("drizzle-orm");
  const { userItems, userItemEffects } = await import("../db/schema");

  const [itemRows, effectRows] = await Promise.all([
    db
      .select({ itemKey: userItems.itemKey, qty: userItems.qty })
      .from(userItems)
      .where(eq(userItems.userId, userId)),
    db
      .select({ effectKey: userItemEffects.effectKey, expiresAt: userItemEffects.expiresAt })
      .from(userItemEffects)
      .where(
        sql`${userItemEffects.userId} = ${userId} AND ${userItemEffects.expiresAt} > now()`
      ),
  ]);

  const items = {};
  for (const r of itemRows) if (Number(r.qty) > 0) items[r.itemKey] = Number(r.qty);
  const effects = {};
  for (const r of effectRows) effects[r.effectKey] = r.expiresAt.toISOString();

  return { items, effects };
}

/**
 * Atomically consume `qty` of a consumable. Returns true only if the user
 * actually owned that many (the UPDATE is guarded by qty > 0), so a
 * concurrent purchase/consumption can never drive qty negative.
 */
export async function consumeItem(userId, itemKey, qty = 1) {
  const { db } = await import("../db");
  const { and, eq, sql } = await import("drizzle-orm");
  const { userItems } = await import("../db/schema");

  const rows = await db
    .update(userItems)
    .set({
      qty: sql`${userItems.qty} - ${Math.max(1, Math.floor(qty))}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userItems.userId, userId),
        eq(userItems.itemKey, itemKey),
        sql`${userItems.qty} >= ${Math.max(1, Math.floor(qty))}`
      )
    )
    .returning({ id: userItems.id });

  return rows.length > 0;
}

/**
 * True if the user currently holds at least `qty` of a consumable.
 * Non-consuming — used to decide whether a game hook *may* consume.
 */
export async function hasItem(userId, itemKey, qty = 1) {
  const { db } = await import("../db");
  const { and, eq } = await import("drizzle-orm");
  const { userItems } = await import("../db/schema");

  const rows = await db
    .select({ qty: userItems.qty })
    .from(userItems)
    .where(and(eq(userItems.userId, userId), eq(userItems.itemKey, itemKey)))
    .limit(1);

  return rows.length > 0 && Number(rows[0].qty) >= qty;
}

/**
 * Parses the multiplier out of an XP-boost effect key. Keys are encoded as
 * `xp_boost_{multiplier}x_{hours}h` (e.g. "xp_boost_2x_24h",
 * "xp_boost_3x_48h") so one table can hold every 2×/3× variant the
 * battlepass grants. Returns the multiplier or 1 when the key isn't an
 * XP boost.
 */
export function xpBoostMultiplierFromKey(effectKey) {
  const match = /^xp_boost_(\d+)x_\d+h$/.exec(String(effectKey || ""));
  return match ? Math.max(1, Math.floor(Number(match[1]) || 1)) : 1;
}

/**
 * Returns the highest XP multiplier among the user's active timed boosts
 * (2 for a 2× boost, 3 for a 3× boost, 1 when none is active). Checks by
 * local user id.
 */
export async function getActiveXpMultiplier(userId) {
  const { db } = await import("../db");
  const { eq, sql } = await import("drizzle-orm");
  const { userItemEffects } = await import("../db/schema");

  const rows = await db
    .select({ effectKey: userItemEffects.effectKey })
    .from(userItemEffects)
    .where(
      sql`${userItemEffects.userId} = ${userId} AND ${userItemEffects.expiresAt} > now()`
    );

  let multiplier = 1;
  for (const row of rows) {
    multiplier = Math.max(multiplier, xpBoostMultiplierFromKey(row.effectKey));
  }
  return multiplier;
}

/**
 * Returns the active XP-boost multiplier for a user looked up by Clerk id
 * (used by the wager-XP settlement path, which only has the Clerk id).
 * Returns 1 when no boost is active.
 */
export async function getActiveXpMultiplierByClerkId(clerkId) {
  const { db } = await import("../db");
  const { sql } = await import("drizzle-orm");
  const { userItemEffects, users } = await import("../db/schema");

  const rows = await db
    .select({ effectKey: userItemEffects.effectKey })
    .from(userItemEffects)
    .innerJoin(users, sql`${userItemEffects.userId} = ${users.id}`)
    .where(
      sql`${users.clerkId} = ${clerkId} AND ${userItemEffects.expiresAt} > now()`
    );

  let multiplier = 1;
  for (const row of rows) {
    multiplier = Math.max(multiplier, xpBoostMultiplierFromKey(row.effectKey));
  }
  return multiplier;
}

/**
 * Grant `qty` of a consumable into a user's inventory (upsert, additive).
 * Used by the battlepass claim route — same write shape as the shop buy
 * route.
 */
export async function grantItem(userId, itemKey, qty = 1) {
  const { db } = await import("../db");
  const { sql } = await import("drizzle-orm");
  const { userItems } = await import("../db/schema");

  const addQty = Math.max(1, Math.floor(qty));
  await db
    .insert(userItems)
    .values({ userId, itemKey, qty: addQty })
    .onConflictDoUpdate({
      target: [userItems.userId, userItems.itemKey],
      set: { qty: sql`${userItems.qty} + ${addQty}`, updatedAt: new Date() },
    });
  return true;
}

/**
 * Activate (or extend) a timed effect. Effect keys are e.g.
 * "xp_boost_2x_24h" — repurchasing/claiming EXTENDS the window rather
 * than stacking a second row. Used by the battlepass claim route.
 */
export async function activateTimedEffect(userId, effectKey, hours) {
  const { db } = await import("../db");
  const { sql } = await import("drizzle-orm");
  const { userItemEffects } = await import("../db/schema");

  const h = Math.max(1, Math.floor(hours));
  await db
    .insert(userItemEffects)
    .values({
      userId,
      effectKey,
      expiresAt: new Date(Date.now() + h * 3600 * 1000),
    })
    .onConflictDoUpdate({
      target: [userItemEffects.userId, userItemEffects.effectKey],
      set: {
        expiresAt: sql`GREATEST(${userItemEffects.expiresAt}, now()) + make_interval(hours => ${h})`,
        updatedAt: new Date(),
      },
    });
  return true;
}