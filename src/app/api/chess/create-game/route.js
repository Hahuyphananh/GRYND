// src/app/api/chess/create-game/route.js
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../db/client";
import { chessGames, users } from "../../../../db/schema";
import { eq, and, lt, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { normalizeStake } from "../../../../lib/games/stakes";

const TIMER_CONFIG = {
  "1min": 60,
  "2min": 120,
  "3min": 180,
  "5min": 300,
  "10min": 600,
  "30min": 1800,
  // Keep legacy names for URL-based direct navigation
  bullet: 120,
  blitz: 300,
  normal: 1800,
};

async function getUserAliases(clerkId) {
  const aliases = [String(clerkId)];
  const [userRow] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);
  if (userRow?.id) aliases.push(String(userRow.id));
  return aliases;
}

export async function POST(req) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    // STAKES ARE RETIRED (src/lib/games/stakes.js): competitive play is
    // free, so a table is created at stake 0 no matter what the client sent.
    // Whatever was requested is ignored rather than rejected — old clients,
    // cached pages and saved stake defaults must all still be able to start a
    // game.
    const tableAmount = normalizeStake(body.tableAmount);
    const timerMode = String(body.timerMode || "").toLowerCase();
    const timeLimit = Number(body.timeLimit);
    
    
    // Accept explicit timeLimit from client, or look up from TIMER_CONFIG
    const initialTimeSeconds = Number.isFinite(timeLimit) && timeLimit > 0
      ? timeLimit
      : TIMER_CONFIG[timerMode];
    
    if (!initialTimeSeconds || initialTimeSeconds <= 0) {
      return NextResponse.json(
        { error: "Invalid timer option" },
        { status: 400 },
      );
    }

    const userAliases = await getUserAliases(clerkId);

    await db
      .update(chessGames)
      .set({ status: "expired", endedAt: new Date() })
      .where(
        and(
          eq(chessGames.status, "waiting"),
          eq(chessGames.isAiGame, false),
          lt(chessGames.createdAt, new Date(Date.now() - 5 * 60 * 1000)),
        ),
      );

    const aliasConditions = [
      eq(chessGames.playerWhiteId, userAliases[0]),
      eq(chessGames.playerBlackId, userAliases[0]),
    ];
    if (userAliases[1]) {
      aliasConditions.push(eq(chessGames.playerWhiteId, userAliases[1]));
      aliasConditions.push(eq(chessGames.playerBlackId, userAliases[1]));
    }

    const existingGame = await db
      .select()
      .from(chessGames)
      .where(
        and(
          or(...aliasConditions),
          eq(chessGames.isAiGame, false),
          or(
            eq(chessGames.status, "waiting"),
            eq(chessGames.status, "in_progress"),
          ),
        ),
      )
      .orderBy(chessGames.createdAt)
      .limit(1);

    if (existingGame.length > 0) {
      const game = existingGame[0];
      const color = userAliases.includes(String(game.playerWhiteId))
        ? "white"
        : "black";
      const ready = Boolean(game.playerWhiteId && game.playerBlackId);

      if (
        game.status === "waiting" &&
        (Number(game.betAmount) !== tableAmount || game.timerMode !== timerMode)
      ) {
        return NextResponse.json(
          {
            error: `You already have a waiting game at $${Number(game.betAmount)} (${game.timerMode}). Cancel it first or re-open that setup.`,
            existingGameId: game.id,
          },
          { status: 400 },
        );
      }

      return NextResponse.json({
        gameId: game.id,
        color,
        ready,
        status: game.status,
        note: "Reusing existing game",
      });
    }

    const [newGame] = await db
      .insert(chessGames)
      .values({
        playerWhiteId: clerkId,
        betAmount: tableAmount,
        timerMode,
        initialTimeSeconds,
        status: "waiting",
        isAiGame: false,
      })
      .returning({ id: chessGames.id });

    return NextResponse.json({
      gameId: newGame.id,
      color: "white",
      ready: false,
      status: "waiting",
      timerMode,
      initialTimeSeconds,
    });
  } catch (err) {
    console.error("Create-game error:", err);
    const errorMessage = err?.message || "Internal Server Error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
