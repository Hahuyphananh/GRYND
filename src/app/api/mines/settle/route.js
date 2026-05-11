import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users, minesGames } from "../../../../db/schema"; // ✅ added minesGames
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { verifySignedSession } from "../../../../lib/serverSession";
import { getMinesMultiplier } from "../../../../lib/minesMath";

function calculateMultiplier(mines, revealed) {
  return getMinesMultiplier(mines, revealed);
}

export async function POST(req) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const token = req.cookies.get("mines_session")?.value;
    const session = verifySignedSession(token);
    if (!session || session.userId !== userId) {
      return NextResponse.json(
        { success: false, error: "No active mines session" },
        { status: 400 },
      );
    }

    const userData = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    if (userData.length === 0) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 },
      );
    }

    const user = userData[0];
    const revealedCount = Number(session.revealed?.length || 0);
    const mines = Number(session.minesCount);
    const betAmount = Number(session.bet);
    const multiplier = calculateMultiplier(mines, revealedCount);
    const payout = Number((betAmount * multiplier).toFixed(2));
    // Update user balance atomically
    const [credited] = await db
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout}` })
      .where(eq(users.clerkId, userId))
      .returning({ balance: users.balance });

    // ✅ Record Mines game result
    await db.insert(minesGames).values({
      userId: user.id,
      betAmount,
      payout,
      result: "win",
      tilesRevealed: revealedCount,
      minesCount: mines,
      status: "completed",
      createdAt: new Date(),
    });

    const response = NextResponse.json({
      success: true,
      data: {
        newBalance: Number(credited?.balance ?? user.balance),
        result: "win",
        payout,
      },
    });
    response.cookies.set("mines_session", "", {
      httpOnly: true,
      path: "/",
      maxAge: 0,
    });
    return response;
  } catch (err) {
    console.error("Error in /api/mines/settle:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
