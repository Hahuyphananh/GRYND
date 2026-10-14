// src/lib/seatIdentity.js
//
// Shared seat-identity resolver for PvP match views. Resolves each seat's
// display identity in ONE query:
//   * name       — the real username
//   * iconKey    — the official Grynd icon key (users.selected_icon)
//   * nameColor  — the equipped name color (an owned catalog glow takes
//                  precedence, then the player's own chat color — mirroring the
//                  chat message route). The chat color is available to EVERY
//                  signed-in player: it used to be a GRYND PRO perk and is no
//                  longer gated, so it is no longer suppressed for free
//                  accounts either (hiding it would make the profile picker
//                  save a color nobody ever sees in a seat).
//
// Bot seats (e.g. "blackjack_ai_bot", "roulette_ai_bot", AI_BOT) have no
// users row and are skipped: their slot stays null and the client falls
// back to its localized label (e.g. "GRYND AI"). Real Clerk user ids are
// always prefixed "user_", which is how bot sentinels are excluded.
//
// GUEST seats (`guest_<uuid>`, see src/lib/guestIdentity.ts) resolve to the
// fixed guest identity — name "Guest", no icon (the avatar draws the "G"
// letter badge), no frame. They never touch the database: a guest owns no
// account, which is exactly why it can hold no rating, trophy or stat.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { glows, users } from "../db/schema";
import { getFrameDecorations } from "./cosmetics";
import { guestSeatIdentity, isGuestId } from "./guestIdentity";

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
    nameColor: row.glowColor || row.chatColor || null,
    isGuest: false,
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
    })
    .from(users)
    .leftJoin(
      glows,
      and(eq(glows.key, users.selectedGlow), eq(glows.enabled, true)),
    )
    .where(inArray(users.clerkId, clerkIds));

  const byClerkId = new Map(rows.map((row) => [row.clerkId, row]));
  // One catalog query resolves both seats' equipped profile frames.
  // One catalog pass resolves both seats' frames + avatar effects. The
  // avatar effect is embedded on the frame payload, so every
  // <FrameAvatar frame={...}> seat renders it with no extra plumbing.
  const decorations = await getFrameDecorations(
    rows.map((row) => row.equippedCosmetics),
  );
  const decorationByClerkId = new Map(
    rows.map((row, index) => [row.clerkId, decorations[index]]),
  );
  const resolve = (clerkId) => {
    if (isGuestId(clerkId)) return guestSeatIdentity();
    if (!isRealUser(clerkId)) return null;
    const row = byClerkId.get(clerkId);
    const base = resolveSeatIdentityRow(row);
    if (!base) return null;
    return {
      ...base,
      profileFrame: decorationByClerkId.get(clerkId) ?? null,
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
    player1IsGuest: identity.player1?.isGuest ?? false,
    player2Name: identity.player2?.name ?? null,
    player2IconKey: identity.player2?.iconKey ?? null,
    player2NameColor: identity.player2?.nameColor ?? null,
    player2ProfileFrame: identity.player2?.profileFrame ?? null,
    player2IsGuest: identity.player2?.isGuest ?? false,
  };
}