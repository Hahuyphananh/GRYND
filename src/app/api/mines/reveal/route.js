import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users, minesGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  createSignedSession,
  verifySignedSession,
} from "../../../../lib/serverSession";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );

    const { index } = await req.json();
    const tileIndex = Number(index);
    if (!Number.isInteger(tileIndex) || tileIndex < 0 || tileIndex > 24) {
      return NextResponse.json(
        { success: false, error: "Invalid tile index" },
        { status: 400 },
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

    if (session.revealed.includes(tileIndex)) {
      return NextResponse.json({
        success: true,
        data: {
          alreadyRevealed: true,
          mineHit: false,
          revealedCount: session.revealed.length,
        },
      });
    }

    const mineHit = session.minePositions.includes(tileIndex);

    if (mineHit) {
      const userData = await db
        .select()
        .from(users)
        .where(eq(users.clerkId, userId))
        .limit(1);
      if (userData.length) {
        const user = userData[0];
        await db.insert(minesGames).values({
          userId: user.id,
          betAmount: session.bet,
          payout: 0,
          result: "loss",
          tilesRevealed: session.revealed.length,
          minesCount: session.minesCount,
          status: "completed",
          createdAt: new Date(),
        });
      }

      const response = NextResponse.json({
        success: true,
        data: {
          mineHit: true,
          revealedCount: session.revealed.length,
          minePositions: session.minePositions,
        },
      });
      response.cookies.set("mines_session", "", {
        httpOnly: true,
        path: "/",
        maxAge: 0,
      });
      return response;
    }

    const nextSession = {
      ...session,
      revealed: [...session.revealed, tileIndex],
    };

    const response = NextResponse.json({
      success: true,
      data: {
        mineHit: false,
        revealedCount: nextSession.revealed.length,
      },
    });
    response.cookies.set("mines_session", createSignedSession(nextSession), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 30,
    });

    return response;
  } catch (error) {
    console.error("Error revealing mines tile:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
