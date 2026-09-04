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
import { getPrestigeStatus } from "../../../lib/prestige";

export async function GET() {
  try {
    const { userId } = await auth();
    // The battlepass page is public (middleware allows it), so anonymous
    // visitors get a fresh level-1 / 0-XP pass and only signed-in users
    // read their real progress from the DB.
    let xp = 0;
    let dbUserId = null;
    let prestigeLevel = 0;
    let prestigeNetWins = 0;
    let ownedBannerKeys = new Set();
    let ownedEmoteKeys = new Set();
    if (userId) {
      const sql = getNeonSql();
      const rows = await sql`
        SELECT id, xp, prestige_level, prestige_net_wins
          FROM users
         WHERE clerk_id = ${userId}
         LIMIT 1
      `;
      dbUserId = rows[0]?.id ?? null;
      xp = Math.max(0, Math.floor(Number(rows[0]?.xp) || 0));
      prestigeLevel = Math.max(0, Math.floor(Number(rows[0]?.prestige_level) || 0));
      prestigeNetWins = Math.max(0, Math.floor(Number(rows[0]?.prestige_net_wins) || 0));
      if (dbUserId) {
        // Rewards are NEVER auto-granted — the player claims them on the
        // battlepass page (POST /api/battlepass/claim). We only read
        // existing ownership so previously-unlocked rewards (e.g. from the
        // old auto-grant era) still show as "Unlocked" and are never
        // revoked.
        const ownedRows = await sql`
          SELECT banner_key FROM user_banners WHERE user_id = ${dbUserId}
        `;
        ownedBannerKeys = new Set(ownedRows.map((row) => row.banner_key));
        const ownedEmoteRows = await sql`
          SELECT emote_key FROM user_emotes WHERE user_id = ${dbUserId}
        `;
        ownedEmoteKeys = new Set(ownedEmoteRows.map((row) => row.emote_key));
      }
    }
    const progress = getBattlepassProgress(xp);

    // Permanent Prestige (post-Level-100 progression). Read-only exposure —
    // Prestige is only ever written server-side by authoritative settlement
    // via src/lib/prestige.js.
    const prestigeStatus = getPrestigeStatus({
      prestigeLevel,
      prestigeNetWins,
      xp,
    });

    const titleByLevel = new Map(
      TITLE_MILESTONES.map((m) => [m.level, m]),
    );
    const levels = [];
    let unclaimedCount = 0;
    for (let level = 1; level <= MAX_LEVEL; level++) {
      const reached = level <= progress.level;
      const rewards = rewardsForLevel(level).map((reward) => {
        const isBanner = reward.type === "banner";
        const isEmote = reward.type === "emote";
        const owned =
          isBanner && dbUserId
            ? ownedBannerKeys.has(reward.key)
            : isEmote && dbUserId
              ? ownedEmoteKeys.has(reward.key)
              : false;
        // Claimable = the level is reached, the reward is an ownership-
        // tracked cosmetic (banner/emote), and it isn't owned yet.
        const claimable =
          !owned && reached && (isBanner || isEmote) && Boolean(reward.key);
        if (claimable) unclaimedCount += 1;
        return { ...reward, claimed: owned, claimable };
      });
      levels.push({
        level,
        xpRequired: expToReachLevel(level),
        xpForNext: expForNextLevel(level),
        title: titleByLevel.get(level) || null,
        // Battlepass rewards for this level. Empty array = reserved slot.
        rewards,
      });
    }

    return Response.json({
      success: true,
      pass: {
        ...progress,
        ...prestigeStatus,
        levels,
        // Number of banner/emote rewards the player has reached but not
        // yet claimed — drives the navbar nudge + "rewards ready" chip.
        unclaimedCount,
      },
    });
  } catch (err) {
    console.error("[BATTLEPASS_ERROR]", err);
    return Response.json(
      { success: false, error: "Failed to load battlepass" },
      { status: 500 },
    );
  }
}
