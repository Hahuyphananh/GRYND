import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { chatMessages, glows, specialTitles, tokenSubscriptions, users } from "../../../../db/schema";
import { checkUnlocks } from "../../../../lib/specialTitles";
import { computeEquippedStreakTitle } from "../../../../lib/streakTitles";
import { resolvePrestigeBadge } from "../../../../lib/prestige";
import {
  getFrameDecorations,
  getCosmeticsByKeysForCategory,
  pickEquippedKey,
  resolveEquippedCosmetic,
} from "../../../../lib/cosmetics";
import { sanitizeString } from "../../../../lib/security/validation";
import { cacheOrFetch } from "../../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../../lib/redis/keys";
import { ACTIVE_SUBSCRIPTION_STATUSES, isPremiumMember } from "../../../../lib/stripe/subscriptions";

// Membership badge shown next to members' names in chat. GRYND has a single
// paid plan (GRYND PRO) — there are no tiers.
const MEMBERSHIP_TITLE = "GRYND PRO";

const ALLOWED_ROOM_TYPES = new Set(["global", "game"]);
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeRoom(roomType, roomId) {
  if (!ALLOWED_ROOM_TYPES.has(roomType)) {
    return { error: "Invalid roomType." };
  }

  const safeRoomId = (roomId || "").trim();
  if (!safeRoomId || safeRoomId.length > 255) {
    return { error: "Invalid roomId." };
  }

  return { roomType, roomId: safeRoomId };
}

async function purgeExpiredMessages() {
  const cutoff = new Date(Date.now() - MESSAGE_TTL_MS);
  await db.delete(chatMessages).where(lt(chatMessages.createdAt, cutoff));
  return cutoff;
}

export async function GET(req) {
  try {
    const cutoff = await purgeExpiredMessages();
    const url = new URL(req.url);
    const roomType = url.searchParams.get("roomType") || "global";
    const roomId = url.searchParams.get("roomId") || "main-lobby";
    const rawLimit = Number(url.searchParams.get("limit") || "50");
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), 200)
        : 50;

    const room = normalizeRoom(roomType, roomId);
    if (room.error) {
      return NextResponse.json({ error: room.error }, { status: 400 });
    }

    // Cache the tiny special-title map (key → name). It only changes when
    // an admin edits titles, so reading the full table on every chat GET is
    // wasteful. Returns a plain object so it survives the JSON cache;
    // converted back to a Map below. No-op → straight DB read when Redis is
    // unavailable.
    const specialTitleNameByObject = await cacheOrFetch(
      CacheKeys.specialTitles(),
      CacheTTL.specialTitles,
      async () => {
        const specialTitleRows = await db
          .select({ key: specialTitles.key, name: specialTitles.name })
          .from(specialTitles);
        return Object.fromEntries(
          specialTitleRows.map((row) => [row.key, row.name]),
        );
      },
    );
    const specialTitleNameByKey = new Map(
      Object.entries(specialTitleNameByObject || {}).map(([key, name]) => [
        key,
        name,
      ]),
    );

    const rows = await db
      .select({
        id: chatMessages.id,
        roomType: chatMessages.roomType,
        roomId: chatMessages.roomId,
        clerkId: chatMessages.clerkId,
        displayName: chatMessages.displayName,
        iconKey: chatMessages.iconKey,
        content: chatMessages.content,
        isDeleted: chatMessages.isDeleted,
        deletedAt: chatMessages.deletedAt,
        deletedByClerkId: chatMessages.deletedByClerkId,
        createdAt: chatMessages.createdAt,
        selectedTitle: users.selectedTitle,
        selectedSpecialTitle: users.selectedSpecialTitle,
        selectedStreakType: users.selectedStreakType,
        dailyStreakCurrent: users.dailyStreakCurrent,
        dailyStreakBest: users.dailyStreakBest,
        chatColor: users.chatColor,
        selectedGlow: users.selectedGlow,
        glowColor: glows.color,
        premiumStatus: tokenSubscriptions.status,
        planKey: tokenSubscriptions.planKey,
        xp: users.xp,
        prestigeLevel: users.prestigeLevel,
        showPrestigeBadge: users.showPrestigeBadge,
        equippedCosmetics: users.equippedCosmetics,
      })
      .from(chatMessages)
      .leftJoin(users, eq(chatMessages.clerkId, users.clerkId))
      .leftJoin(glows, eq(glows.key, users.selectedGlow))
      .leftJoin(
        tokenSubscriptions,
        and(
          eq(tokenSubscriptions.clerkId, chatMessages.clerkId),
          inArray(tokenSubscriptions.status, ACTIVE_SUBSCRIPTION_STATUSES),
        ),
      )
      .where(
        and(
          eq(chatMessages.roomType, room.roomType),
          eq(chatMessages.roomId, room.roomId),
          gte(chatMessages.createdAt, cutoff),
        ),
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit);

    // Batch-resolve every sender's equipped profile frame in one catalog
    // query (see src/lib/cosmetics.ts). Unknown/disabled keys drop out.
    const decorations = await getFrameDecorations(
      rows.map((row) => row.equippedCosmetics),
    );
    const decorationByClerkId = new Map(
      rows.map((row, index) => [row.clerkId, decorations[index]]),
    );

    // Batch-resolve every sender's equipped chat effect in one catalog query
    // (see src/lib/cosmetics.ts). Unknown/disabled keys drop out.
    const chatEffectByKey = await getCosmeticsByKeysForCategory(
      "chat_effect",
      rows.map((row) => pickEquippedKey(row.equippedCosmetics, "chat_effect")),
    );

    const messages = rows.reverse().map((msg) => {
      // Compute streak title for this message's user
      const streakTitle = computeEquippedStreakTitle({
        selectedStreakType: msg.selectedStreakType,
        dailyStreakCurrent: msg.dailyStreakCurrent,
        dailyStreakBest: msg.dailyStreakBest,
      }).title;

      const specialTitle = msg.selectedSpecialTitle
        ? specialTitleNameByKey.get(msg.selectedSpecialTitle)
        : null;

      const regularTitle = msg.selectedTitle;

      // Build equippedTitle: primary title only. An equipped Prestige badge
      // (resolved server-side — never client text) outranks special/regular
      // titles. Streak title stays a separate field for its own badge.
      const prestigeBadge = resolvePrestigeBadge({
        xp: msg.xp,
        prestigeLevel: msg.prestigeLevel,
        showPrestigeBadge: msg.showPrestigeBadge,
      });
      const primaryTitle = prestigeBadge || specialTitle || regularTitle || null;
      // Membership from the joined subscription row: ANY active subscription
      // is GRYND PRO (legacy plan keys included), so a paying member is never
      // silently downgraded. There are no tiers.
      const premium = Boolean(msg.planKey);

      // Remove extra fields we added for computation
      const {
        selectedStreakType,
        dailyStreakCurrent,
        dailyStreakBest,
        selectedGlow,
        glowColor,
        premiumStatus,
        planKey,
        xp,
        prestigeLevel,
        showPrestigeBadge,
        equippedCosmetics,
        ...cleanMsg
      } = msg;
      const chatEffectKey = pickEquippedKey(equippedCosmetics, "chat_effect");
      return {
        ...cleanMsg,
        profileFrame: decorationByClerkId.get(msg.clerkId) ?? null,
        chatEffect: chatEffectKey ? chatEffectByKey.get(chatEffectKey) || null : null,
        equippedTitle: primaryTitle,
        streakTitle: streakTitle || null,
        premium,
        tier: premium ? "pro" : null,
        premiumTitle: premium ? MEMBERSHIP_TITLE : null,
        // Name color precedence: an equipped battlepass glow (any member,
        // catalog hex) outranks the GRYND PRO free-form chat color. The custom
        // chat color stays a membership perk — only surfaced for members
        // (the column is only ever set through the premium-gated API, but
        // defense in depth: never leak it for non-members).
        chatColor: glowColor || (premium ? (msg.chatColor || null) : null),
      };
    });

    return NextResponse.json({ messages });
  } catch (error) {
    console.error("CHAT_MESSAGES_GET_ERROR", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    await purgeExpiredMessages();
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const room = normalizeRoom(body.roomType, body.roomId);
    if (room.error) {
      return NextResponse.json({ error: room.error }, { status: 400 });
    }

    // Sanitize before storing: strip control chars + normalize. React
    // escapes on render (there is no dangerouslySetInnerHTML in the
    // chat UI), this is defense-in-depth for any other consumer of
    // the stored content.
    const content = sanitizeString(body.content || "", { trim: true });
    if (!content) {
      return NextResponse.json(
        { error: "Message cannot be empty." },
        { status: 400 },
      );
    }

    if (content.length > 500) {
      return NextResponse.json({ error: "Message too long." }, { status: 400 });
    }

    const [appUser] = await db
      .select({
        name: users.name,
        selectedIcon: users.selectedIcon,
        selectedTitle: users.selectedTitle,
        selectedSpecialTitle: users.selectedSpecialTitle,
        selectedStreakType: users.selectedStreakType,
        dailyStreakCurrent: users.dailyStreakCurrent,
        dailyStreakBest: users.dailyStreakBest,
        chatColor: users.chatColor,
        selectedGlow: users.selectedGlow,
        glowColor: glows.color,
        balance: users.balance,
        xp: users.xp,
        prestigeLevel: users.prestigeLevel,
        showPrestigeBadge: users.showPrestigeBadge,
        equippedCosmetics: users.equippedCosmetics,
      })
      .from(users)
      .leftJoin(glows, eq(glows.key, users.selectedGlow))
      .where(eq(users.clerkId, userId))
      .limit(1);

    const premium = await isPremiumMember(userId);
    const displayName = appUser?.name?.trim() || "Player";
    // Official Grynd icon only. A malformed/legacy value can never reach a
    // live <img> — fall back to the official default key.
    const iconKey =
      appUser?.selectedIcon && /^[a-z0-9][a-z0-9._-]{0,119}$/.test(appUser.selectedIcon)
        ? appUser.selectedIcon
        : "default";
    const selectedTitle = appUser?.selectedTitle || null;
    const selectedSpecialTitle = appUser?.selectedSpecialTitle || null;
    const [specialTitleRow] = selectedSpecialTitle
      ? await db
          .select({ name: specialTitles.name })
          .from(specialTitles)
          .where(eq(specialTitles.key, selectedSpecialTitle))
          .limit(1)
      : [];

    // Compute streak title
    const streakTitle = computeEquippedStreakTitle({
      selectedStreakType: appUser?.selectedStreakType,
      dailyStreakCurrent: appUser?.dailyStreakCurrent,
      dailyStreakBest: appUser?.dailyStreakBest,
    }).title;

    // An equipped Prestige badge (resolved server-side) outranks the
    // special / regular titles; streak title stays separate.
    const prestigeBadge = resolvePrestigeBadge({
      xp: appUser?.xp,
      prestigeLevel: appUser?.prestigeLevel,
      showPrestigeBadge: appUser?.showPrestigeBadge,
    });
    const primaryTitle = prestigeBadge || specialTitleRow?.name || selectedTitle;
    // Streak title is separate — primary title goes into equippedTitle
    const equippedTitle = primaryTitle;

    // Sender's equipped profile frame — attached so the live socket message
    // and the optimistic/refetched feed render the same ring as history.
    const [profileFrame] = await getFrameDecorations([appUser?.equippedCosmetics]);
    // Sender's equipped chat effect — same live/history parity as the frame.
    const chatEffect = await resolveEquippedCosmetic("chat_effect", appUser?.equippedCosmetics);

    const inserted = await db
      .insert(chatMessages)
      .values({
        roomType: room.roomType,
        roomId: room.roomId,
        clerkId: userId,
        displayName,
        iconKey,
        content,
      })
      .returning();

    const unlockedSpecialTitles = await checkUnlocks(userId, "chat_message", {
      message: content,
      balanceAfter: Number(appUser?.balance || 0),
    });

    return NextResponse.json(
      {
        message: {
          ...inserted[0],
          profileFrame,
          chatEffect,
          selectedTitle,
          selectedSpecialTitle,
          equippedTitle,
          streakTitle,
          premium,
          tier: premium ? "pro" : null,
          premiumTitle: premium ? MEMBERSHIP_TITLE : null,
          // Glow outranks the free-form membership chat color (see GET).
          chatColor:
            appUser?.glowColor || (premium ? (appUser?.chatColor || null) : null),
        },
        unlockedSpecialTitles,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("CHAT_MESSAGES_POST_ERROR", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
