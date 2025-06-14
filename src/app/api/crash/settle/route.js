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

    let newBalance = parseFloat(userData[0].balance);
    const payout = gameWon ? betAmount * multiplier : 0;

    if (!gameWon) {
      newBalance -= betAmount;
    } else {
      newBalance += payout;
    }


if (immediateDeduct) {
  newBalance -= betAmount;
} else if (gameWon) {
  newBalance += betAmount * multiplier;
}

// After updating user balance
    await db
      .update(users)
      .set({ balance: newBalance }) // Ensure 'balance' exists in your users schema
      .where(eq(users.clerkId, userId));

// Record game in crashGames table
    await db.insert(crashGames).values({
      userId: users.id, // assuming `user` is fetched from DB earlier
      betAmount: betAmount.toFixed(2),
      cashedOutAt: gameWon ? multiplier.toFixed(2) : null,
      payout: gameWon ? (betAmount * multiplier).toFixed(2) : '0.00',
    });


    return NextResponse.json({
      success: true,
      data: { newBalance, payout },
    });
  } catch (err) {
    console.error('Crash API error:', err);
    return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 });
  }
}
