import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../db/client';
import { users, crashGames } from '../../../../db/schema';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { createSignedSession, verifySignedSession } from '../../../../lib/serverSession';

export async function POST(req) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { betAmount, multiplier, immediateDeduct } = await req.json();

    if (!Number.isFinite(betAmount) || betAmount <= 0 || !Number.isFinite(multiplier) || multiplier < 0) {
      return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
    }

    const userData = await db.select().from(users).where(eq(users.clerkId, userId)).limit(1);

    if (!userData.length) {
      return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 });
    }

    const user = userData[0];

    // 1) Place bet: reserve funds and create signed server session
    if (immediateDeduct) {
      const currentBalance = Number(user.balance);
      if (currentBalance < betAmount) {
        return NextResponse.json({ success: false, error: 'Insufficient balance' }, { status: 400 });
      }

      const newBalance = currentBalance - betAmount;
      await db.update(users).set({ balance: newBalance }).where(eq(users.clerkId, userId));

      const crashPoint = Number((Math.random() * 8 + 1.2).toFixed(2));
      const token = createSignedSession({
        userId,
        betAmount: Number(betAmount.toFixed(2)),
        crashPoint,
        createdAt: Date.now(),
      });

      const response = NextResponse.json({
        success: true,
        data: { newBalance, payout: 0 },
      });
      response.cookies.set('crash_session', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 10,
      });
      return response;
    }

    // 2) Settle: use only signed server session as source of truth
    const token = req.cookies.get('crash_session')?.value;
    const session = verifySignedSession(token);

    if (!session || session.userId !== userId) {
      return NextResponse.json({ success: false, error: 'No active crash session' }, { status: 400 });
    }

    const bet = Number(session.betAmount);
    const crashPoint = Number(session.crashPoint);

    // multiplier sent by client is treated as cashout attempt only
    const attemptedCashout = Number(multiplier);
    const won = attemptedCashout >= 1 && attemptedCashout <= crashPoint;
    const payout = won ? Number((bet * attemptedCashout).toFixed(2)) : 0;

    const newBalance = Number(user.balance) + payout;
    await db.update(users).set({ balance: newBalance }).where(eq(users.clerkId, userId));

    await db.insert(crashGames).values({
      userId: user.id,
      betAmount: bet.toFixed(2),
      cashedOutAt: won ? attemptedCashout.toFixed(2) : null,
      payout: payout.toFixed(2),
      result: won ? 'won' : 'lost',
      status: 'completed',
    });

    const response = NextResponse.json({
      success: true,
      data: { newBalance, payout, crashPoint, result: won ? 'won' : 'lost' },
    });
    response.cookies.set('crash_session', '', { httpOnly: true, path: '/', maxAge: 0 });
    return response;
  } catch (err) {
    console.error('Crash API error:', err);
    return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 });
  }
}
