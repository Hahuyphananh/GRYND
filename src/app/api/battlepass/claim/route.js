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
import { getNeonSql } from "../../../../db/neon";
import { unlockEmote } from "../../../../lib/emotes";
import { unlockTitle } from "../../../../lib/specialTitles";
import { unlockGlow } from "../../../../lib/glows";
import { getLevelFromXp } from "../../../../lib/battlepass";
import { rewardsForLevel } from "../../../../lib/battlepassRewards";
import { isPremiumMember } from "../../../../lib/stripe/subscriptions";
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
    const isFunctional = type in FUNCTIONAL_GRANTS;
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