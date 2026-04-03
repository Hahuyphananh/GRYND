import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { listAbuseMetrics } from '../../../../lib/security/abuseMetrics';

function isAdmin(userId: string) {
  const admins = (process.env.CHAT_ADMIN_CLERK_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return admins.includes(userId);
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  if (!isAdmin(userId)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });

  const metrics = listAbuseMetrics();
  return NextResponse.json({ success: true, metrics }, { status: 200 });
}
