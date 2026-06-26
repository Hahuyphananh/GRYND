import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { dotsAndBoxesGames } from "../../../../db/schema";
import {
  determineResult,
  drawEdge as engineDrawEdge,
  ensureState,
  hEdgeKey,
  isGameOver,
  remainingEdges,
  vEdgeKey,
} from "../../../../lib/dotsAndBoxesEngine";
import {
  getGameMoveSeconds,
  nextMoveDeadline,
  settleDotsAndBoxesGame,
} from "../../../../lib/dotsAndBoxesServer";
import { recordInvalidAction } from "../../../../lib/dotsAndBoxesAudit";

// ── Map draw-edge rejections to an audit "reason" tag ─────────────
// Anything not in this map is generic and not worth logging.
const REJECTION_REASONS = {
  "Game not found": "invalid_game_id",
  "Game is not active": "game_not_active",
  "You are not a player in this game": "not_a_player",
  "Not your turn": "not_your_turn",
  "Edge already drawn": "duplicate_edge",
  "Edge out of bounds": "out_of_bounds",
  "Invalid edge key": "bad_edge_key",
  "Invalid edge type": "bad_edge_type",
  "Invalid edge coordinates": "bad_edge_coords",
  "Score-box invariant violation": "engine_invariant_violation",
};

/**
 * Belt-and-suspenders: re-derive scores from the boxOwner map and
 * reject the move if the engine produced inconsistent state.
 */
function verifyScoresMatchBoxes(state) {
  const totalBoxes = state.boxes.length;
  let hostOwned = 0;
  let guestOwned = 0;
  for (const role of Object.values(state.boxOwners || {})) {
    if (role === "host") hostOwned++;
    else if (role === "guest") guestOwned++;
  }
  return (
    state.scores?.host === hostOwned && state.scores?.guest === guestOwned
  );
}

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const body = await req.json();
    const gameId = Number(body?.gameId);
    const { type, row, col } = body;

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json(
        { success: false, error: "Invalid gameId" },
        { status: 400 },
      );
    }
    if (type !== "h" && type !== "v") {
      return NextResponse.json(
        { success: false, error: "Invalid edge type" },
        { status: 400 },
      );
    }
    if (typeof row !== "number" || typeof col !== "number") {
      return NextResponse.json(
        { success: false, error: "Invalid edge coordinates" },
        { status: 400 },
      );
    }

    const edgeKey = type === "h" ? hEdgeKey(row, col) : vEdgeKey(row, col);

    const result = await db.transaction(async (tx) => {
      // Fetch with row lock to serialize concurrent draws
      const [game] = await tx
        .select()
        .from(dotsAndBoxesGames)
        .where(eq(dotsAndBoxesGames.id, gameId))
        .for("update");

      if (!game) throw new Error("Game not found");
      if (game.status !== "in_progress") throw new Error("Game is not active");

      const role =
        game.hostClerkId === userId
          ? "host"
          : game.guestClerkId === userId
            ? "guest"
            : null;
      if (!role) throw new Error("You are not a player in this game");

      const state = ensureState(game.gameState);

      const drawResult = engineDrawEdge(state, edgeKey, role);
      if (drawResult.error) throw new Error(drawResult.error);

      const newState = drawResult.state;

      // ── Defense-in-depth: catch tampered/poisoned state ──
      if (!verifyScoresMatchBoxes(newState)) {
        throw new Error("Score-box invariant violation");
      }

      if (isGameOver(newState)) {
        // Persist the final board state first. settleDotsAndBoxesGame
        // owns the terminal write (status=finished, result, winner,
        // payout, endedAt, clearing the deadline) and runs in a
        // separate transaction after this one commits.
        const { winnerClerkId, result: resultStr } = determineResult(
          newState,
          game.hostClerkId,
          game.guestClerkId,
        );

        await tx
          .update(dotsAndBoxesGames)
          .set({ gameState: newState })
          .where(eq(dotsAndBoxesGames.id, gameId));

        return {
          gameState: newState,
          role,
          remaining: 0,
          gameOver: true,
          winnerClerkId,
          result: resultStr,
          moveDeadlineAt: null,
        };
      }

      const moveDeadlineAt = nextMoveDeadline(getGameMoveSeconds(game));
      await tx
        .update(dotsAndBoxesGames)
        .set({ gameState: newState, moveDeadlineAt })
        .where(eq(dotsAndBoxesGames.id, gameId));

      return {
        gameState: newState,
        role,
        remaining: remainingEdges(newState),
        gameOver: false,
        winnerClerkId: null,
        result: null,
        moveDeadlineAt,
      };
    });

    // Settle payout if the game just ended (separate transaction)
    if (result.gameOver) {
      if (result.winnerClerkId) {
        await settleDotsAndBoxesGame(
          gameId,
          result.winnerClerkId,
          result.result || "host_win",
        );
      } else {
        await settleDotsAndBoxesGame(gameId, null, "draw");
      }
    }

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error?.message || "Internal Server Error";

    // ── Audit suspicious activity (cheap in-memory counter; DB only
    //    escalates at thresholds so probes don't flood the ledger). ──
    const reason = REJECTION_REASONS[message];
    if (reason && gameId) {
      try {
        await recordInvalidAction({
          clerkId: userId,
          gameId,
          action: "draw-edge",
          reason,
          headers: req?.headers,
        });
      } catch {
        // audit failure must never crash the route
      }
    }

    let status = 500;
    if (message === "Game not found" || message === "You are not a player in this game") {
      status = 403;
    } else if (
      message === "Not your turn" ||
      message === "Edge already drawn" ||
      message === "Edge out of bounds" ||
      message === "Game is not active" ||
      message === "Invalid edge" ||
      message === "Invalid edge type" ||
      message === "Invalid edge coordinates" ||
      message === "Invalid edge key" ||
      message === "Score-box invariant violation"
    ) {
      status = 400;
    }
    return NextResponse.json(
      { success: false, error: message },
      { status },
    );
  }
}
