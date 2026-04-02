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
    if (Number(user.balance) < betAmount) {
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
  20, 10, 6, 4, 2.5, 1.6, 1.2, 1, 0.7, 0.4,
  0.7, 1, 1.2, 1.6, 2.5, 4, 6, 10, 20
];

 const mediumRiskMultipliers = [
  120, 40, 15, 6, 3, 1.8, 1.1, 0.6, 0.3, 0.1,
  0.3, 0.6, 1.1, 1.8, 3, 6, 15, 40, 120
];

const highRiskMultipliers = [
  1000, 250, 80, 25, 8, 2.5, 1, 0.3, 0, 0,
  0, 0.3, 1, 2.5, 8, 25, 80, 250, 1000
];

  const multipliersByRisk = {
    low: lowRiskMultipliers,
    medium: mediumRiskMultipliers,
    high: highRiskMultipliers,
  };

  const multipliers = multipliersByRisk[riskLevel] || mediumRiskMultipliers;

  const rows = multipliers.length - 1; // 18
  const slotWidth = 500 / multipliers.length;

  // -----------------------------
  // 🎯 STEP 1: BINOMIAL SLOT PICK
  // -----------------------------
  let rightMoves = 0;
  for (let i = 0; i < rows; i++) {
    if (Math.random() < 0.5) rightMoves++;
  }

  const slotIndex = Math.min(
    Math.max(rightMoves, 0),
    multipliers.length - 1
  );

  const multiplier = multipliers[slotIndex];

  // -----------------------------
  // 🎢 STEP 2: GENERATE MATCHING PATH
  // -----------------------------
  const path = [];
  let x = 250;
  let y = 30;

  path.push({ x, y });

  let remainingRight = rightMoves;
  let remainingLeft = rows - rightMoves;

  for (let i = 0; i < rows; i++) {
    const goRight =
      remainingRight > 0 &&
      (remainingLeft === 0 || Math.random() < remainingRight / (remainingRight + remainingLeft));

    if (goRight) {
      x += 14;
      remainingRight--;
    } else {
      x -= 14;
      remainingLeft--;
    }

    y += 22;
    path.push({ x, y });
  }

  return {
    path,
    multiplier,
    finalPosition: {
      x: slotIndex * slotWidth + slotWidth / 2,
      y: 480,
    },
    slotIndex,
  };
}
