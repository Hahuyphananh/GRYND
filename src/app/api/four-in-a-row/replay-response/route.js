import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { fourInARowGames, users } from "../../../../db/schema";
import {
  getPlayerRole,
  getUserAliases,
} from "../../../../lib/fourInARowServer";

const REPLAY_WINDOW_SECONDS = 20;

export async function POST(req) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId)
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );

    const body = await req.json();
    const gameId = Number(body?.gameId);
    const action = body?.action === "quit" ? "quit" : "replay";

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json(
        { success: false, error: "Invalid gameId" },
        { status: 400 },
      );
    }

    const userAliases = await getUserAliases(userId);

    const result = await db.transaction(async (tx) => {
      const [game] = await tx
        .select()
        .from(fourInARowGames)
        .where(eq(fourInARowGames.id, gameId))
        .for("update");
      if (!game) throw new Error("Game not found");
      if (game.status !== "finished")
        throw new Error("Replay is only available after a finished game");
      if (!game.guestClerkId)
        return {
          resolved: "quit",
          reason: "Replay unavailable for this match",
        };

      const role = getPlayerRole(game, userAliases);
      if (!role) throw new Error("Game not found");

      const replayTimeRemaining = game.replayDeadlineAt
        ? Math.max(
            0,
            Math.ceil(
              (new Date(game.replayDeadlineAt).getTime() - Date.now()) / 1000,
            ),
          )
        : 0;

      if (replayTimeRemaining <= 0) {
        return { resolved: "quit", reason: "Replay window expired" };
      }

      const setUpdate =
        role === "host"
          ? { hostReplayDecision: action }
          : { guestReplayDecision: action };

      const [updated] = await tx
        .update(fourInARowGames)
        .set(setUpdate)
        .where(eq(fourInARowGames.id, game.id))
        .returning();

      const hostDecision = updated.hostReplayDecision;
      const guestDecision = updated.guestReplayDecision;

      if (hostDecision === "quit" || guestDecision === "quit") {
        return { resolved: "quit", reason: "Opponent refused replay" };
      }

      if (hostDecision !== "replay" || guestDecision !== "replay") {
        return { resolved: "pending" };
      }

      const bet = Number(updated.betAmount || 0);

      const [hostCharged] = await tx
        .update(users)
        .set({ balance: sql`${users.balance} - ${bet}` })
        .where(
          and(
            eq(users.clerkId, updated.hostClerkId),
            sql`${users.balance} >= ${bet}`,
          ),
        )
        .returning({ balance: users.balance });

      if (!hostCharged) {
        await tx
          .update(fourInARowGames)
          .set({ hostReplayDecision: "quit" })
          .where(eq(fourInARowGames.id, updated.id));
        return {
          resolved: "quit",
          reason: "Replay cancelled: host has insufficient balance",
        };
      }

      const [guestCharged] = await tx
        .update(users)
        .set({ balance: sql`${users.balance} - ${bet}` })
        .where(
          and(
            eq(users.clerkId, updated.guestClerkId),
            sql`${users.balance} >= ${bet}`,
          ),
        )
        .returning({ balance: users.balance });

      if (!guestCharged) {
        await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${bet}` })
          .where(eq(users.clerkId, updated.hostClerkId));
        await tx
          .update(fourInARowGames)
          .set({ guestReplayDecision: "quit" })
          .where(eq(fourInARowGames.id, updated.id));
        return {
          resolved: "quit",
          reason: "Replay cancelled: guest has insufficient balance",
        };
      }

      const [newGame] = await tx
        .insert(fourInARowGames)
        .values({
          hostClerkId: updated.hostClerkId,
          guestClerkId: updated.guestClerkId,
          betAmount: updated.betAmount,
          timerSeconds: updated.timerSeconds || 60,
          status: "in_progress",
          currentTurn: "host",
          startedAt: new Date(),
          moveDeadlineAt: new Date(
            Date.now() + Number(updated.timerSeconds || 60) * 1000,
          ),
        })
        .returning({ id: fourInARowGames.id });

      await tx
        .update(fourInARowGames)
        .set({
          nextGameId: newGame.id,
          replayDeadlineAt: new Date(Date.now() + REPLAY_WINDOW_SECONDS * 1000),
        })
        .where(eq(fourInARowGames.id, updated.id));

      return { resolved: "replay", gameId: newGame.id };
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error?.message || "Unable to respond to replay",
      },
      { status: 400 },
    );
  }
}
