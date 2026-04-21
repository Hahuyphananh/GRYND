import { NextResponse } from 'next/server';
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../db/client';
import { chatMessages, users } from '../../../../db/schema';

const ALLOWED_ROOM_TYPES = new Set(['global', 'game']);
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeRoom(roomType, roomId) {
  if (!ALLOWED_ROOM_TYPES.has(roomType)) {
    return { error: 'Invalid roomType.' };
  }

  const safeRoomId = (roomId || '').trim();
  if (!safeRoomId || safeRoomId.length > 255) {
    return { error: 'Invalid roomId.' };
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
    const roomType = url.searchParams.get('roomType') || 'global';
    const roomId = url.searchParams.get('roomId') || 'main-lobby';
    const rawLimit = Number(url.searchParams.get('limit') || '50');
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50;

    const room = normalizeRoom(roomType, roomId);
    if (room.error) {
      return NextResponse.json({ error: room.error }, { status: 400 });
    }

    const rows = await db
      .select()
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.roomType, room.roomType),
          eq(chatMessages.roomId, room.roomId),
          gte(chatMessages.createdAt, cutoff),
        ),
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit);

    const messages = rows.reverse();

    return NextResponse.json({ messages });
  } catch (error) {
    console.error('CHAT_MESSAGES_GET_ERROR', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    await purgeExpiredMessages();
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const room = normalizeRoom(body.roomType, body.roomId);
    if (room.error) {
      return NextResponse.json({ error: room.error }, { status: 400 });
    }

    const content = (body.content || '').trim();
    if (!content) {
      return NextResponse.json({ error: 'Message cannot be empty.' }, { status: 400 });
    }

    if (content.length > 500) {
      return NextResponse.json({ error: 'Message too long.' }, { status: 400 });
    }

    const [appUser] = await db
      .select({ name: users.name, profilePicture: users.profilePicture })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    const displayName = appUser?.name?.trim() || 'Player';
    const profileImageUrl = appUser?.profilePicture || null;

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

    return NextResponse.json({ message: inserted[0] }, { status: 201 });
  } catch (error) {
    console.error('CHAT_MESSAGES_POST_ERROR', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
