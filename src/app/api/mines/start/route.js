import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../db/client';
import { users } from '../../../../db/schema';
import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { createSignedSession } from '../../../../lib/serverSession';

function generateBoard(totalMines) {
  const all = Array.from({ length: 25 }, (_, i) => i);
  const mines = [];
  while (mines.length < totalMines) {
    const idx = Math.floor(Math.random() * all.length);
    mines.push(all[idx]);
    all.splice(idx, 1);
  }
  return mines;
}

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const { betAmount, mines } = await req.json();
    const bet = Number(betAmount);
    const minesCount = Number(mines);

    if (!Number.isFinite(bet) || bet <= 0 || !Number.isInteger(minesCount) || minesCount < 1 || minesCount > 24) {
      return NextResponse.json({ success: false, error: 'Invalid params' }, { status: 400 });
    }

    const [updated] = await db
      .update(users)
      .set({ balance: sql`${users.balance} - ${bet}` })
      .where(sql`${users.clerkId} = ${userId} AND ${users.balance} >= ${bet}`)
      .returning({ balance: users.balance });

    if (!updated) {
      return NextResponse.json({ success: false, error: 'Insufficient balance' }, { status: 400 });
    }

    const session = {
      userId,
      bet,
      minesCount,
      minePositions: generateBoard(minesCount),
      revealed: [],
      createdAt: Date.now(),
    };

    const token = createSignedSession(session);
    const response = NextResponse.json({ success: true, data: { newBalance: Number(updated.balance) } });
    response.cookies.set('mines_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 30,
    });

    return response;
  } catch (error) {
    console.error('Error starting mines game:', error);
    return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 });
  }
}
