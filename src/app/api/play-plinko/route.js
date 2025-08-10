import { auth } from '@clerk/nextjs/server';
import { db } from '../../../db/client';
import { users } from '../../../db/schema';
import { eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';

export async function POST(req) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { betAmount, riskLevel } = await req.json();
    if (typeof betAmount !== 'number' || betAmount <= 0) {
      return NextResponse.json({ error: 'Invalid bet amount' }, { status: 400 });
    }

    // Validate riskLevel or fallback to medium
    const allowedRisks = ['low', 'medium', 'high'];
    const risk = allowedRisks.includes(riskLevel) ? riskLevel : 'medium';

    // Get current user data
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .limit(1);

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Verify sufficient balance
    if (user.balance < betAmount) {
      return NextResponse.json(
        { error: 'Insufficient balance' },
        { status: 400 }
      );
    }

    // Calculate game result with perfect slot alignment
    const { path, multiplier, finalPosition } = calculatePlinkoResult(risk);
    const winAmount = parseFloat((betAmount * multiplier).toFixed(2));
    const newBalance = parseFloat(user.balance) - betAmount + winAmount;

    // Update balance in single transaction
    await db
      .update(users)
      .set({ 
        balance: sql`${users.balance} - ${betAmount} + ${winAmount}`
      })
      .where(eq(users.clerkId, clerkId));

    return NextResponse.json({
      success: true,
      data: {
        path,
        winAmount,
        multiplier,
        newBalance,
        finalPosition // Crucial for frontend alignment
      }
    });

  } catch (error) {
    console.error('Plinko error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Game error' },
      { status: 500 }
    );
  }
}

function calculatePlinkoResult(riskLevel) {
  const lowRiskMultipliers = [
  5, 3, 2, 1.5, 1.2, 1, 1, 1, 0.5, 0.3, 0.5, 1, 1, 1, 1.2, 1.5, 2, 3, 5,
];

const mediumRiskMultipliers = [
  10, 5, 3, 2, 1.5, 1.2, 1, 0.6, 0.4, 0.2, 0.4, 0.6, 1, 1.2, 1.5, 2, 3, 5, 10,
];

const highRiskMultipliers = [
  50, 25, 10, 5, 3, 1, 0.8, 0.5, 0.2, 0, 0.2, 0.5, 0.8, 1, 3, 5, 10, 25, 50,
];

  const multipliersByRisk = {
    low: lowRiskMultipliers,
    medium: mediumRiskMultipliers,
    high: highRiskMultipliers,
  };

  const multipliers = multipliersByRisk[riskLevel] || mediumRiskMultipliers;

  const slotWidth = 500 / multipliers.length;
  const path = [];
  const rows = 18;

  let x = 250; // Center
  let y = 30;
  path.push({ x, y });

  for (let row = 0; row < rows; row++) {
    const randomFactor = Math.random() * 0.7 + 0.3; // 0.3-1.0 range
    const dir = Math.random() < 0.5 ? -1 : 1;
    const bounceAmount = 12 * randomFactor;

    x += dir * bounceAmount;
    y += 22;
    x = Math.max(10, Math.min(490, x)); // Keep in bounds
    path.push({ x, y });
  }

  const finalX = Math.max(0, Math.min(499, x));
  const slotIndex = Math.min(
    Math.floor(finalX / slotWidth),
    multipliers.length - 1
  );
  const multiplier = multipliers[slotIndex];

  return {
    path,
    multiplier,
    finalPosition: {
      x: (slotIndex * slotWidth) + (slotWidth / 2), // Center of slot
      y: 480,
    },
    slotIndex, // Crucial for frontend
  };
}
