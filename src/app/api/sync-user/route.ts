import { auth } from '@clerk/nextjs/server';
import { db } from '../../../db/client'; // Your Drizzle DB client
import { users } from '../../../db/schema'; // Drizzle schema
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { users as clerkUsers } from '@clerk/clerk-sdk-node';

export async function POST(req: Request) {
  try {
    // 1. Authenticate user via Clerk
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json({ error: 'Unauthorized - No session' }, { status: 401 });
    }

    // 2. Get user details from Clerk
    const clerkUser = await clerkUsers.getUser(clerkId);
    const name = `${clerkUser.firstName || ''} ${clerkUser.lastName || ''}`.trim();
    const email =
      clerkUser.emailAddresses?.[0]?.emailAddress || 'unknown@example.com';

    // 3. Check if user exists in DB
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json({ message: 'User already exists' }, { status: 200 });
    }

    // 4. Try to get password from body (optional)
    const body = await req.json();
    let password = body?.password ?? 'oauth-placeholder';

    // Try to update password in Clerk (skip errors if OAuth user)
    if (body?.password) {
      try {
        await clerkUsers.updateUser(clerkId, { password });
        console.log('🔐 Password updated for Clerk user');
      } catch (err) {
        console.warn('⚠️ Could not update password (likely OAuth user)', err);
        password = 'oauth-placeholder'; // fallback
      }
    }

    // 5. Insert user into DB
    const inserted = await db
      .insert(users)
      .values({
        clerkId,
        name,
        email,
        password,
      })
      .returning();

    return NextResponse.json(
      {
        message: 'User synced successfully',
        user: inserted[0],
      },
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
