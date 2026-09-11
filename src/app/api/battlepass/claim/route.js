// app/api/battlepass/claim/route.js
//
// POST /api/battlepass/claim  { type, key? | level? }
//
// Claims a single battlepass reward the player has reached. Server-side
// validation only: the reward must exist in the track at or below the
// player's current level. Supports every ownership-tracked reward type:
//
//   * emote                — key-based cosmetics (user_emotes)
//   * title                — battlepass-exclusive special titles
//                       (user_special_titles via unlockTitle)
//   * xp_boost / quest_boost / shield — functional rewards granted into
//                       the item-shop inventory (user_item_effects /
//                       user_items), recorded per-level in
//                       battlepass_claims so each identical track entry
//                       is claimable exactly once.
//
// Idempotent: claiming an already-owned reward is a success no-op, so
// double-clicks / refreshes never duplicate grants. Grandfathering: owned
// rewards are returned as already-claimed BEFORE the premium gate, so a
// member who earned a premium reward keeps it even after their membership
// lapses.

import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getNeonSql } from "../../../../db/neon";
import { db } from "../../../../db";
import {
  tokenSubscriptionPlans,
  stripeCheckoutSessions,
} from "../../../../db/schema";
import { unlockEmote } from "../../../../lib/emotes";
import { unlockTitle } from "../../../../lib/specialTitles";
import { unlockGlow } from "../../../../lib/glows";
import { getLevelFromXp } from "../../../../lib/battlepass";
import { rewardsForLevel } from "../../../../lib/battlepassRewards";
import { getStripe, getBaseUrl } from "../../../../lib/stripe";
import {
  isPremiumMember,
  ensureSubscriptionPlanStripe,
  findActiveSubscription,
} from "../../../../lib/stripe/subscriptions";
import {
  activateTimedEffect,
  grantItem,
} from "../../../../lib/shopItems";

// Reward types that can be granted. The functional types carry no key —
// they're disambiguated by the track level in the request.
const CLAIMABLE_TYPES = new Set([
  "emote",
  "title",
  "color",
  "grynd",
  "xp_boost",
  "quest_boost",
  "shield",
]);
// Functional reward types → item-shop inventory mapping.
const FUNCTIONAL_GRANTS = {
  xp_boost: null, // handled specially (effect key encodes multiplier×hours)
  quest_boost: { itemKey: "quest_boost_3" },
  shield: { itemKey: "streak_shield" },
};

/** 8 random lowercase letters suffix for the checkout integration_identifier. */
function randomSuffix() {
  return Math.random().toString(36).slice(2, 10).toLowerCase();
}

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return Response.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const type = body?.type;
    const key = typeof body?.key === "string" ? body.key.trim() : "";
    const levelParam = Number(body?.level);
    if (!CLAIMABLE_TYPES.has(type)) {
      return Response.json(
        { success: false, error: "Invalid reward" },
        { status: 400 },
      );
    }

    const sql = getNeonSql();
    const rows = await sql`
      SELECT id, xp FROM users WHERE clerk_id = ${userId} LIMIT 1
    `;
    const dbUserId = rows[0]?.id ?? null;
    if (!dbUserId) {
      return Response.json(
        { success: false, error: "User not found" },
        { status: 404 },
      );
    }
    const level = getLevelFromXp(
      Math.max(0, Math.floor(Number(rows[0]?.xp) || 0)),
    );

    // Locate the claimed reward:
    //   * key-based types (emote/title/color) — first matching entry at or
    //     below the player's level (existing behavior).
    //   * functional types (xp_boost/quest_boost/shield) — the EXACT track
    //     level in the request (they have no key, and each identical entry
    //     is a distinct claimable reward).
    let rewardLevel = null;
    let reward = null;
    const isFunctional = type in FUNCTIONAL_GRANTS || type === "grynd";
    if (isFunctional) {
      if (!Number.isInteger(levelParam) || levelParam < 1 || levelParam > level) {
        return Response.json(
          { success: false, error: "Reward not available yet" },
          { status: 404 },
        );
      }
      const match = rewardsForLevel(levelParam).find((r) => r.type === type);
      if (!match) {
        return Response.json(
          { success: false, error: "Reward not available yet" },
          { status: 404 },
        );
      }
      rewardLevel = levelParam;
      reward = match;
    } else {
      if (!key) {
        return Response.json(
          { success: false, error: "Invalid reward" },
          { status: 400 },
        );
      }
      for (let lvl = 1; lvl <= level; lvl += 1) {
        const rewards = rewardsForLevel(lvl);
        const match = rewards.find((r) => r.type === type && r.key === key);
        if (match) {
          rewardLevel = lvl;
          reward = match;
          break;
        }
      }
      if (rewardLevel === null) {
        return Response.json(
          { success: false, error: "Reward not available yet" },
          { status: 404 },
        );
      }
    }

    const claimed = { type, key, level: rewardLevel };

    // ── Grandfathering FIRST ──
    // Ownership is checked before the premium gate: anyone who already owns
    // this reward keeps claiming it forever — even non-members whose
    // membership lapsed. Premium status only blocks NEW claims.
    let owned = false;
    if (type === "emote") {
      const ownedRows = await sql`
        SELECT 1 FROM user_emotes
         WHERE user_id = ${dbUserId} AND emote_key = ${key}
         LIMIT 1
      `;
      owned = ownedRows.length > 0;
    } else if (type === "title") {
      const ownedRows = await sql`
        SELECT 1 FROM user_special_titles
         WHERE user_id = ${dbUserId} AND title_key = ${key}
         LIMIT 1
      `;
      owned = ownedRows.length > 0;
    } else if (type === "color") {
      const ownedRows = await sql`
        SELECT 1 FROM user_glows
         WHERE user_id = ${dbUserId} AND glow_key = ${key}
         LIMIT 1
      `;
      owned = ownedRows.length > 0;
    } else {
      // Functional rewards: per-level claim journal.
      const ownedRows = await sql`
        SELECT 1 FROM battlepass_claims
         WHERE user_id = ${dbUserId} AND level = ${rewardLevel} AND reward_type = ${type}
         LIMIT 1
      `;
      owned = ownedRows.length > 0;
    }
    if (owned) {
      return Response.json({ success: true, alreadyClaimed: true, claimed });
    }

    // ── Premium gate (only for new claims) ──
    if (reward?.premium === true && !(await isPremiumMember(userId))) {
      return Response.json(
        { success: false, error: "Grynd+ membership required for this reward" },
        { status: 403 },
      );
    }

    // ── Grant ──
    if (type === "emote") {
      await unlockEmote(dbUserId, key);
    } else if (type === "title") {
      await unlockTitle(dbUserId, key);
    } else if (type === "color") {
      await unlockGlow(dbUserId, key);
    } else if (type === "grynd") {
      // Membership-trial reward ("X Days of Grynd+"): send the player to a
      // Stripe subscription checkout with a FREE trial of `days` days. The
      // card is set up during checkout but nothing is charged until the
      // trial ends. The trial subscription (status "trialing") counts as an
      // active membership — badges/tier work immediately; the first monthly
      // tokens are granted by the webhook on the first PAID invoice.
      const days = Math.min(30, Math.max(1, Number(reward.value) || 7));
      const active = await findActiveSubscription(userId);
      if (active) {
        return Response.json(
          {
            success: false,
            error:
              "You already have an active membership — this free-trial reward applies to a new membership.",
            code: "already_subscribed",
          },
          { status: 409 },
        );
      }
      const plan = await db
        .select()
        .from(tokenSubscriptionPlans)
        .where(eq(tokenSubscriptionPlans.key, "grynd-plus"))
        .limit(1)
        .then((rows) => rows[0]);
      if (!plan || !plan.enabled) {
        throw new Error("grynd-plus plan is missing or disabled");
      }
      const resolvedPriceId = (
        await ensureSubscriptionPlanStripe({
          id: plan.id,
          key: plan.key,
          name: plan.name,
          monthlyTokens: Number(plan.monthlyTokens),
          priceCents: plan.priceCents,
          stripeProductId: plan.stripeProductId,
          stripePriceId: plan.stripePriceId,
        })
      ).priceId;
      const baseUrl = getBaseUrl();
      const session = await getStripe().checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: resolvedPriceId, quantity: 1 }],
        client_reference_id: userId,
        metadata: { clerkId: userId, planKey: plan.key, battlepassTrialDays: days },
        subscription_data: {
          metadata: { clerkId: userId, planKey: plan.key, battlepassTrialDays: days },
          trial_period_days: days,
        },
        success_url: `${baseUrl}/battlepass?checkout=success`,
        cancel_url: `${baseUrl}/battlepass?checkout=cancelled`,
        allow_promotion_codes: true,
        managed_payments: { enabled: true },
        integration_identifier: `grynd_bp_trial_${randomSuffix()}`,
      });
      await db
        .insert(stripeCheckoutSessions)
        .values({
          sessionId: session.id,
          clerkId: userId,
          packageKey: plan.key,
          sessionMode: "subscription",
          tokenAmount: 0,
          amountCents: plan.priceCents,
          currency: "usd",
          paymentStatus: "open",
          fulfilled: false,
        })
        .onConflictDoNothing({ target: stripeCheckoutSessions.sessionId });
      await sql`
        INSERT INTO battlepass_claims (user_id, level, reward_type, reward_key)
        VALUES (${dbUserId}, ${rewardLevel}, 'grynd', NULL)
        ON CONFLICT DO NOTHING
      `;
      return Response.json({
        success: true,
        alreadyClaimed: false,
        claimed,
        checkoutUrl: session.url ?? null,
      });
    } else {
      // Functional rewards: grant the inventory item / timed effect, then
      // record the per-level claim so the identical entry can't be claimed
      // twice. (For title/emote/color the ownership row IS the record.)
      if (type === "xp_boost") {
        const mult = Number(reward.value?.multiplier) || 2;
        const hours = Number(reward.value?.hours) || 24;
        await activateTimedEffect(
          dbUserId,
          `xp_boost_${mult}x_${hours}h`,
          hours,
        );
      } else {
        const grant = FUNCTIONAL_GRANTS[type];
        const qty =
          type === "shield"
            ? Number(reward.value) || 1
            : Number(reward.value) || grant.qtyPerUse || 1;
        await grantItem(dbUserId, grant.itemKey, qty);
      }
      await sql`
        INSERT INTO battlepass_claims (user_id, level, reward_type, reward_key)
        VALUES (${dbUserId}, ${rewardLevel}, ${type}, ${key || null})
        ON CONFLICT DO NOTHING
      `;
    }

    return Response.json({ success: true, alreadyClaimed: false, claimed });
  } catch (err) {
    console.error("[BATTLEPASS_CLAIM_ERROR]", err);
    return Response.json(
      { success: false, error: "Failed to claim reward" },
      { status: 500 },
    );
  }
}