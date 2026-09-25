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
//     destroy: the escalating daily reward (avg ~187/day over a 14-day
//     cycle, up to 350 on day 14) + milestone bonuses + streak-title
//     progress. Priced at 800 (≈ two days of an active player's income),
//     comfortably above the average daily reward, below the multi-hundred
//     milestone value so high-streak players still buy.
//
//   * xp_boost_2x_24h — EV ≈ extra battlepass XP for 24h (+200–500 XP for
//     an average active day). XP is progression-only (rewards are
//     cosmetics + functional items, not cashable tokens), so its EV is
//     soft; 500 stays the cheap impulse price but is still a real sink
//     against the 5,000-token starting balance.
//
//   * quest_boost_3 — EV ≈ 3 × average daily quest reward (~80) = 240
//     tokens returned, plus the doubled quest XP. Priced at 1,000: well
//     above the token EV (house keeps the edge) but still attractive
//     because the doubled XP rides along.
//
//   * quest_xp_boost_3 — like quest_boost_3 but doubles the quest XP (not
//     the quest reward value): EV is soft progression-only, priced at 1,200.
//
//   * quest_reroll — swap one daily quest for a fresh one (progress resets).
//     EV is close to zero in tokens; priced at 1,500 for the convenience.
//
//   * xp_boost_3x_12h — a stockpiled 3× XP window. Bought as a consumable
//     charge and ACTIVATED via POST /api/shop/items/use (duplicate
//     activation is refused while an instance is already running).
//
// Every timed window is a `xp_boost_{multiplier}x_{hours}h` effect key so
// the single XP multiplier path (getActiveXpMultiplier*) reads them all.
//
// ── Membership XP integration ──────────────────────────────────────────────
// Membership adds NO XP multiplier (GRYND PRO is non-competitive — see
// src/lib/stripe/subscriptions.ts). Only timed boosts from the item inventory
// multiply XP, and they are applied HERE so every XP source (settled wagers,
// quest claims, onboarding, Battle Pass claims) honors them without each
// caller doing its own resolution. This is pure progression — boosts never
// touch RNG, odds or win payouts.

export const SHOP_ITEMS = [
  {
    key: "streak_shield",
    name: "Daily Streak Shield",
    desc: "Protects your daily login streak for one missed day",
    price: 800,
    category: "consumable",
    qtyPerUse: 1,
    badge: "Retention",
    color: "#38bdf8",
    rarity: "Common",
    enabled: true,
    sortOrder: 1,
  },
  {
    key: "xp_boost_2x_24h",
    name: "2× XP Boost",
    desc: "Double all battlepass XP for 24 hours",
    price: 500,
    category: "timed",
    hours: 24,
    badge: "Progression",
    color: "#a3e635",
    rarity: "Common",
    enabled: true,
    sortOrder: 2,
  },
  {
    key: "quest_boost_3",
    name: "Quest Boost",
    desc: "Your next 3 quest claims pay double tokens",
    price: 1000,
    category: "consumable",
    qtyPerUse: 3,
    badge: "Economy",
    color: "#34d399",
    rarity: "Common",
    enabled: true,
    sortOrder: 3,
  },
  {
    key: "quest_xp_boost_3",
    name: "Quest XP Boost",
    desc: "Your next 3 quest claims pay double quest XP",
    price: 1200,
    category: "consumable",
    qtyPerUse: 3,
    badge: "Progression",
    color: "#a78bfa",
    rarity: "Rare",
    enabled: true,
    sortOrder: 4,
  },
  {
    key: "quest_reroll",
    name: "Quest Reroll",
    desc: "Swap one daily quest for a fresh one",
    price: 1500,
    category: "consumable",
    qtyPerUse: 1,
    badge: "Convenience",
    color: "#fbbf24",
    rarity: "Rare",
    enabled: true,
    sortOrder: 5,
  },
  {
    key: "xp_boost_3x_12h",
    name: "3× XP Boost (12h)",
    desc: "Stockpile: triple all battlepass XP for 12 hours. Activate it after buying.",
    price: 800,
    category: "consumable",
    qtyPerUse: 1,
    effect: {
      effectKey: "xp_boost_3x_12h",
      hours: 12,
    },
    badge: "Progression",
    color: "#f472b6",
    rarity: "Epic",
    enabled: true,
    sortOrder: 6,
  },
].filter((i) => i.enabled !== false);

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
 * (2 for a 2× boost, 3 for a 3× boost, 1 when none is active). Membership
 * grants NO XP multiplier — GRYND PRO is non-competitive, so only the timed
 * boosts from the Battle Pass / item inventory count. Checks by local user id.
 */
export async function getActiveXpMultiplier(userId) {
  const { db } = await import("../db");
  const { eq, sql } = await import("drizzle-orm");
  const { userItemEffects, users } = await import("../db/schema");

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
 * Returns the active XP multiplier (timed boosts only) for a user looked up by
 * Clerk id (used by the wager-XP settlement path, which only has the Clerk
 * id). Returns 1 when no boost is active.
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

/**
 * True when a timed effect is currently running for the user. Used as the
 * duplicate-activation guard by POST /api/shop/items/use — a stockpiled
 * boost refuses to activate a second copy while one is already running.
 */
export async function hasActiveEffect(userId, effectKey) {
  const { db } = await import("../db");
  const { sql } = await import("drizzle-orm");
  const { userItemEffects } = await import("../db/schema");

  const rows = await db
    .select({ id: userItemEffects.id })
    .from(userItemEffects)
    .where(
      sql`${userItemEffects.userId} = ${userId} AND ${userItemEffects.effectKey} = ${effectKey} AND ${userItemEffects.expiresAt} > now()`
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Server-authoritative "use item" flow for stockpiled boosts: atomically
 * consumes one inventory charge and starts (or extends) the timed effect.
 * Callers MUST guard duplicate activation first (claimIdempotency +
 * hasActiveEffect) so an already-running boost can't be double-spent.
 * Returns the new effect expiry, or null when the charge wasn't owned.
 */
export async function useItemAsEffect(userId, itemKey, effectKey, hours) {
  const charged = await consumeItem(userId, itemKey, 1);
  if (!charged) return null;
  await activateTimedEffect(userId, effectKey, hours);

  const { db } = await import("../db");
  const { sql } = await import("drizzle-orm");
  const { userItemEffects } = await import("../db/schema");
  const [row] = await db
    .select({ expiresAt: userItemEffects.expiresAt })
    .from(userItemEffects)
    .where(
      sql`${userItemEffects.userId} = ${userId} AND ${userItemEffects.effectKey} = ${effectKey}`
    )
    .limit(1);
  return row?.expiresAt?.toISOString() ?? null;
}