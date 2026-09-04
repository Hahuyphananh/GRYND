// app/api/battlepass/unclaimed/route.js
//
// GET /api/battlepass/unclaimed
//
// Lightweight count of battlepass rewards the player has REACHED but not
// yet claimed (banner/emote cosmetics only — the ownership-tracked
// types). Powers the navbar "rewards ready" badge + toast nudge without
// paying for the full 100-level track. Anonymous visitors get 0.

import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../db/neon";
import { getLevelFromXp } from "../../../../lib/battlepass";
import { rewardsForLevel } from "../../../../lib/battlepassRewards";

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
    const level = getLevelFromXp(
      Math.max(0, Math.floor(Number(rows[0]?.xp) || 0)),
    );

    const [bannerRows, emoteRows] = await Promise.all([
      sql`SELECT banner_key FROM user_banners WHERE user_id = ${dbUserId}`,
      sql`SELECT emote_key FROM user_emotes WHERE user_id = ${dbUserId}`,
    ]);
    const ownedBannerKeys = new Set(bannerRows.map((row) => row.banner_key));
    const ownedEmoteKeys = new Set(emoteRows.map((row) => row.emote_key));

    // Scan only levels the player has reached (cheap: the track is static).
    const claimableLevels = [];
    for (let lvl = 1; lvl <= level; lvl += 1) {
      for (const reward of rewardsForLevel(lvl)) {
        const owned =
          reward.type === "banner"
            ? ownedBannerKeys.has(reward.key)
            : reward.type === "emote"
              ? ownedEmoteKeys.has(reward.key)
              : false;
        if (!owned && (reward.type === "banner" || reward.type === "emote")) {
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