import { auth } from '@clerk/nextjs/server';
import { db } from '../../../db/client';
import { users } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { users as clerkUsers } from '@clerk/clerk-sdk-node';

export async function POST(req: Request) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json({ error: 'Unauthorized - No session' }, { status: 401 });
    }

    const clerkUser = await clerkUsers.getUser(clerkId);
    const name = `${clerkUser.firstName || ''} ${clerkUser.lastName || ''}`.trim();
    const email = clerkUser.emailAddresses?.[0]?.emailAddress || 'unknown@example.com';

    const existing = await db.select().from(users).where(eq(users.clerkId, clerkId)).limit(1);
    if (existing.length > 0) {
      return NextResponse.json({ message: 'User already exists' }, { status: 200 });
    }

    let password = 'oauth-placeholder';
    try {
      const body = await req.json();
      if (body?.password) {
        password = body.password;
        try {
          await clerkUsers.updateUser(clerkId, { password });
          console.log('🔐 Password updated for Clerk user');
        } catch (err) {
          console.warn('⚠️ Clerk password update failed:', err);
          password = 'oauth-placeholder';
        }
      }
    } catch (err) {
      console.warn('⚠️ Invalid JSON body:', err);
    }

    console.log('📥 Inserting user:', { clerkId, name, email, password });

    const inserted = await db.insert(users).values({
      clerkId,
      name,
      email,
      password,
    }).returning();

    return NextResponse.json(
      { message: 'User synced successfully', user: inserted[0] },
      { status: 201 }
    );
  } catch (error) {
    console.error('❌ Error in /api/sync-user:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
