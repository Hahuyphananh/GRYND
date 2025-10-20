import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../db/client';
import { users, crashGames } from '../../../../db/schema';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

export async function POST(req) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { betAmount, multiplier, gameWon, immediateDeduct } = await req.json();

    if (
      typeof betAmount !== 'number' ||
      typeof multiplier !== 'number' ||
      typeof gameWon !== 'boolean'
    ) {
      return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
    }

    const userData = await db.select().from(users).where(eq(users.clerkId, userId)).limit(1);

    if (!userData.length) {
      return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 });
    }

    const user = userData[0];
    let newBalance = parseFloat(user.balance);
    const payout = gameWon ? betAmount * multiplier : 0;

    // Balance logic
    if (immediateDeduct) {
      newBalance -= betAmount;
    } else if (gameWon) {
      newBalance += payout;
    } else {
      newBalance -= betAmount;
    }

    await db.update(users).set({ balance: newBalance }).where(eq(users.clerkId, userId));

    // ✅ Only insert when the game has finished, not when just deducting the bet
    if (!immediateDeduct) {
      await db.insert(crashGames).values({
        userId: user.id,
        betAmount: betAmount.toFixed(2),
        cashedOutAt: gameWon ? multiplier.toFixed(2) : null,
        payout: payout.toFixed(2),
        result: gameWon ? 'won' : 'lost',
        status: 'completed',
      });
    }

    return NextResponse.json({
      success: true,
      data: { newBalance, payout },
    });
  } catch (err) {
    console.error('Crash API error:', err);
    return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 });
  }
}
