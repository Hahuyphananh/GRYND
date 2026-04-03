import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../db/client';
import { chatMessages } from '../../../../db/schema';
import { parseAndValidateJson } from '../../../../lib/security/validation';
import { auditLog } from '../../../../lib/security/auditLog';

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
      auditLog('chat_moderation_unauthorized', { path: '/api/chat/moderate' });
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!isAdmin(userId)) {
      auditLog('chat_moderation_forbidden', { userId, path: '/api/chat/moderate' });
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const parsed = await parseAndValidateJson(req, {
      messageId: { type: 'number', required: true, integer: true, min: 1 },
    });

    if (!parsed.ok) return parsed.response;

    const messageId = parsed.data.messageId;

    await db
      .update(chatMessages)
      .set({
        isDeleted: true,
        deletedAt: new Date(),
        deletedByClerkId: userId,
      })
      .where(and(eq(chatMessages.id, messageId), isNull(chatMessages.deletedAt)));

    auditLog('chat_message_moderated', { userId, messageId, action: 'soft_delete' });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('CHAT_MODERATE_ERROR', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
