import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { and, asc, eq, isNull, not } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelGames, users } from "../../../../../db/schema";
import { escrowMatchWagers } from "../../../../../lib/tokens/wager";

/**
 * POST /api/hex-duel/multiplayer/join
 *
 * Seat the opponent and FUND BOTH SEATS.
 *
 * The escrow runs inside the same transaction that claims the lobby — the
 * platform's rule for every staked duel (`src/lib/tokens/wager.ts`): a staked
 * match is never half-funded, a seat that cannot cover the stake leaves the
 * lobby untouched and waiting, and the coins commit with the seat that earned
 * them. A 0-stake row (a legacy free lobby) escrows nothing.
 */
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

      const [row] = await tx.update(hexDuelGames)
        .set({
          player2Id: userId,
          status: "in_progress",
          // Server-authoritative initial turn. The joining seat (player2)
          // opens every PvP match, matching Barrier Blitz's purple-first rule;
          // AI games keep the engine's player1 opening because they never pass
          // through this route. `currentTurn` is the source of truth, not the
          // legacy `status` string.
          currentTurn: "player2",
          // Re-initialize the action cursor so an action sequence id > 0
          // is the polling hint on the first poll. The very first poll
          // after join returns no rows (afterId 0 → all rows with
          // id > 0, which is none if none have been played yet).
          lastActionSeq: 0,
          startedAt: new Date(),
        })
        .where(and(eq(hexDuelGames.id, game.id), eq(hexDuelGames.status, "waiting"), isNull(hexDuelGames.player2Id)))
        .returning({ id: hexDuelGames.id, wagerAmount: hexDuelGames.wagerAmount });
      if (!row) throw new Error("Game unavailable");

      // Both seats pay the stake the lobby carries, all-or-nothing.
      const stake = Number(row.wagerAmount) || 0;
      // Annotated rather than inferred: `strict` is off in this project, where a
      // discriminated union is not narrowed by `if (!x.ok)` (same note as
      // src/lib/tokens/pvpPot.ts).
      const escrow: { ok: boolean; error?: string; status?: number } =
        await escrowMatchWagers({
          clerkIds: [game.player1Id, userId],
          stake,
          matchId: row.id,
          gameKey: "hex-duel",
          tx,
        });
      if (!escrow.ok) {
        throw Object.assign(new Error(escrow.error || "Insufficient coins"), {
          _httpStatus: escrow.status ?? 400,
        });
      }

      // Report the caller's balance as it now stands (post-escrow) so the
      // header chip reflects the stake that just moved.
      const [me] = await tx
        .select({ balance: users.balance })
        .from(users)
        .where(eq(users.clerkId, userId))
        .limit(1);

      return {
        gameId: row.id,
        wager: stake,
        newBalance: me ? Number(me.balance) : null,
      };
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
    return NextResponse.json(
      { success: false, error: error?.message || "Unable to join game" },
      { status: typeof error?._httpStatus === "number" ? error._httpStatus : 400 },
    );
  }
}
