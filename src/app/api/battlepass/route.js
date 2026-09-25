// app/api/battlepass/route.js
//
// GET /api/battlepass
//
// Returns the player's battlepass progress (level, XP, progress to next
// level) plus the full 100-level track with thresholds, title milestones and
// every reward's owned / locked / claimable state. Rewards are NEVER
// auto-granted — this only reports what the player can claim.

import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../db/neon";
import {
  MAX_LEVEL,
  expForNextLevel,
  expToReachLevel,
  getBattlepassProgress,
} from "../../../lib/battlepass";
import { TITLE_MILESTONES } from "../../../lib/titles";
import {
  rewardsForLevel,
  COSMETIC_REWARD_TYPES,
} from "../../../lib/battlepassRewards";
import { getPrestigeStatus } from "../../../lib/prestige";
import { isPremiumMember } from "../../../lib/stripe/subscriptions";

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
    let ownedEmoteKeys = new Set();
    let ownedTitleKeys = new Set();
    let ownedGlowKeys = new Set();
    let ownedCosmeticKeys = new Set();
    // Per-level functional claims: "level:type" keys (xp_boost, quest_boost,
    // shield, battlepass_xp) — each identical track entry is claimable exactly
    // once.
    let functionalClaims = new Set();
    // Premium-track gating: non-members see premium rewards locked (unless
    // already owned — ownership is always honored first, so grandfathered
    // rewards stay unlocked forever).
    let isPremium = false;
    if (userId) {
      isPremium = await isPremiumMember(userId);
    }
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
        const ownedEmoteRows = await sql`
          SELECT emote_key FROM user_emotes WHERE user_id = ${dbUserId}
        `;
        ownedEmoteKeys = new Set(ownedEmoteRows.map((row) => row.emote_key));
        const ownedTitleRows = await sql`
          SELECT title_key FROM user_special_titles WHERE user_id = ${dbUserId}
        `;
        ownedTitleKeys = new Set(ownedTitleRows.map((row) => row.title_key));
        const ownedGlowRows = await sql`
          SELECT glow_key FROM user_glows WHERE user_id = ${dbUserId}
        `;
        ownedGlowKeys = new Set(ownedGlowRows.map((row) => row.glow_key));
        const ownedCosmeticRows = await sql`
          SELECT cosmetic_key FROM user_cosmetics WHERE user_id = ${dbUserId}
        `;
        ownedCosmeticKeys = new Set(
          ownedCosmeticRows.map((row) => row.cosmetic_key),
        );
        const claimRows = await sql`
          SELECT level, reward_type FROM battlepass_claims WHERE user_id = ${dbUserId}
        `;
        functionalClaims = new Set(
          claimRows.map((row) => `${row.level}:${row.reward_type}`),
        );
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
        const isEmote = reward.type === "emote";
        const isTitle = reward.type === "title";
        const isGlow = reward.type === "color";
        const isCosmetic = COSMETIC_REWARD_TYPES.has(reward.type);
        const isFunctional =
          reward.type === "xp_boost" ||
          reward.type === "quest_boost" ||
          reward.type === "shield" ||
          reward.type === "grynd" ||
          reward.type === "battlepass_xp" ||
          reward.type === "quest_reroll";
        const owned =
          isEmote && dbUserId
            ? ownedEmoteKeys.has(reward.key)
            : isTitle && dbUserId
              ? ownedTitleKeys.has(reward.key)
              : isGlow && dbUserId
                ? ownedGlowKeys.has(reward.key)
                : isCosmetic && dbUserId
                  ? ownedCosmeticKeys.has(reward.key)
                  : isFunctional && dbUserId
                    ? functionalClaims.has(`${level}:${reward.type}`)
                    : false;
        // Premium rewards are locked for non-members UNLESS already owned
        // (grandfathered owners keep their rewards visible + unlocked).
        const premium = reward.premium === true;
        const locked = premium && !isPremium && !owned;
        // Claimable = the level is reached, the reward is an ownership-
        // tracked type, it isn't owned yet, and it isn't premium-locked
        // for this member.
        const claimable =
          !owned &&
          !locked &&
          reached &&
          (isEmote || isTitle || isGlow || isCosmetic || isFunctional);
        if (claimable) unclaimedCount += 1;
        return { ...reward, premium, locked, claimed: owned, claimable };
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
        // Number of emote/title/glow/cosmetic/functional rewards the player
        // has reached but not yet claimed — drives the navbar nudge +
        // "rewards ready" chip.
        unclaimedCount,
        // True when the viewer holds an active Grynd+ membership — lets the
        // page render the premium track's lock state and subscribe CTA.
        isPremium,
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
