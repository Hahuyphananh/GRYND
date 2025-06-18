import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../db/client';
import { users } from '../../../../db/schema';
import { eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { bet } = await req.json();
    if (typeof bet !== 'number' || bet <= 0) {
      return NextResponse.json({ error: 'Invalid bet amount' }, { status: 400 });
    }

    // Deduct bet
    const [user] = await db
      .update(users)
      .set({ balance: sql`balance - ${bet}` })
      .where(eq(users.clerkId, userId))
      .returning();

    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const fruitIcons = [
  "🍉", "🍌", "🍍", "🍏", "🍓", "🥭", "🍈", "🍇", "🍒", "🍎",
  "🍊", "🍋", "🥝", "🍐", "🍑", "🥥", "🍅", "🍆", "🌽", "🍠"
];

    // Generate spin
    const reels = Array.from({ length: 5 }, () =>
      Array.from({ length: 3 }, () => fruitIcons[Math.floor(Math.random() * fruitIcons.length)])
    );
    const flat = reels.flat();
    const counts = flat.reduce((acc, f) => (acc[f] = (acc[f] || 0) + 1, acc), {});
    const maxCount = Math.max(...Object.values(counts));
    let winAmount = 0;

    if (maxCount >= 5) winAmount = bet * 5;
    else if (maxCount >= 3) winAmount = bet * 2;

    // Add win, if any
    await db
      .update(users)
      .set({ balance: sql`balance + ${winAmount}` })
      .where(eq(users.clerkId, userId));

    const newBalance = parseFloat(user.balance) - bet + winAmount;

    return NextResponse.json({
      success: true,
      data: { reels, winAmount, newBalance },
    });
  } catch (err) {
    console.error('Slots play error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
