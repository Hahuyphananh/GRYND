import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { and, asc, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelActions, hexDuelGames } from "../../../../../db/schema";
import { logError } from "../../../../../lib/logError";
import { applyRecordedMove, checkHexDuelMove, type HexDuelMoveType } from "../../../../../lib/hex-duel/rules";
import { replayHexDuel, type StoredHexDuelAction } from "../../../../../lib/hex-duel/authority";

const ALLOWED_ACTION_TYPES = ["attack", "displace", "endTurn", "skipRound"] as const;
type AllowedActionType = typeof ALLOWED_ACTION_TYPES[number];

/**
 * POST /api/hex-duel/multiplayer/action
 *
 * The SERVER-AUTHORITATIVE move write, and — for a staked match — the place the
 * winner is decided.
 *
 *   1. Wrap in a single `db.transaction` so the SELECT-FOR-UPDATE, the
 *      legality replay, the INSERT and the UPDATE either all happen or none do.
 *   2. Lock the game row (`for("update")`) — blocks a second player from
 *      racing the same action.
 *   3. Verify the caller IS the player whose turn it currently is, using the
 *      server-authoritative `current_turn` column added in migration 0054.
 *   4. REPLAY the moves already stored for this match through the shared
 *      rulebook (`src/lib/hex-duel/rules.ts`) to rebuild the board the server
 *      believes in, then validate the incoming move against it with
 *      `checkHexDuelMove`. A move that is impossible there (a tile the caller
 *      does not hold, a non-adjacent hop, more troops than the tile has, no
 *      action points left) is REFUSED and nothing is written — so the recorded
 *      log is a legal game, and a client cannot fabricate a winning attack it
 *      could not have played.
 *   5. Record the accepted action, and if it captured the opponent's capital,
 *      write the winner onto the game row. That column is what
 *      `/multiplayer/end` settles on; the end request no longer names a winner.
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
      //     - `completed`: the match has been settled.
      // The legacy `in_progress` and the `turn_player1` /
      // `turn_player2` strings both pass; the column stays the source
      // of truth (see step 3 below).
      if (game.status !== "in_progress" && !game.status.startsWith("turn_")) {
        throw Object.assign(
          new Error(`Cannot act on game in status '${game.status}'.`),
          { _httpStatus: 409 },
        );
      }

      // 2. Verify the caller is a real participant AND it is their turn.
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

      // 3. Rebuild the board from the moves the server already accepted, then
      //    rule on the incoming one. This is the same rulebook the board runs,
      //    so a legal move is never refused and an impossible one is never
      //    recorded.
      const storedRows = await tx
        .select({
          userId: hexDuelActions.userId,
          actionType: hexDuelActions.actionType,
          sourceKey: hexDuelActions.sourceKey,
          targetKey: hexDuelActions.targetKey,
          troopCount: hexDuelActions.troopCount,
        })
        .from(hexDuelActions)
        .where(eq(hexDuelActions.gameId, gameId))
        .orderBy(asc(hexDuelActions.id));

      const seats = { player1Id: game.player1Id, player2Id: game.player2Id };
      const replayed = replayHexDuel(seats, storedRows as StoredHexDuelAction[]);

      const move = {
        type: actionType as HexDuelMoveType,
        sourceKey,
        targetKey,
        troopCount,
      };
      // Annotated rather than inferred: `strict` is off in this project, where a
      // discriminated union is not narrowed by `if (!x.ok)` (same note as
      // src/lib/tokens/pvpPot.ts).
      const check: { ok: boolean; code?: string; error?: string } = checkHexDuelMove(
        replayed.state,
        callerSlot,
        move,
      );
      if (!check.ok) {
        // Turn / game-state problems are conflicts; an impossible move is a
        // bad request. Either way the client is told why.
        const status = check.code === "NOT_YOUR_TURN" || check.code === "GAME_OVER" ? 409 : 400;
        throw Object.assign(new Error(check.error), {
          _httpStatus: status,
          _code: check.code,
        });
      }

      // 4. Insert the action row (server-authoritative record of every
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

      // 5. Update the game row: `endTurn` / `skipRound` flips the turn;
      //    intermediate moves (attack / displace) keep the turn on the
      //    caller so the same player can do multiple actions in a row
      //    before yielding. `last_action_seq` is always advanced so the
      //    client polling can cheaply detect missed actions.
      const flipsTurn =
        (actionType as AllowedActionType) === "endTurn" ||
        (actionType as AllowedActionType) === "skipRound";
      const nextTurn: "player1" | "player2" =
        callerSlot === "player1" ? "player2" : "player1";

      // 6. The SERVER's winner: applying the accepted move to the server's own
      //    board is what decides a match — a capital capture, and nothing else.
      //    `winner` is only written while it is still `pending`, so the first
      //    deciding move owns the result and no later write can flip it.
      const nextState = applyRecordedMove(replayed.state, callerSlot, move);
      const decidedWinner = nextState.winner;

      await tx
        .update(hexDuelGames)
        .set({
          currentTurn: flipsTurn ? nextTurn : callerSlot,
          lastActionSeq: action.id,
          // Keep the legacy `status` column in sync so the lobby /
          // spectate endpoints that filter by status continue to work
          // without needing to read `current_turn` for filtering.
          status: flipsTurn ? `turn_${nextTurn}` : `turn_${callerSlot}`,
          ...(decidedWinner && game.winner === "pending"
            ? { winner: decidedWinner }
            : {}),
        })
        .where(eq(hexDuelGames.id, gameId));

      return {
        id: action.id,
        createdAt: action.createdAt,
        winner: decidedWinner,
      };
    });

    return NextResponse.json({ success: true, action: { id: result.id, createdAt: result.createdAt }, winner: result.winner });
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
      metadata: { operation: "submit_action", gameId, actionType, code: error?._code ?? null },
    });
    return NextResponse.json(
      { success: false, error: httpStatus >= 500 ? "Server error" : error?.message || "Action failed" },
      { status: httpStatus },
    );
  }
}
