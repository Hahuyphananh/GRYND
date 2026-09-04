// app/api/battlepass/claim/route.js
//
// POST /api/battlepass/claim  { type: "banner" | "emote", key: string }
//
// Claims a single battlepass reward the player has reached. Server-side
// validation only: the reward must exist in the track at or below the
// player's current level, and it must be one of the ownership-tracked
// cosmetic types (banner / emote — the other reward types aren't
// claimable here). Idempotent: claiming an already-owned reward is a
// success no-op, so double-clicks / refreshes never duplicate ownership.

import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../db/neon";
import { unlockBanner } from "../../../../lib/banners";
import { unlockEmote } from "../../../../lib/emotes";
import { getLevelFromXp } from "../../../../lib/battlepass";
import { rewardsForLevel } from "../../../../lib/battlepassRewards";

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
    if ((type !== "banner" && type !== "emote") || !key) {
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

    // The claimed reward must exist somewhere at or below the player's
    // current level — the client can never ask for a locked reward.
    let rewardLevel = null;
    for (let lvl = 1; lvl <= level; lvl += 1) {
      const rewards = rewardsForLevel(lvl);
      if (rewards.some((r) => r.type === type && r.key === key)) {
        rewardLevel = lvl;
        break;
      }
    }
    if (rewardLevel === null) {
      return Response.json(
        { success: false, error: "Reward not available yet" },
        { status: 404 },
      );
    }

    const claimed = { type, key, level: rewardLevel };

    if (type === "banner") {
      const owned = await sql`
        SELECT 1 FROM user_banners
         WHERE user_id = ${dbUserId} AND banner_key = ${key}
         LIMIT 1
      `;
      if (owned.length > 0) {
        return Response.json({ success: true, alreadyClaimed: true, claimed });
      }
      await unlockBanner(dbUserId, key);
    } else {
      const owned = await sql`
        SELECT 1 FROM user_emotes
         WHERE user_id = ${dbUserId} AND emote_key = ${key}
         LIMIT 1
      `;
      if (owned.length > 0) {
        return Response.json({ success: true, alreadyClaimed: true, claimed });
      }
      await unlockEmote(dbUserId, key);
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