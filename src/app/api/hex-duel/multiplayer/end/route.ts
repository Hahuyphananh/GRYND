import { auth } from "@clerk/nextjs/server";
import { and, eq, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelGames, users } from "../../../../../db/schema";
import { recordBigWinIfNeeded } from "../../../../../lib/bigWins";
import { applyLeaderboardCounters } from "../../../../../lib/leaderboardCounters";

const PAYOUT_MULTIPLIER = 1.9;

export async function POST(req: Request) {
  // Hoisted above the try so the catch block's diagnostics can read
  // them even when the throw happened during auth or JSON parsing.
  // Safe fallback values: empty string for clerkId/winner, NaN for
  // gameId-style numbers, undefined for stats counters.
  let clerkId: string | null = null;
  let winner: string | null = null;

  try {
    const { userId } = await auth();
    clerkId = userId ?? null;
    if (!clerkId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      winner?: unknown;
      player1Moves?: number;
      player2Moves?: number;
      player1Territory?: number;
      player2Territory?: number;
      durationSeconds?: number;
      startedAt?: string;
    };
    winner = typeof body.winner === "string" ? body.winner : null;
    const player1Moves = body.player1Moves;
    const player2Moves = body.player2Moves;
    const player1Territory = body.player1Territory;
    const player2Territory = body.player2Territory;
    const durationSeconds = body.durationSeconds;
    const startedAt = body.startedAt;

    if (winner !== "player1" && winner !== "player2") {
      return NextResponse.json({ success: false, error: "Invalid winner" }, { status: 400 });
    }

    // Atomic: find the active multiplayer game and update it
    const result = await db.transaction(async (tx) => {
      // Find an in-progress multiplayer game where the caller is either player1 or player2.
      // Uses typed or(eq(...), eq(...)) instead of the raw
      // `sql\`(${...} = ${clerkId} OR ...)\`` template — the raw template
      // has parameter-binder fragility under `drizzle-orm/neon-serverless`
      // and was a confirmed source of 500s on the sibling `actions/route.ts`.
      const [game] = await tx
        .select()
        .from(hexDuelGames)
        .where(
          and(
            eq(hexDuelGames.status, "in_progress"),
            or(
              eq(hexDuelGames.player1Id, clerkId),
              eq(hexDuelGames.player2Id, clerkId),
            ),
          ),
        )
        .for("update")
        .limit(1);

      if (!game) {
        // Check if already completed (idempotent) — typed OR, same rationale as above.
        const [completed] = await tx
          .select()
          .from(hexDuelGames)
          .where(
            and(
              eq(hexDuelGames.status, "completed"),
              or(
                eq(hexDuelGames.player1Id, clerkId),
                eq(hexDuelGames.player2Id, clerkId),
              ),
            ),
          )
          .orderBy(sql`${hexDuelGames.endedAt} DESC`)
          .limit(1);

        if (completed) {
          // Already paid out — return the existing result
          const callerWon =
            (winner === "player1" && completed.player1Id === clerkId) ||
            (winner === "player2" && completed.player2Id === clerkId);
          return {
            alreadyProcessed: true,
            won: callerWon,
            wager: Number(completed.wagerAmount),
            payout: Number(completed.payout || 0),
            multiplier: PAYOUT_MULTIPLIER,
          };
        }

        throw new Error("No active game found");
      }

      const wagerAmount = Number(game.wagerAmount);

      // Determine if the calling player won
      const callerIsPlayer1 = game.player1Id === clerkId;
      const callerWon =
        (callerIsPlayer1 && winner === "player1") ||
        (!callerIsPlayer1 && winner === "player2");

      let payout = 0;
      let newBalance: number | undefined;

      if (callerWon) {
        payout = Number((wagerAmount * PAYOUT_MULTIPLIER).toFixed(2));

        // applyLeaderboardCounters handles totalWon, currentStreak,
        // bestStreak, biggestWin — only update balance & gamesWon here
        // to avoid double-counting.
        const [updatedUser] = await tx
          .update(users)
          .set({
            balance: sql`${users.balance} + ${payout}`,
            gamesWon: sql`${users.gamesWon} + 1`,
          })
          .where(eq(users.clerkId, clerkId))
          .returning({ balance: users.balance });

        // After `const [updatedUser] = await ...returning({...})`,
        // `updatedUser` is already a SINGLE row object (or undefined).
        // Earlier code read `updatedUser?.[0]?.balance` which treated the
        // single row as a 2-D structure, so `.<0>` was always undefined
        // and `newBalance` silently became 0 on every win/loss response.
        // The fix below restores the correct single-row field access.
        newBalance = Number(updatedUser?.balance ?? 0);
      } else {
        const [updatedUser] = await tx
          .update(users)
          .set({
            currentStreak: sql`0`,
            gamesLost: sql`${users.gamesLost} + 1`,
          })
          .where(eq(users.clerkId, clerkId))
          .returning({ balance: users.balance });

        // See comment above re: `updatedUser?.[0]?.balance` bug.
        newBalance = Number(updatedUser?.balance ?? 0);
      }

      // Update the game record
      const endedAt = new Date();
      await tx
        .update(hexDuelGames)
        .set({
          winner,
          result: callerWon ? "win" : "loss",
          payout: payout > 0 ? payout.toFixed(2) : "0.00",
          player1Moves: player1Moves ?? game.player1Moves ?? 0,
          player2Moves: player2Moves ?? game.player2Moves ?? 0,
          player1Territory: player1Territory ?? game.player1Territory ?? 1,
          player2Territory: player2Territory ?? game.player2Territory ?? 1,
          durationSeconds: durationSeconds ?? 0,
          status: "completed",
          endedAt,
        })
        .where(eq(hexDuelGames.id, game.id));

      // Record big win if needed
      if (callerWon && payout >= 1_000_000) {
        const userRow = await tx
          .select({ name: users.name })
          .from(users)
          .where(eq(users.clerkId, clerkId))
          .limit(1);
        recordBigWinIfNeeded({
          userId: clerkId,
          username: userRow?.[0]?.name || "Player",
          game: "Hex Duel",
          betAmount: wagerAmount,
          winAmount: payout,
          multiplier: PAYOUT_MULTIPLIER,
        }).catch(() => {});
      }

      return {
        alreadyProcessed: false,
        won: callerWon,
        wager: wagerAmount,
        payout,
        multiplier: PAYOUT_MULTIPLIER,
        newBalance,
      };
    });

    // Record leaderboard stats (fire-and-forget, outside transaction)
    if (!result.alreadyProcessed) {
      applyLeaderboardCounters({
        clerkId,
        game: "Hex Duel",
        betAmount: result.wager,
        payout: result.won ? result.payout : 0,
        isPvpWin: result.won,
      }).catch(() => {});
    }

    return NextResponse.json({ success: true, data: result });
  } catch (error: any) {
    // Capture the real cause on `error.cause` so Vercel function logs
    // (and Sentry if wired up) finally show the actual failure mode:
    // Drizzle 0.45.x wraps every DB/network error in a
    // `DrizzleQueryError` whose `.message` is literally
    // `"Failed query: <sql>"` and whose real Postgres / network error
    // sits on `.cause`. Without this, every prior "real errors" log
    // only showed the useless wrapper.
    //
    // We also log Postgres-specific fields (`detail`, `hint`) since
    // those are the highest-signal fields on real errors once `.cause`
    // is surfaced.
    //
    // NOTE: this route deliberately has NO `withSingleRetryForReadOnly`
    // helper. The handler body is a `db.transaction(async (tx) => ...)`
    // containing SELECT FOR UPDATE + UPDATEs (balance payout + game
    // status flip). Retrying the transaction as a whole would risk
    // double-payout on flaky Neon transport; retrying just the SELECT
    // inside the tx would silently rollback + try again with the same
    // tx handle. So this route catches transport errors and surfaces
    // them via cause-logging only, while the sibling polled routes
    // (`actions/`, `status/`, `spectate/`) apply single-retry on their
    // read-only SELECTs.
    console.error(
      "[hex-duel/multiplayer/end] POST failed",
      {
        clerkId,
        winner,
        // Wrapper (DrizzleQueryError):
        err: error?.message,
        stack: error?.stack,
        // Underlying cause (Postgres / Neon transport / Drizzle):
        causeMessage: error?.cause?.message,
        causeCode: error?.cause?.code,
        causeName: error?.cause?.name,
        causeDetail: error?.cause?.detail,
        causeHint: error?.cause?.hint,
        causeStack: error?.cause?.stack,
      },
    );
    const status = error?.message === "No active game found" ? 404 : 500;
    // The client-facing `error` string is intentionally generic for
    // 500s. Postgres cause messages can leak schema internals
    // (table/column names, constraint names), so we keep the diagnostic
    // at the log layer and send the client a stable, opaque message.
    // The 404 case preserves its specific message because it is a
    // deliberate, user-actionable signal ("No active game found"),
    // not a transport/DB error.
    return NextResponse.json(
      {
        success: false,
        error:
          status === 404
            ? error?.message
            : "Server error",
      },
      { status },
    );
  }
}
