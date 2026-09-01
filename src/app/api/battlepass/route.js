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

export async function GET() {
  try {
    const { userId } = await auth();
    // The battlepass page is public (middleware allows it), so anonymous
    // visitors get a fresh level-1 / 0-XP pass and only signed-in users
    // read their real progress from the DB.
    let xp = 0;
    if (userId) {
      const sql = getNeonSql();
      const rows = await sql`
        SELECT xp FROM users WHERE clerk_id = ${userId} LIMIT 1
      `;
      xp = Math.max(0, Math.floor(Number(rows[0]?.xp) || 0));
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
        // Battlepass rewards for this level. Empty array = reserved slot
        // for future image-based rewards (icons, frames, cosmetics).
        rewards: rewardsForLevel(level),
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
