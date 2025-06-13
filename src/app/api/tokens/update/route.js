import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../db/client';
import { users } from '../../../../db/schema';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

export async function POST(req) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const body = await req.json();
    const amount = body.amount;

    if (typeof amount !== 'number' || isNaN(amount)) {
      return NextResponse.json(
        { success: false, error: 'Le montant est requis et doit être un nombre' },
        { status: 400 }
      );
    }

    const userData = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    if (userData.length === 0) {
      return NextResponse.json(
        { success: false, error: 'User not found' },
        { status: 404 }
      );
    }

    const user = userData[0];
    const newBalance = parseFloat(user.balance) + amount;

    // ✅ CORRECTION : pas besoin de crochets
    await db
      .update(users)
      .set({ balance: newBalance })
      .where(eq(users.clerkId, userId));

    return NextResponse.json(
      {
        success: true,
        data: { balance: newBalance }
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Erreur dans /api/tokens/update:", err);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
