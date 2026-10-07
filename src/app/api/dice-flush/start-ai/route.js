import { NextResponse } from "next/server";
import { db, getDisplayName, initialState, diceFlushPlayers, diceFlushRooms } from "../_lib";
// Free practice is open to signed-out guests (the match is unrated); the
// caller becomes a `guest_<uuid>` seat via the HMAC-signed cookie. Matchmaking
// routes (`create` / `join`) keep the age gate.
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { coerceAiDifficulty } from "../../../../lib/aiDifficulty";
import { normalizeStake } from "../../../../lib/games/stakes";

export async function POST(req) {
  try {
    const gate = await requirePracticePlayer({ create: true });
    if (gate.response) return gate.response;
    const userId = gate.playerId;
    const { wager, difficulty: rawDifficulty } = await req.json();
    // Canonical `easy | normal | hard`: an older client's `medium`, or a lobby
    // that never sent one, lands on the shared default rather than storing a
    // spelling the shared skill table does not know.
    const difficulty = coerceAiDifficulty(rawDifficulty);
    // STAKES ARE RETIRED (src/lib/games/stakes.js): an AI match is free play.
    // The requested wager is normalized to 0 so no malformed or legacy stake
    // can be stored on the room.
    const amount = normalizeStake(wager);

    const result = await db.transaction(async (tx) => {
      // AI mode is free play — skip `lockBalance` (no token deduction) and
      // keep the recorded wager AND pot at 0, so no payout gets credited on
      // game end and no phantom stake is ever stored on the room.
      const roomId = `yahtzee:${Date.now()}:ai`;
      const name = await getDisplayName(userId, tx);
      const state = initialState(roomId, userId, name, amount);
      const aiId = `ai:${difficulty}`;
      state.ai = true;
      state.players.push({ userId: aiId, name: `AI (${difficulty})`, isAI: true, difficulty });
      state.state = "playing";
      // Shared sheet: random 50/50 starter. Each side claims exactly 6 of
      // the 12 categories — starter has first pick, other has last pick.
      state.currentTurn = Math.random() < 0.5 ? userId : aiId;
      // No shot clock vs AI — practice matches are untimed.
      // (`turnDeadline` stays null so `autoBankIfExpired` never fires.)
      state.turnDeadline = null;
      // Free play: no stake is recorded (the client always sends 0) and the
      // pot stays 0, so `settleIfEnded` never credits tokens to either side.
      state.wager = 0;
      state.pot = 0;
      await tx.insert(diceFlushRooms).values({ id: roomId, status: "playing", wager: 0, pot: 0, gameState: state });
      await tx.insert(diceFlushPlayers).values([{ roomId, userId, isAi: false, score: 0 }, { roomId, userId: aiId, isAi: true, score: 0 }]);
      return { roomId, state };
    });

    // `viewerId` lets the client identify its own seat without a Clerk
    // session — a guest has no `user.id` client-side, so the server tells it
    // which seat is its own.
    return NextResponse.json({ success: true, roomId: result.roomId, viewerId: userId, state: result.state });
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || "Failed to create AI room" }, { status: 400 });
  }
}
