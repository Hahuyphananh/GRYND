import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { and, asc, eq, gte, isNull, not, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelGames, users } from "../../../../../db/schema";
export async function POST(req: Request) {
  // Hoisted above the try so the catch block's diagnostics can read
  // them without re-parsing the request body.
  let gameId: number = NaN;
  let quickJoin: boolean = false;

  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as {
      gameId?: unknown;
      quickJoin?: unknown;
    };
    gameId = Number(body.gameId);
    quickJoin = body.quickJoin === true;

    const joined = await db.transaction(async (tx) => {
      let game: typeof hexDuelGames.$inferSelect | undefined;
      // The bare `ne(...)` operator was replaced with `not(eq(...))`
      // because it is suspected to share the same neon-serverless
      // parameter-binder fragility as the raw sql templates the
      // sibling `actions/route.ts` had to abandon. `not(eq(...))`
      // produces semantically identical SQL (`<>`) via the standard
      // parameterized path.
      if (Number.isFinite(gameId) && gameId > 0) {
        [game] = await tx.select().from(hexDuelGames).where(and(
          eq(hexDuelGames.id, gameId),
          eq(hexDuelGames.status, "waiting"),
          isNull(hexDuelGames.player2Id),
          not(eq(hexDuelGames.player1Id, userId)),
        )).for("update");
      } else if (quickJoin) {
        [game] = await tx.select().from(hexDuelGames).where(and(
          eq(hexDuelGames.status, "waiting"),
          isNull(hexDuelGames.player2Id),
          not(eq(hexDuelGames.player1Id, userId)),
        )).orderBy(asc(hexDuelGames.createdAt)).limit(1).for("update");
      }
      if (!game) throw new Error("No compatible game available");

      let updatedBalance: number | null = null;
      if (Number(game.wagerAmount) > 0) {
        const [updatedUser] = await tx.update(users)
          // `sql\`${col} - ${val}\`` is an arithmetic SET clause (not a
          // multi-column comparison WHERE) \u2014 stays as a typed `sql`
          // template since there is no direct Drizzle arithmetic helper.
          .set({ balance: sql`${users.balance} - ${game.wagerAmount}` })
          .where(and(
            eq(users.clerkId, userId),
            // Replaced raw `sql\`${col} >= ${val}\`` with typed `gte()`
            // for consistency with the rest of the route and as a
            // defensive measure against the neon-serverless binder issue.
            gte(users.balance, game.wagerAmount),
          ))
          .returning({ balance: users.balance });
        if (!updatedUser) throw new Error("Insufficient balance");
        updatedBalance = Number(updatedUser.balance);
      }

      const [row] = await tx.update(hexDuelGames)
        .set({
          player2Id: userId,
          status: "in_progress",
          // Server-authoritative initial turn. Migration 0054 added this
          // column; player1 always plays first to match the legacy
          // frontend default and the `/multiplayer/status` GET fallback
          // (status `in_progress` → currentTurn `player1`).
          currentTurn: "player1",
          // Re-initialize the action cursor so an action sequence id > 0
          // is the polling hint on the first poll. The very first poll
          // after join returns no rows (afterId 0 → all rows with
          // id > 0, which is none if none have been played yet).
          lastActionSeq: 0,
          startedAt: new Date(),
        })
        .where(and(eq(hexDuelGames.id, game.id), eq(hexDuelGames.status, "waiting"), isNull(hexDuelGames.player2Id)))
        .returning({ id: hexDuelGames.id });
      if (!row) throw new Error("Game unavailable");
      return { gameId: row.id, newBalance: updatedBalance };
    });

    return NextResponse.json({ success: true, ...joined });
  } catch (error: any) {
    // Log the underlying error server-side so Vercel function logs
    // (and Sentry if wired up) actually capture the cause. Note: the
    // status stays 400 for all errors including the bind-fragility
    // ones \u2014 a `500` would surface as a thrown error, and the
    // typed-operator rewrite is meant to prevent the throw entirely.
    console.error(
      "[hex-duel/multiplayer/join] POST failed",
      {
        gameId,
        quickJoin,
        err: error?.message,
        stack: error?.stack,
      },
    );
    return NextResponse.json({ success: false, error: error?.message || "Unable to join game" }, { status: 400 });
  }
}
