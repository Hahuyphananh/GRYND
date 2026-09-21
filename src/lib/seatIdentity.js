// src/lib/seatIdentity.js
//
// Shared seat-identity resolver for PvP match views. Resolves each seat's
// display identity in ONE query:
//   * name       — the real username
//   * iconKey    — the official Grynd icon key (users.selected_icon)
//   * nameColor  — the equipped name color (battlepass glow takes
//                  precedence; the Grynd+ custom chat color only surfaces
//                  for active members — mirroring the chat message route)
//
// Bot seats (e.g. "blackjack_ai_bot", "roulette_ai_bot", AI_BOT) have no
// users row and are skipped: their slot stays null and the client falls
// back to its localized label (e.g. "GRYND AI"). Real Clerk user ids are
// always prefixed "user_", which is how bot sentinels are excluded.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { glows, tokenSubscriptions, users } from "../db/schema";
import { ACTIVE_SUBSCRIPTION_STATUSES } from "./stripe/subscriptions";
import { getProfileFramesByKeys, pickProfileFrameKey } from "./cosmetics";

const ICON_KEY_REGEX = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const CLERK_ID_PREFIX = "user_";

function isRealUser(clerkId) {
  return (
    typeof clerkId === "string" && clerkId.startsWith(CLERK_ID_PREFIX)
  );
}

function resolveSeatIdentityRow(row) {
  if (!row) return null;
  const iconKey =
    typeof row.iconKey === "string" && ICON_KEY_REGEX.test(row.iconKey)
      ? row.iconKey
      : "default";
  return {
    name: row.name || null,
    iconKey,
    nameColor:
      row.glowColor || (Boolean(row.isPremium) ? row.chatColor || null : null),
  };
}

/**
 * Resolve both seats' identity (name / iconKey / nameColor) for a match
 * keyed by clerk ids. Non-user (bot) ids resolve to null.
 */
export async function getSeatIdentity(player1Id, player2Id) {
  const clerkIds = [player1Id, player2Id].filter(isRealUser);
  if (clerkIds.length === 0) {
    return { player1: null, player2: null };
  }

  const rows = await db
    .select({
      clerkId: users.clerkId,
      name: users.name,
      iconKey: users.selectedIcon,
      chatColor: users.chatColor,
      glowColor: glows.color,
      equippedCosmetics: users.equippedCosmetics,
      isPremium: sql`(${tokenSubscriptions.status} IS NOT NULL)`,
    })
    .from(users)
    .leftJoin(
      glows,
      and(eq(glows.key, users.selectedGlow), eq(glows.enabled, true)),
    )
    .leftJoin(
      tokenSubscriptions,
      and(
        eq(tokenSubscriptions.clerkId, users.clerkId),
        inArray(tokenSubscriptions.status, ACTIVE_SUBSCRIPTION_STATUSES),
      ),
    )
    .where(inArray(users.clerkId, clerkIds));

  const byClerkId = new Map(rows.map((row) => [row.clerkId, row]));
  // One catalog query resolves both seats' equipped profile frames.
  const frameByKey = await getProfileFramesByKeys(
    rows.map((row) => pickProfileFrameKey(row.equippedCosmetics)),
  );
  const resolve = (clerkId) => {
    if (!isRealUser(clerkId)) return null;
    const row = byClerkId.get(clerkId);
    const base = resolveSeatIdentityRow(row);
    if (!base) return null;
    const frameKey = pickProfileFrameKey(row?.equippedCosmetics);
    return {
      ...base,
      profileFrame: frameKey ? frameByKey.get(frameKey) || null : null,
    };
  };

  return {
    player1: resolve(player1Id),
    player2: resolve(player2Id),
  };
}

/**
 * Merge both seats' identity onto any match-shaped object (used by the
 * create/join routes so the initial render already shows real names,
 * icons and name colors before the first state poll adds them).
 */
export async function attachSeatIdentity(match) {
  if (!match) return match;
  const identity = await getSeatIdentity(match.player1Id, match.player2Id);
  return {
    ...match,
    player1Name: identity.player1?.name ?? null,
    player1IconKey: identity.player1?.iconKey ?? null,
    player1NameColor: identity.player1?.nameColor ?? null,
    player1ProfileFrame: identity.player1?.profileFrame ?? null,
    player2Name: identity.player2?.name ?? null,
    player2IconKey: identity.player2?.iconKey ?? null,
    player2NameColor: identity.player2?.nameColor ?? null,
    player2ProfileFrame: identity.player2?.profileFrame ?? null,
  };
}