import { auth } from "@clerk/nextjs/server";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { db } from "../../../db/client";
import { users, diceFlushActions, diceFlushPlayers, diceFlushRooms } from "../../../db/schema";
import { autoBankIfExpired, checkGameEnd, holdDice, nextTurn, rollDice, validateMove } from "../../../../game-engine/diceFlushEngine";
import { applyLeaderboardCounters } from "../../../lib/leaderboardCounters";
import { applyRatingResult } from "../../../lib/rating";
import { applyTrophyResult } from "../../../lib/trophyStore";
import { normalizeStake } from "../../../lib/games/stakes";
import { GUEST_DISPLAY_NAME, isGuestId } from "../../../lib/guestIdentity";

export function initialState(roomId, creatorId, creatorName, wager) {
  // STAKES ARE RETIRED (src/lib/games/stakes.js): the match is free, so the
  // recorded wager and the pot are 0 and `settleIfEnded` pays out nothing.
  const stake = normalizeStake(wager);
  return {
    id: roomId,
    game: "yahtzee",
    players: [{ userId: creatorId, name: creatorName }],
    ai: false,
    wager: stake,
    pot: stake,
    state: "waiting",
    currentTurn: creatorId,
    turnNumber: 1,
    rollsThisTurn: 0,
    dice: [1, 1, 1, 1, 1],
    heldDice: [false, false, false, false, false],
    // Shared scorecard — both players fill the same 12 categories.
    scorecards: {},
    scorecardOwner: {},
    currentCall: null,
    turnDeadline: null,
  };
}

/** Resolve a stalled turn (shot clock) inside a transaction. If the current
 *  turn has exceeded its deadline, auto-bank the best legal category and
 *  persist the advanced state. Call at the top of every move handler BEFORE
 *  validating the incoming move — a stale move from the timed-out player is
 *  then naturally rejected by `validateMove` ("Not your turn"). Returns the
 *  resolved state plus whether a timeout occurred and who was timed out.
 *  If the auto-bank filled the final category the match is settled here
 *  (trophies + leaderboard) — previously the game was left stuck
 *  in `playing` with a full scorecard and never paid out. */
export async function resolveExpiredTurn(tx, roomRow, state) {
  const { state: resolved, didTimeout } = autoBankIfExpired(state);
  if (!didTimeout) return { state: resolved, didTimeout, resolvedByUserId: null };
  await tx.update(diceFlushRooms).set({ gameState: resolved }).where(eq(diceFlushRooms.id, roomRow.id));
  await appendAction(tx, roomRow.id, state.currentTurn, "auto_bank_timeout", {});
  // The auto-bank ended the match (final category claimed on the timeout)
  // — settle it exactly like a normal choosing move would.
  if (resolved.state === "finished") {
    await settleIfEnded(tx, roomRow, resolved);
  }
  return { state: resolved, didTimeout: true, resolvedByUserId: state.currentTurn };
}

export async function requireUser() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  return userId;
}

/**
 * Per-room SEAT check. Unlike the games that authorise inside their store,
 * Dice Flush resolves the caller in the route, so every room-scoped route
 * must confirm the caller actually holds a seat in this room before it reads
 * or mutates it. A signed-in stranger and a signed-out guest with no seat
 * both get the same 403 — which is exactly what lets the vs-AI practice path
 * be opened to guests without leaking another player's room.
 *
 * Throws an error carrying `status = 403`; the route catches map that to the
 * response status (a plain 400 is reserved for malformed input).
 */
export function isRoomSeat(state, playerId) {
  const players = Array.isArray(state?.players) ? state.players : [];
  return players.some((p) => String(p?.userId) === String(playerId));
}

export function assertRoomSeat(state, playerId) {
  if (!isRoomSeat(state, playerId)) {
    const err = new Error("Not a player in this room");
    err.status = 403;
    throw err;
  }
  return true;
}

/**
 * The status a route catch block should send for an error thrown by
 * `assertRoomSeat` (403) or any other route error that set its own `status`;
 * falls back to the historical 400 for malformed / rejected moves.
 */
export function errorStatus(e) {
  return typeof e?.status === "number" ? e.status : 400;
}

export async function loadRoom(roomId, tx = db) {
  const [room] = await tx.select().from(diceFlushRooms).where(eq(diceFlushRooms.id, roomId));
  if (!room) throw new Error("Room not found");
  return room;
}

export async function appendAction(tx, roomId, userId, actionType, payload) {
  await tx.insert(diceFlushActions).values({ roomId, userId, actionType, payload });
}

export async function lockBalance() {
  // STAKES ARE RETIRED: a match never moves tokens, so there is nothing to
  // lock and nothing to debit.
  return 0;
}

export async function getDisplayName(userId, tx = db) {
  // A guest owns no `users` row, so the `clerk_id` lookup below would fall
  // through to the generic "Player" label. Give the guest its proper seat
  // name instead, matching every other guest-capable game.
  if (isGuestId(userId)) return GUEST_DISPLAY_NAME;
  const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.clerkId, userId)).limit(1);
  return u?.name || "Player";
}

export async function settleIfEnded(tx, roomRow, state) {
  const ended = checkGameEnd(state);
  if (!ended.ended) return { state, ended: false };
  // STAKES ARE RETIRED: there is no pot to pay out or rake.
  const payout = 0;
  state.state = "finished";
  // Conditional settlement claim: only one transaction may flip the room to
  // "finished". The WHERE predicate guards against concurrent final-turn
  // requests that both validated the same still-playing snapshot — only the
  // first commit wins; a racing transaction sees no affected rows and skips
  // (idempotent no-op).
  const [claimed] = await tx.update(diceFlushRooms).set({ status: "finished", gameState: state, pot: 0 }).where(and(eq(diceFlushRooms.id, roomRow.id), ne(diceFlushRooms.status, "finished"))).returning();
  if (!claimed) {
    // A concurrent transaction already settled — return the finished state
    // but signal that this transaction did not perform the settlement.
    return { state, ended: true, winnerId: ended.winnerId, payout: 0, totals: ended.totals, alreadySettled: true };
  }

  // Record the SKILL leaderboards (wins/losses/win_rate/streaks) for a real
  // human-vs-human match only — outcome-driven and token/XP-free. An AI
  // practice game must not feed the leaderboards.
  const isAiMatch = !!state.players?.some((p) => p.isAI);
  if (!isAiMatch && ended.winnerId) {
    applyLeaderboardCounters({
      clerkId: ended.winnerId,
      game: "Dice Flush",
      outcome: "win",
      isPvpWin: true,
    }).catch(() => {});

    for (const p of state.players ?? []) {
      if (p.userId !== ended.winnerId && !p.isAI) {
        applyLeaderboardCounters({
          clerkId: p.userId,
          game: "Dice Flush",
          outcome: "loss",
        }).catch(() => {});
      }
    }
  }

  // Competitive (non-AI) finish: Dice Flush is 1v1, so rate the winner against
  // the single human opponent. This runs on the claim-guarded path (only the
  // transaction that claimed the settlement reaches here) and the journals
  // keep it idempotent.
  if (!isAiMatch) {
    const humanLoser = state.players?.find(
      (p) => p.userId !== ended.winnerId && !p.isAI,
    );
    if (humanLoser) {
      await applyRatingResult({
        tx,
        gameKey: "dice-flush",
        matchId: String(roomRow.id),
        winnerClerkId: ended.winnerId,
        loserClerkId: humanLoser.userId,
      }).catch(() => {});
      // Per-game trophies — the same authoritative win (+30 / −30).
      await applyTrophyResult({
        tx,
        gameKey: "dice-flush",
        matchId: String(roomRow.id),
        winnerClerkId: ended.winnerId,
        loserClerkId: humanLoser.userId,
      }).catch(() => {});
    }
  }

  return { state, ended: true, winnerId: ended.winnerId, payout, totals: ended.totals };
}

export { db, eq, and, asc, isNull, ne, users, diceFlushRooms, diceFlushPlayers, rollDice, holdDice, validateMove, nextTurn };
