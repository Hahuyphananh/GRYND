import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { auth, currentUser } from '@clerk/nextjs/server';
import { db } from '../../../../db/client';
import { chatMessages } from '../../../../db/schema';

const ALLOWED_ROOM_TYPES = new Set(['global', 'game']);

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

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const roomType = url.searchParams.get('roomType') || 'global';
    const roomId = url.searchParams.get('roomId') || 'main-lobby';
    const limit = Math.min(Number(url.searchParams.get('limit') || '50'), 200);

    const room = normalizeRoom(roomType, roomId);
    if (room.error) {
      return NextResponse.json({ error: room.error }, { status: 400 });
    }

    const rows = await db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.roomType, room.roomType), eq(chatMessages.roomId, room.roomId)))
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

    const user = await currentUser();
    const displayName =
      user?.username ||
      [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() ||
      user?.primaryEmailAddress?.emailAddress ||
      'Player';

    const inserted = await db
      .insert(chatMessages)
      .values({
        roomType: room.roomType,
        roomId: room.roomId,
        clerkId: userId,
        displayName,
        content,
      })
      .returning();

    return NextResponse.json({ message: inserted[0] }, { status: 201 });
  } catch (error) {
    console.error('CHAT_MESSAGES_POST_ERROR', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
