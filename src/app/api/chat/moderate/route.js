import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../db/client';
import { chatMessages } from '../../../../db/schema';

function isAdmin(userId) {
  const list = (process.env.CHAT_ADMIN_CLERK_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  return list.includes(userId);
}

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!isAdmin(userId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json();
    const messageId = Number(body.messageId);

    if (!Number.isInteger(messageId) || messageId <= 0) {
      return NextResponse.json({ error: 'Invalid messageId.' }, { status: 400 });
    }

    await db
      .update(chatMessages)
      .set({
        isDeleted: true,
        deletedAt: new Date(),
        deletedByClerkId: userId,
      })
      .where(and(eq(chatMessages.id, messageId), isNull(chatMessages.deletedAt)));

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('CHAT_MODERATE_ERROR', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
