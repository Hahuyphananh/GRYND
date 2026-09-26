// app/api/battlepass/unclaimed/route.js
//
// GET /api/battlepass/unclaimed
//
// Lightweight count of battlepass rewards the player has REACHED but not
// yet claimed (emote/title/glow cosmetics + functional rewards — the
// ownership-tracked types). Powers the navbar "rewards ready" badge +
// toast nudge without paying for the full 100-level track. Anonymous
// visitors get 0.

import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../db/neon";
import { getLevelFromTrophies } from "../../../../lib/battlepass";
import { getTotalTrophiesForUser } from "../../../../lib/trophyStore";
import {
  rewardsForLevel,
  COSMETIC_REWARD_TYPES,
} from "../../../../lib/battlepassRewards";
import { isPremiumMember } from "../../../../lib/stripe/subscriptions";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return Response.json({ success: true, count: 0, levels: [] });
    }

    const sql = getNeonSql();
    const rows = await sql`
      SELECT id, xp FROM users WHERE clerk_id = ${userId} LIMIT 1
    `;
    const dbUserId = rows[0]?.id ?? null;
    if (!dbUserId) {
      return Response.json({ success: true, count: 0, levels: [] });
    }
    // Level is derived from TROPHIES (10,000 total = level 100), not XP.
    const level = getLevelFromTrophies(await getTotalTrophiesForUser(userId));

    // Premium-track gating mirrors /api/battlepass: non-members must not be
    // nudged about premium rewards they can't claim. Owned (grandfathered)
    // premium rewards are still excluded from the count either way.
    const isPremium = await isPremiumMember(userId);

    const [emoteRows, titleRows, glowRows, cosmeticRows, claimRows] =
      await Promise.all([
        sql`SELECT emote_key FROM user_emotes WHERE user_id = ${dbUserId}`,
        sql`SELECT title_key FROM user_special_titles WHERE user_id = ${dbUserId}`,
        sql`SELECT glow_key FROM user_glows WHERE user_id = ${dbUserId}`,
        sql`SELECT cosmetic_key FROM user_cosmetics WHERE user_id = ${dbUserId}`,
        sql`SELECT level, reward_type FROM battlepass_claims WHERE user_id = ${dbUserId}`,
      ]);
    const ownedEmoteKeys = new Set(emoteRows.map((row) => row.emote_key));
    const ownedTitleKeys = new Set(titleRows.map((row) => row.title_key));
    const ownedGlowKeys = new Set(glowRows.map((row) => row.glow_key));
    const ownedCosmeticKeys = new Set(cosmeticRows.map((row) => row.cosmetic_key));
    const functionalClaims = new Set(
      claimRows.map((row) => `${row.level}:${row.reward_type}`),
    );

    // Scan only levels the player has reached (cheap: the track is static).
    const claimableLevels = [];
    for (let lvl = 1; lvl <= level; lvl += 1) {
      for (const reward of rewardsForLevel(lvl)) {
        const isTitle = reward.type === "title";
        const isGlow = reward.type === "color";
        const isCosmetic = COSMETIC_REWARD_TYPES.has(reward.type);
        const isFunctional =
          reward.type === "xp_boost" ||
          reward.type === "shield" ||
          reward.type === "grynd" ||
          reward.type === "battlepass_xp";
        const owned =
          reward.type === "emote"
            ? ownedEmoteKeys.has(reward.key)
            : isTitle
              ? ownedTitleKeys.has(reward.key)
              : isGlow
                ? ownedGlowKeys.has(reward.key)
                : isCosmetic
                  ? ownedCosmeticKeys.has(reward.key)
                  : isFunctional
                    ? functionalClaims.has(`${lvl}:${reward.type}`)
                    : false;
        const premiumLocked = reward.premium === true && !isPremium && !owned;
        if (
          !owned &&
          !premiumLocked &&
          (reward.type === "emote" || isTitle || isGlow || isFunctional || isCosmetic)
        ) {
          claimableLevels.push(lvl);
        }
      }
    }

    return Response.json({
      success: true,
      count: claimableLevels.length,
      levels: claimableLevels,
    });
  } catch (err) {
    console.error("[BATTLEPASS_UNCLAIMED_ERROR]", err);
    return Response.json({ success: true, count: 0, levels: [] });
  }
}