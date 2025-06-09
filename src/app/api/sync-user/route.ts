import { auth } from '@clerk/nextjs/server';
import { sql } from '../../../db/client';
import { NextResponse } from 'next/server';
import { users } from '@clerk/clerk-sdk-node';

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
    const user = await users.getUser(clerkId);
    const firstName = user.firstName || '';
    const lastName = user.lastName || '';
    const emailAddresses = user.emailAddresses || [];
    const name = `${firstName} ${lastName}`.trim();
    const email =
      Array.isArray(emailAddresses) && emailAddresses.length > 0
        ? emailAddresses[0].emailAddress
        : '';

    console.log('✅ Clerk session verified:', { clerkId, name, email });

    // 3. Check if user exists in your DB
    const existingUser = await sql`
      SELECT * FROM users WHERE clerk_id = ${clerkId} LIMIT 1
    `;

    if (existingUser.length > 0) {
      return NextResponse.json(
        { message: 'User already exists' },
        { status: 200 }
      );
    }

    // OPTIONAL: Read password from request body if you're collecting one
    const body = await req.json();
    const password = body?.password;

    // 4. Optionally update user's password if a password is provided
    if (password) {
      try {
        await users.updateUser(clerkId, {
          password,
        });
        console.log('🔐 Password updated for user:', clerkId);
      } catch (err) {
        console.warn('⚠️ Failed to update password (may be OAuth-only user):', err);
        // We do not fail here — we proceed with DB insert
      }
    }

    // 5. Insert new user into your database
    const newUser = await sql`
      INSERT INTO users (clerk_id, name, email, balance)
      VALUES (${clerkId}, ${name}, ${email}, 1000.00)
      RETURNING *
    `;

    return NextResponse.json(
      {
        message: 'User synced successfully',
        user: newUser[0],
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
