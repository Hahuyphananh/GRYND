import { auth } from '@clerk/nextjs/server';
import { db } from '../../../db/client';
import { users } from '../../../db/schema'; // Import your users schema instead
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    // Authenticate via Clerk
    const { userId: clerkId } = await auth();

    if (!clerkId) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' }, 
        { status: 401 }
      );
    }

    // Fetch user data including balance (tokens) from users table
    const userData = await db
      .select({
        balance: users.balance, // Select just the balance field
        // Add other fields you need:
        name: users.name,
        email: users.email
      })
      .from(users)
      .where(eq(users.clerkId, clerkId)) // Match your column name
      .limit(1);

    if (userData.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'User not found',
          shouldInitialize: true,
        },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { 
        success: true, 
        data: {
          tokens: userData[0].balance, // Return balance as tokens
          user: {
            name: userData[0].name,
            email: userData[0].email
          }
        }
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('❌ Error in get-user-tokens:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Server error',
        details: error instanceof Error ? error.message : 'Unknown',
      },
      { status: 500 }
    );
  }
}