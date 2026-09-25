import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { dotsAndBoxesGames } from "../../../../db/schema";
import { BOXES, determineResult, drawEdge, ensureState, getLegalEdges, isGameOver } from "../../../../lib/dotsAndBoxesEngine";
import { DOTS_AND_BOXES_AI_ID, isDotsAndBoxesAiGame, nextMoveDeadline, settleDotsAndBoxesGame } from "../../../../lib/dotsAndBoxesServer";
import { coerceAiDifficulty } from "../../../../lib/aiDifficulty";

/** The four edge keys that bound box (r, c). */
function boxSideKeys(r, c) {
  return [`h:${r},${c}`, `h:${r + 1},${c}`, `v:${r},${c}`, `v:${r},${c + 1}`];
}

/**
 * How many unclaimed boxes are left with exactly THREE sides drawn — i.e.
 * how many free boxes this move hands the opponent. Lower is better; 0 means
 * the move is safe.
 */
function boxesOffered(edgesSet, boxOwners) {
  let n = 0;
  for (let r = 0; r < BOXES; r += 1) {
    for (let c = 0; c < BOXES; c += 1) {
      const key = `${r},${c}`;
      if (boxOwners[key]) continue;
      let sides = 0;
      for (const side of boxSideKeys(r, c)) if (edgesSet.has(side)) sides += 1;
      if (sides === 3) n += 1;
    }
  }
  return n;
}

/**
 * The bot's edge choice, tiered like every other game's AI:
 *   easy   — a uniformly random legal edge (no capture awareness at all).
 *   normal — the policy the bot shipped with: complete a box when it can,
 *            otherwise random.
 *   hard   — complete boxes when it can, else play a genuinely SAFE edge
 *            (one that gives the opponent nothing); when every move opens a
 *            box (the endgame), give away the fewest.
 */
function chooseEdge(state, difficulty) {
  const legal = getLegalEdges(state);
  if (!legal.length) return null;

  const tier = coerceAiDifficulty(difficulty);
  if (tier === "easy") {
    return legal[Math.floor(Math.random() * legal.length)];
  }

  // 1) Capture: any edge that completes a box for the bot.
  const captures = [];
  for (const edge of legal) {
    const probe = drawEdge(state, edge, "guest");
    if (
      !probe.error &&
      probe.state.scores.guest > state.scores.guest
    ) {
      captures.push({
        edge,
        gained: probe.state.scores.guest - state.scores.guest,
      });
    }
  }
  if (captures.length) {
    captures.sort((a, b) => b.gained - a.gained);
    return captures[0].edge;
  }
  if (tier !== "hard") {
    return legal[Math.floor(Math.random() * legal.length)];
  }

  // 2) Safe edge: drawing it does not hand over a three-sided box.
  const base = new Set(state.edges);
  const safe = [];
  const risky = [];
  for (const edge of legal) {
    const after = new Set(base);
    after.add(edge);
    const offered = boxesOffered(after, state.boxOwners);
    if (offered === 0) safe.push(edge);
    else risky.push({ edge, offered });
  }
  if (safe.length) {
    return safe[Math.floor(Math.random() * safe.length)];
  }

  // 3) Everything opens a box: concede the fewest.
  risky.sort((a, b) => a.offered - b.offered);
  return risky[0]?.edge ?? legal[Math.floor(Math.random() * legal.length)];
}

export async function POST(req) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const gameId = Number(body?.gameId);
    if (!Number.isInteger(gameId) || gameId <= 0) return NextResponse.json({ success: false, error: "Invalid gameId" }, { status: 400 });

    const result = await db.transaction(async (tx) => {
      const [game] = await tx.select().from(dotsAndBoxesGames).where(eq(dotsAndBoxesGames.id, gameId)).for("update");
      if (!game) throw new Error("Game not found");
      if (!isDotsAndBoxesAiGame(game)) throw new Error("Not an AI game");
      if (userId !== game.hostClerkId) throw new Error("Forbidden");
      if (game.status !== "in_progress") return { skipped: true, game };

      const state = ensureState(game.gameState);
      if (state.currentTurn !== "guest") return { skipped: true, game };
      const edge = chooseEdge(state, game.aiDifficulty);
      if (!edge) return { skipped: true, game };
      const moved = drawEdge(state, edge, "guest");
      if (moved.error) throw new Error(moved.error);
      // AI games are untimed — the human's next turn gets no deadline.
      await tx.update(dotsAndBoxesGames).set({ gameState: moved.state, moveDeadlineAt: null }).where(eq(dotsAndBoxesGames.id, game.id));
      return { skipped: false, gameOver: isGameOver(moved.state), winner: isGameOver(moved.state) ? determineResult(moved.state, game.hostClerkId, DOTS_AND_BOXES_AI_ID) : null };
    });

    if (result.gameOver) await settleDotsAndBoxesGame(gameId, result.winner.winnerClerkId, result.winner.result);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error?.message || "Internal Server Error";
    const status = message === "Forbidden" ? 403 : message === "Not an AI game" ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
