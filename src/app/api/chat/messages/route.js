import { NextResponse } from "next/server";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { chatMessages, specialTitles, users } from "../../../../db/schema";
import { checkUnlocks } from "../../../../lib/specialTitles";

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

    const specialTitleRows = await db
      .select({ key: specialTitles.key, name: specialTitles.name })
      .from(specialTitles);
    const specialTitleNameByKey = new Map(
      specialTitleRows.map((row) => [row.key, row.name]),
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
      })
      .from(chatMessages)
      .leftJoin(users, eq(chatMessages.clerkId, users.clerkId))
      .where(
        and(
          eq(chatMessages.roomType, room.roomType),
          eq(chatMessages.roomId, room.roomId),
          gte(chatMessages.createdAt, cutoff),
        ),
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit);

    const messages = rows.reverse().map((msg) => ({
      ...msg,
      equippedTitle:
        (msg.selectedSpecialTitle
          ? specialTitleNameByKey.get(msg.selectedSpecialTitle)
          : null) ||
        msg.selectedTitle ||
        null,
    }));

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

    const content = (body.content || "").trim();
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
        balance: users.balance,
      })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

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
    const equippedTitle = specialTitleRow?.name || selectedTitle;

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
