// app/api/battlepass/route.js
//
// GET /api/battlepass
//
// Returns the player's battlepass progress (level, XP, progress to next
// level) plus the full 100-level track with thresholds and title
// milestones. No rewards yet — the track's reward slots are placeholders.

import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../db/neon";
import {
  MAX_LEVEL,
  expForNextLevel,
  expToReachLevel,
  getBattlepassProgress,
} from "../../../lib/battlepass";
import { TITLE_MILESTONES } from "../../../lib/titles";
import { rewardsForLevel } from "../../../lib/battlepassRewards";
import { grantBattlepassBanners } from "../../../lib/banners";

export async function GET() {
  try {
    const { userId } = await auth();
    // The battlepass page is public (middleware allows it), so anonymous
    // visitors get a fresh level-1 / 0-XP pass and only signed-in users
    // read their real progress from the DB.
    let xp = 0;
    let dbUserId = null;
    let ownedBannerKeys = new Set();
    if (userId) {
      const sql = getNeonSql();
      const rows = await sql`
        SELECT id, xp FROM users WHERE clerk_id = ${userId} LIMIT 1
      `;
      dbUserId = rows[0]?.id ?? null;
      xp = Math.max(0, Math.floor(Number(rows[0]?.xp) || 0));
      if (dbUserId) {
        await grantBattlepassBanners(dbUserId, getBattlepassProgress(xp).level).catch((error) => {
          console.error("[BATTLEPASS_BANNER_GRANT_ERROR]", error);
        });
        const ownedRows = await sql`
          SELECT banner_key FROM user_banners WHERE user_id = ${dbUserId}
        `;
        ownedBannerKeys = new Set(ownedRows.map((row) => row.banner_key));
      }
    }
    const progress = getBattlepassProgress(xp);

    const titleByLevel = new Map(
      TITLE_MILESTONES.map((m) => [m.level, m]),
    );
    const levels = [];
    for (let level = 1; level <= MAX_LEVEL; level++) {
      levels.push({
        level,
        xpRequired: expToReachLevel(level),
        xpForNext: expForNextLevel(level),
        title: titleByLevel.get(level) || null,
        // Battlepass rewards for this level. Empty array = reserved slot.
        rewards: rewardsForLevel(level).map((reward) => ({
          ...reward,
          claimed: reward.type === "banner" && dbUserId
            ? ownedBannerKeys.has(reward.key)
            : false,
        })),
      });
    }

    return Response.json({ success: true, pass: { ...progress, levels } });
  } catch (err) {
    console.error("[BATTLEPASS_ERROR]", err);
    return Response.json(
      { success: false, error: "Failed to load battlepass" },
      { status: 500 },
    );
  }
}
