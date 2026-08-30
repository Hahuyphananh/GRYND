import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { chatMessages, specialTitles, tokenSubscriptions, users } from "../../../../db/schema";
import { checkUnlocks } from "../../../../lib/specialTitles";
import { computeEquippedStreakTitle } from "../../../../lib/streakTitles";
import { sanitizeString } from "../../../../lib/security/validation";
import { cacheOrFetch } from "../../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../../lib/redis/keys";
import { ACTIVE_SUBSCRIPTION_STATUSES, isPremiumMember } from "../../../../lib/stripe/subscriptions";

// Membership title shown next to members' names in chat.
const MEMBERSHIP_TITLE = "GRYND+ Elite";

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
        profileImageUrl: chatMessages.profileImageUrl,
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
        premiumStatus: tokenSubscriptions.status,
      })
      .from(chatMessages)
      .leftJoin(users, eq(chatMessages.clerkId, users.clerkId))
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

      // Build equippedTitle: primary title only (special or regular title)
      // Streak title is returned as a separate field for its own badge
      const primaryTitle = specialTitle || regularTitle || null;
      const premium = Boolean(msg.premiumStatus);

      // Remove extra fields we added for computation
      const {
        selectedStreakType,
        dailyStreakCurrent,
        dailyStreakBest,
        premiumStatus,
        ...cleanMsg
      } = msg;
      return {
        ...cleanMsg,
        equippedTitle: primaryTitle,
        streakTitle: streakTitle || null,
        premium,
        premiumTitle: premium ? MEMBERSHIP_TITLE : null,
        // Custom chat color is a membership perk — only surface it for members
        // (the column is only ever set through the premium-gated API, but
        // defense in depth: never leak it for non-members).
        chatColor: premium ? (msg.chatColor || null) : null,
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
        profilePicture: users.profilePicture,
        selectedTitle: users.selectedTitle,
        selectedSpecialTitle: users.selectedSpecialTitle,
        selectedStreakType: users.selectedStreakType,
        dailyStreakCurrent: users.dailyStreakCurrent,
        dailyStreakBest: users.dailyStreakBest,
        chatColor: users.chatColor,
        balance: users.balance,
      })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    const premium = await isPremiumMember(userId);
    const displayName = appUser?.name?.trim() || "Player";
    const profileImageUrl = appUser?.profilePicture || null;
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

    const primaryTitle = specialTitleRow?.name || selectedTitle;
    // Streak title is separate — primary title goes into equippedTitle
    const equippedTitle = primaryTitle;

    const inserted = await db
      .insert(chatMessages)
      .values({
        roomType: room.roomType,
        roomId: room.roomId,
        clerkId: userId,
        displayName,
        profileImageUrl,
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
          selectedTitle,
          selectedSpecialTitle,
          equippedTitle,
          streakTitle,
          premium,
          premiumTitle: premium ? MEMBERSHIP_TITLE : null,
          chatColor: premium ? (appUser?.chatColor || null) : null,
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
