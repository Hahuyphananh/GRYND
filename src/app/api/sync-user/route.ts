import { auth } from '@clerk/nextjs/server';
import { db } from '../../../db/client'; // Drizzle DB client
import { users } from '../../../db/schema'; // Your Drizzle schema for the users table
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { users as clerkUsers } from '@clerk/clerk-sdk-node';

export async function POST(req: Request) {
  try {
    // 1. Authenticate user via Clerk session
    const { userId: clerkId } = await auth();

    if (!clerkId) {
      return NextResponse.json(
        { error: 'Unauthorized - No active session' },
        { status: 401 }
      );
    }

    // 2. Fetch user from Clerk
    const user = await clerkUsers.getUser(clerkId);
    const firstName = user.firstName || '';
    const lastName = user.lastName || '';
    const emailAddresses = user.emailAddresses || [];
    const name = `${firstName} ${lastName}`.trim();
    const email =
      Array.isArray(emailAddresses) && emailAddresses.length > 0
        ? emailAddresses[0].emailAddress
        : '';

    console.log('✅ Clerk session verified:', { clerkId, name, email });

    // 3. Check if user exists in DB
    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .limit(1);

    if (existingUser.length > 0) {
      return NextResponse.json(
        { message: 'User already exists' },
        { status: 200 }
      );
    }

    // 4. Optionally read password from body (not mandatory)
    const body = await req.json();
    const password = body?.password;

    if (password) {
      try {
        await clerkUsers.updateUser(clerkId, {
          password,
        });
        console.log('🔐 Password updated for user:', clerkId);
      } catch (err) {
        console.warn('⚠️ Failed to update password (likely OAuth-only user):', err);
      }
    }

    // 5. Insert new user into DB
    const inserted = await db
      .insert(users)
      .values({
        clerkId,
        name,
        email,
        balance: 1000.0,
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
    console.error('❌ Error in user sync:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
