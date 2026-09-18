import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { and, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelActions, hexDuelGames } from "../../../../../db/schema";
import { logError } from "../../../../../lib/logError";

const ALLOWED_ACTION_TYPES = ["attack", "displace", "endTurn", "skipRound"] as const;
type AllowedActionType = typeof ALLOWED_ACTION_TYPES[number];

/**
 * POST /api/hex-duel/multiplayer/action
 *
 * Atomic, server-authoritative action write. Replaces the previous
 * "insert into hex_duel_actions and hope both clients stay in sync"
 * pattern that caused both clients to drift (each client reconstructed
 * its own board state by replaying opponent actions only) AND let
 * either player flip the game status via the companion
 * `/multiplayer/status` POST.
 *
 * New flow:
 *   1. Wrap in a single `db.transaction` so the SELECT-FOR-UPDATE,
 *      INSERT, and UPDATE either all happen or none do.
 *   2. Lock the game row (`for("update")`) — blocks a second player
 *      from racing the same action.
 *   3. Verify the caller IS the player whose turn it currently is,
 *      using the server-authoritative `current_turn` column added in
 *      migration 0054. Reject with 409 if not — eliminates the
 *      turn-bounce bug from the legacy `status` POST.
 *   4. INSERT into hex_duel_actions with the action payload.
 *   5. UPDATE the game row: for `endTurn` (or `skipRound`) flip
 *      `current_turn` to the other player, otherwise leave it on
 *      the caller. Always advance `last_action_seq` to the new
 *      action id so the polling endpoint can cheaply detect missed
 *      actions after a reconnect.
 *
 * NOTE: this handler intentionally does NOT silently retry the
 * transaction on failure — a half-applied insert + update would be
 * worse than a visible 5xx. The caller can simply re-try by clicking
 * "end turn" / re-issuing the attack. Real bugs surface fast via the
 * cause-logging catch at the bottom.
 */
export async function POST(req: Request) {
  let gameId: number = NaN;
  let actionType: string | null = null;

  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      gameId?: unknown;
      actionType?: unknown;
      sourceKey?: string | null;
      targetKey?: string | null;
      troopCount?: number | null;
    };
    gameId = Number(body.gameId);
    actionType = typeof body.actionType === "string" ? body.actionType : null;

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ success: false, error: "Invalid gameId" }, { status: 400 });
    }

    if (
      !actionType ||
      !(ALLOWED_ACTION_TYPES as readonly string[]).includes(actionType as string)
    ) {
      return NextResponse.json({ success: false, error: "Invalid actionType" }, { status: 400 });
    }

    const sourceKey = typeof body.sourceKey === "string" ? body.sourceKey : null;
    const targetKey = typeof body.targetKey === "string" ? body.targetKey : null;
    const troopCount =
      typeof body.troopCount === "number" && Number.isFinite(body.troopCount)
        ? body.troopCount
        : null;

    const result = await db.transaction(async (tx) => {
      // 1. Lock the game row.
      const [game] = await tx
        .select()
        .from(hexDuelGames)
        .where(
          and(
            eq(hexDuelGames.id, gameId),
            or(
              eq(hexDuelGames.player1Id, userId),
              eq(hexDuelGames.player2Id, userId),
            ),
          ),
        )
        .for("update")
        .limit(1);

      if (!game) {
        throw Object.assign(new Error("Game not found"), { _httpStatus: 404 });
      }

      // 1b. Reject the write if the game is not in an actionable state.
      //     - `waiting`: only player1 exists; no player2 yet. Mirrors
      //       the React-page bug where one player could send attacks
      //       to an open lobby and clutter the action log for the
      //       future player2.
      //     - `completed`: someone already called `/multiplayer/end`.
      //       A racing POST here must not write another action on top
      //       of a finished game.
      // The legacy `in_progress` and the new `turn_player1` /
      // `turn_player2` strings both pass; the column stays the source
      // of truth (see step 2 below).
      if (
        game.status !== "in_progress" &&
        !game.status.startsWith("turn_")
      ) {
        throw Object.assign(
          new Error(`Cannot act on game in status '${game.status}'.`),
          { _httpStatus: 409 },
        );
      }

      // 2. Verify the caller is a real participant AND it is their turn.
      //    The legacy status-based check (status === 'turn_player1' /
      //    'turn_player2') is kept as a fallback so a freshly-joined game
      //    that has not yet been processed by the new column still works,
      //    but `current_turn` is the source of truth from now on.
      const callerSlot: "player1" | "player2" | null =
        game.player1Id === userId
          ? "player1"
          : game.player2Id === userId
            ? "player2"
            : null;
      if (!callerSlot) {
        throw Object.assign(new Error("Game not found"), { _httpStatus: 404 });
      }

      const statusTurn =
        game.status === "turn_player1"
          ? "player1"
          : game.status === "turn_player2"
            ? "player2"
            : null;
      const effectiveTurn = game.currentTurn ?? statusTurn ?? "player1";

      if (effectiveTurn !== callerSlot) {
        // Not the caller's turn — surface this as a 409 Conflict so the
        // client knows the action was rejected WITHOUT having to be the
        // caller (which would otherwise let either player inject moves).
        throw Object.assign(
          new Error(`Not your turn (current turn: ${effectiveTurn})`),
          { _httpStatus: 409 },
        );
      }

      // 3. Insert the action row (server-authoritative record of every
      //    move; the polling endpoint reads from here).
      const [action] = await tx
        .insert(hexDuelActions)
        .values({
          gameId,
          userId,
          actionType: actionType as AllowedActionType,
          sourceKey,
          targetKey,
          troopCount,
        })
        .returning({ id: hexDuelActions.id, createdAt: hexDuelActions.createdAt });

      // 4. Update the game row: `endTurn` / `skipRound` flips the turn;
      //    intermediate moves (attack / displace) keep the turn on the
      //    caller so the same player can do multiple actions in a row
      //    before yielding. `last_action_seq` is always advanced so the
      //    client polling can cheaply detect missed actions.
      const flipsTurn =
        (actionType as AllowedActionType) === "endTurn" ||
        (actionType as AllowedActionType) === "skipRound";
      const nextTurn: "player1" | "player2" =
        callerSlot === "player1" ? "player2" : "player1";

      await tx
        .update(hexDuelGames)
        .set({
          currentTurn: flipsTurn ? nextTurn : callerSlot,
          lastActionSeq: action.id,
          // Keep the legacy `status` column in sync so the lobby /
          // spectate endpoints that filter by status continue to work
          // without needing to read `current_turn` for filtering.
          status: flipsTurn ? `turn_${nextTurn}` : `turn_${callerSlot}`,
        })
        .where(eq(hexDuelGames.id, gameId));

      return { id: action.id, createdAt: action.createdAt };
    });

    return NextResponse.json({ success: true, action: result });
  } catch (error: any) {
    const httpStatus: number =
      typeof error?._httpStatus === "number" ? error._httpStatus : 500;

    console.error(
      "[hex-duel/multiplayer/action] POST failed",
      {
        url: req.url,
        gameId,
        actionType,
        err: error?.message,
        // Underlying cause (Postgres / Neon transport / Drizzle):
        causeMessage: error?.cause?.message,
        causeCode: error?.cause?.code,
        causeHint: error?.cause?.hint,
        causeDetail: error?.cause?.detail,
        stack: error?.stack,
      },
    );
    await logError({
      errorType: "hex_duel_action_error",
      errorMessage: error?.message || "Hex Duel action failed",
      stackTrace: error?.stack,
      endpoint: "/api/hex-duel/multiplayer/action",
      game: "Hex Duel",
      metadata: { operation: "submit_action", gameId, actionType },
    });
    return NextResponse.json(
      { success: false, error: httpStatus >= 500 ? "Server error" : error?.message || "Action failed" },
      { status: httpStatus },
    );
  }
}
