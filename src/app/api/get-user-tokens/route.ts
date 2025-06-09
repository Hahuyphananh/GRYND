import { auth } from '@clerk/nextjs/server';
import { db } from '../../../db/client'; // adjust path as needed
import { userTokens } from '../../../db/schema'; // assumes your table is named `userTokens`
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    // Authenticate via Clerk
    const { userId: clerkId } = await auth();

    if (!clerkId) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch user tokens from the DB
    const tokens = await db
      .select()
      .from(userTokens)
      .where(eq(userTokens.clerkId, clerkId)) // assumes your schema has clerkId as FK
      .limit(1);

    if (tokens.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'Aucun token trouvé',
          shouldInitialize: true,
        },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { success: true, data: tokens[0] },
      { status: 200 }
    );
  } catch (error) {
    console.error('❌ Erreur dans get-user-tokens:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Erreur serveur',
        details: error instanceof Error ? error.message : 'Unknown',
      },
      { status: 500 }
    );
  }
}
