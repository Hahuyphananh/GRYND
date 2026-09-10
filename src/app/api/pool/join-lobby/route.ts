import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { and, eq, ne, sql } from "drizzle-orm";
import { poolLobbies, poolMatches, users } from "../../../../db/schema";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json(
        { ok: false, message: "Unauthorized" },
        { status: 401 },
      );

    const { lobbyId } = await req.json().catch(() => ({}));
    if (!lobbyId || !UUID_RE.test(String(lobbyId))) {
      return NextResponse.json(
        { ok: false, message: "Invalid lobby" },
        { status: 400 },
      );
    }

    const [claimedLobby] = await db
      .update(poolLobbies)
      .set({ status: "active", opponentUserId: userId })
      .where(
        and(
          eq(poolLobbies.id, lobbyId),
          eq(poolLobbies.status, "waiting"),
          ne(poolLobbies.hostUserId, userId),
        ),
      )
      .returning({
        id: poolLobbies.id,
        hostUserId: poolLobbies.hostUserId,
        wager: poolLobbies.wager,
      });

    if (!claimedLobby) {
      const [existingMatch] = await db
        .select({ id: poolMatches.id, gameState: poolMatches.gameState })
        .from(poolMatches)
        .where(eq(poolMatches.lobbyId, lobbyId))
        .limit(1);

      if (existingMatch) {
        const state = existingMatch.gameState as { turn?: 1 | 2 } | null;
        return NextResponse.json({
          ok: true,
          matchId: existingMatch.id,
          firstTurnSeat: state?.turn ?? 1,
        });
      }

      return NextResponse.json(
        { ok: false, message: "Lobby unavailable" },
        { status: 400 },
      );
    }

    const wager = claimedLobby.wager;
    const hostUserId = claimedLobby.hostUserId;

    const result = await db.transaction(async (tx) => {
      const [hostRow] = await tx
        .select({ balance: users.balance })
        .from(users)
        .where(eq(users.clerkId, hostUserId))
        .for("update")
        .limit(1);

      const [joinerRow] = await tx
        .select({ balance: users.balance })
        .from(users)
        .where(eq(users.clerkId, userId))
        .for("update")
        .limit(1);

      if (!hostRow) {
        return { ok: false as const, error: "Host user not found", status: 500 as const };
      }
      if (!joinerRow) {
        return { ok: false as const, error: "User not found", status: 400 as const };
      }
      if (Number(hostRow.balance) < wager) {
        return { ok: false as const, error: "Insufficient balance", status: 400 as const };
      }
      if (Number(joinerRow.balance) < wager) {
        return { ok: false as const, error: "Insufficient balance", status: 400 as const };
      }

      await tx
        .update(users)
        .set({ balance: sql`${users.balance} - ${wager}` })
        .where(eq(users.clerkId, hostUserId));

      await tx
        .update(users)
        .set({ balance: sql`${users.balance} - ${wager}` })
        .where(eq(users.clerkId, userId));

      const firstTurnUserId =
        Math.random() < 0.5 ? hostUserId : userId;
      const firstTurnSeat = firstTurnUserId === hostUserId ? 1 : 2;

      const [match] = await tx
        .insert(poolMatches)
        .values({
          id: crypto.randomUUID(),
          lobbyId,
          player1Id: hostUserId,
          player2Id: userId,
          wager,
          status: "active",
          gameState: {
            started: true,
            turn: firstTurnSeat,
            version: Date.now(),
          },
          currentTurnUserId: firstTurnUserId,
        })
        .returning({ id: poolMatches.id });

      return { ok: true as const, matchId: match.id, firstTurnSeat };
    });

    if (!result.ok) {
      await db
        .update(poolLobbies)
        .set({ status: "waiting", opponentUserId: null })
        .where(eq(poolLobbies.id, lobbyId));

      return NextResponse.json(
        { ok: false, message: result.error },
        { status: result.status },
      );
    }

    return NextResponse.json({ ok: true, matchId: result.matchId, firstTurnSeat: result.firstTurnSeat });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, message: error?.message || "Unable to join lobby" },
      { status: 500 },
    );
  }
}
