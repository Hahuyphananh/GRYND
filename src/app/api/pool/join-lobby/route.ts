import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { and, eq } from "drizzle-orm";
import { poolLobbies, poolMatches } from "../../../../db/schema";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json(
        { ok: false, message: "Unauthorized" },
        { status: 401 },
      );
    const { lobbyId } = await req.json();

    const joined = await db.transaction(async (tx) => {
      const [lobby] = await tx
        .select()
        .from(poolLobbies)
        .where(
          and(eq(poolLobbies.id, lobbyId), eq(poolLobbies.status, "waiting")),
        )
        .for("update")
        .limit(1);

      if (!lobby || lobby.hostUserId === userId) {
        throw new Error("Lobby unavailable");
      }

      const firstTurnUserId = Math.random() < 0.5 ? lobby.hostUserId : userId;
      const firstTurnSeat = firstTurnUserId === lobby.hostUserId ? 1 : 2;
      const [match] = await tx
        .insert(poolMatches)
        .values({
          id: crypto.randomUUID(),
          lobbyId,
          player1Id: lobby.hostUserId,
          player2Id: userId,
          wager: lobby.wager,
          status: "active",
          gameState: {
            started: true,
            turn: firstTurnSeat,
            version: Date.now(),
          },
          currentTurnUserId: firstTurnUserId,
        })
        .returning({ id: poolMatches.id });

      await tx
        .update(poolLobbies)
        .set({ status: "active", opponentUserId: userId })
        .where(eq(poolLobbies.id, lobbyId));

      return { matchId: match.id, firstTurnSeat };
    });

    return NextResponse.json({ ok: true, ...joined });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, message: error?.message || "Unable to join lobby" },
      { status: 500 },
    );
  }
}
