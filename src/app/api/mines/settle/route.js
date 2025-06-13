import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../db/client';
import { users } from '../../../../db/schema';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

const multiplierTable = {
  1: {1:1.03,2:1.08,3:1.12,4:1.18,5:1.24,6:1.30,7:1.37,8:1.46,9:1.55,10:1.65,11:1.77,12:1.90,13:2.06,14:2.25,15:2.47,16:2.75,17:3.09,18:3.54,19:4.12,20:4.95,21:6.19,22:8.25,23:12.37,24:24.75},
  2: {1:1.08,2:1.17,3:1.29,4:1.41,5:1.56,6:1.74,7:1.94,8:2.18,9:2.47,10:2.83,11:3.26,12:3.81,13:4.50,14:5.40,15:6.60,16:8.25,17:10.61,18:14.14,19:19.80,20:29.70,21:49.50,22:99,23:297},
  3: {1:1.12,2:1.29,3:1.48,4:1.71,5:2.00,6:2.35,7:2.79,8:3.35,9:4.07,10:5.00,11:6.26,12:7.96,13:10.35,14:13.80,15:18.97,16:27.11,17:40.66,18:65.06,19:113.85,20:227.70,21:569.25,22:2277},
  4: {1:1.18,2:1.41,3:1.71,4:2.09,5:2.58,6:3.23,7:4.09,8:5.26,9:6.88,10:9.17,11:12.51,12:17.52,13:25.30,14:37.95,15:59.64,16:99.39,17:178.91,18:357.81,19:834.90,20:2504.70,21:12523.50},
  5: {1:1.24,2:1.56,3:2.00,4:2.58,5:3.39,6:4.52,7:6.14,8:8.50,9:12.04,10:17.52,11:26.27,12:40.87,13:66.41,14:113.85,15:208.72,16:417.45,17:939.26,18:2504.70,19:8766.45,20:52598.70}
  // Add more levels if needed
};

function calculateMultiplier(mines, revealed) {
  return multiplierTable[mines]?.[revealed] ?? 1;
}

export async function POST(req) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { betAmount, mines, revealedCount, gameWon } = body;

    if (
      typeof betAmount !== 'number' ||
      typeof mines !== 'number' ||
      typeof revealedCount !== 'number' ||
      typeof gameWon !== 'boolean'
    ) {
      return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
    }

    const userData = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    if (userData.length === 0) {
      return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 });
    }

    const user = userData[0];
    let newBalance = parseFloat(user.balance);

    if (gameWon) {
      const multiplier = calculateMultiplier(mines, revealedCount);
      const payout = betAmount * multiplier;
      newBalance += payout;
    } else {
      newBalance -= betAmount;
    }

    // Update user balance
    await db
      .update(users)
      .set({ balance: newBalance })
      .where(eq(users.clerkId, userId));

    return NextResponse.json({
      success: true,
      data: {
        newBalance: newBalance,
        result: gameWon ? 'win' : 'loss',
        payout: gameWon ? betAmount * calculateMultiplier(mines, revealedCount) : 0
      }
    });
  } catch (err) {
    console.error("Error in /api/mines/settle:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
