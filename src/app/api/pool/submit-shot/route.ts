import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { db } from "../../../../db";
import { poolMatches, poolShots } from "../../../../db/schema";
import { PVP_RAKE_PCT } from "../../../../lib/games/economy";
import { markDailyRewardWin } from "../../../../lib/dailyRewardWin";
import { payPvpPot, pvpPotPayout } from "../../../../lib/tokens/pvpPot";
import { logError } from "../../../../lib/logError";
import {
  createInitialPoolState,
  poolSeatFor,
  readPoolServerState,
} from "../../../../lib/pool/rack";
import { applyPoolShot, normalizeShotInput } from "../../../../lib/pool/shoot";
import { isPracticePaused } from "../../../../lib/practicePause";

/**
 * POST /api/pool/submit-shot — THE SHOT, AS THE SERVER PLAYS IT.
 *
 * Pool Masters settles coins, so who won cannot be whatever the shooting client
 * says. The shooter still chooses the stroke (angle, pull, spin, and where the
 * cue ball goes down when it has ball in hand); everything after that — the
 * final table, the foul, whose turn is next, which group is whose, and the
 * winner — is computed here from the same rack, the same physics and the same
 * rulebook the page runs (`src/lib/pool/{rack,physics,rules,shoot}.ts`).
 *
 * The match row is the source of truth. It is locked for the whole shot, so two
 * simultaneous submissions cannot both act on the same table, and the shot's
 * result commits with the pot: a win pays out of the escrow both seats paid at
 * join (`payPvpPot`, the shared 2 × stake × 90%), never out of thin air.
 *
 * Free practice is unaffected: an AI seat or a 0 stake moves no coins, but the
 * board is still ruled here so the row's `gameState.winner` is never a client's
 * claim.
 */
const AI_SEAT_ID = "AI";

export async function POST(req: Request) {
  const gate = await requirePracticePlayer();
  if (gate.response) return gate.response;
  const callerId = gate.playerId;

  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const matchId = typeof body?.matchId === "string" ? body.matchId : "";
    const shotId = typeof body?.shotId === "string" ? body.shotId.slice(0, 80) : null;
    const shot = normalizeShotInput(body?.shot);
    if (!matchId || !shot) {
      return NextResponse.json(
        { ok: false, error: "bad_request" },
        { status: 400 },
      );
    }
    if (await isPracticePaused("pool", matchId)) {
      return NextResponse.json(
        { ok: false, error: "match_paused" },
        { status: 409 },
      );
    }

    const outcome = await db.transaction(async (tx) => {
      const [match] = await tx
        .select()
        .from(poolMatches)
        .where(eq(poolMatches.id, matchId))
        .limit(1)
        .for("update");

      if (!match) return { error: "match_not_found", status: 404 } as const;

      const seat = poolSeatFor(match, callerId);
      if (!seat) return { error: "not_a_player", status: 403 } as const;

      // A finished match keeps answering with its final state: a retry, or the
      // settle after a dropped response, must not shoot again.
      if (match.status === "finished") {
        const stored = readPoolServerState(match.gameState);
        if (stored?.winner) {
          return {
            ok: true as const,
            replay: true,
            state: stored,
            winner: stored.winner,
            payout: 0,
          };
        }
        return { error: "match_finished", status: 409 } as const;
      }

      const isAiMatch = match.player2Id === AI_SEAT_ID;
      const stored = readPoolServerState(match.gameState);
      const base =
        stored ??
        createInitialPoolState(
          (match.gameState as { turn?: 1 | 2 } | null)?.turn === 2 ? 2 : 1,
        );

      if (base.winner) {
        return { error: "match_finished", status: 409 } as const;
      }
      if (base.turn !== seat) {
        return { error: "not_your_turn", status: 409 } as const;
      }
      // A retransmitted stroke (the client re-sent after a timeout) is not a
      // second stroke: answer with the state it already produced.
      if (shotId && base.lastShotId === shotId) {
        return { ok: true as const, replay: true, state: base, winner: null, payout: 0 };
      }

      const { state: next, result } = applyPoolShot(base, shot);

      await tx.insert(poolShots).values({
        matchId,
        userId: callerId as string,
        angle: String(shot.angle),
        power: String(shot.pull),
        result: {
          shotId,
          ticks: result.ticks,
          firstContact: result.meta.firstContactNumber,
          pocketed: result.meta.pocketedNumbers,
          scratch: result.meta.cueScratch,
          railAfterContact: result.meta.railAfterContact,
          foul: next.foul ?? false,
          winner: next.winner,
        },
      });

      const version = Date.now();
      const awardedPot = next.winner ? pvpPotPayout(match.wager) : 0;
      const houseFee = next.winner
        ? Math.round(Number(match.wager) * 2 * PVP_RAKE_PCT)
        : 0;
      const nextTurnSeat = next.turn;
      const nextTurnUserId =
        nextTurnSeat === 1 ? match.player1Id : match.player2Id;

      // The row keeps the seat-keyed truth (so the next shot replays from it)
      // AND the mirrored view of the seat that just shot (so the live-sync
      // polling path keeps reading the shape it always has).
      const persisted = {
        ...next,
        started: true,
        ai: isAiMatch,
        perspectiveSeat: seat,
        myTeam: seat === 1 ? next.team1 : next.team2,
        oppTeam: seat === 1 ? next.team2 : next.team1,
        lifecycle: "SETTLED",
        settled: true,
        shotId,
        lastShotId: shotId,
        pocketedNumbers: Array.from(new Set(result.meta.pocketedNumbers)),
        version,
      };

      let payout = 0;
      if (next.winner) {
        const winnerClerkId =
          next.winner === 1 ? match.player1Id : match.player2Id;

        // The server decided this win, so it unlocks the daily reward. An AI
        // win has no `users` row, so it stamps nothing.
        if (winnerClerkId && winnerClerkId !== AI_SEAT_ID) {
          await markDailyRewardWin(tx, winnerClerkId);
        }

        const payable =
          !isAiMatch &&
          Number(match.wager) > 0 &&
          !!winnerClerkId &&
          winnerClerkId !== AI_SEAT_ID;

        if (payable) {
          // The pot only moves inside the transaction that decided the match,
          // so the coins commit with the result that earned them.
          payout = await payPvpPot({
            tx,
            gameKey: "pool",
            matchId,
            winnerClerkId,
            stake: match.wager,
          });
        }

        await tx
          .update(poolMatches)
          .set({
            status: "finished",
            winnerId: winnerClerkId ?? null,
            gameState: persisted,
            currentTurnUserId: null,
            prizePaid: Math.round(payout),
            houseFee,
            endedAt: new Date(),
          })
          .where(eq(poolMatches.id, matchId));
      } else {
        await tx
          .update(poolMatches)
          .set({
            gameState: persisted,
            currentTurnUserId: nextTurnUserId ?? null,
          })
          .where(eq(poolMatches.id, matchId));
      }

      return {
        ok: true as const,
        replay: false,
        state: persisted,
        winner: next.winner,
        payout,
        potPrize: awardedPot,
        houseFee,
      };
    });

    if ("error" in outcome) {
      return NextResponse.json(
        { ok: false, error: outcome.error },
        { status: outcome.status },
      );
    }

    const state = outcome.state as any;
    return NextResponse.json({
      ok: true,
      replay: outcome.replay === true,
      // The caller's view of the board, in the shape the page already reads.
      state: {
        balls: state.balls,
        turn: state.turn,
        myTeam: state.myTeam ?? (state.team1 ?? null),
        oppTeam: state.oppTeam ?? (state.team2 ?? null),
        openTable: state.openTable === true,
        ballInHand: state.ballInHand === true,
        winner: state.winner ?? null,
        version: state.version,
        perspectiveSeat: state.perspectiveSeat,
        foul: state.foul === true,
        foulMessage: state.foulMessage ?? null,
        lifecycle: "SETTLED",
        shotId: state.shotId ?? null,
        settled: true,
        pocketedNumbers: state.pocketedNumbers ?? [],
      },
      winner: outcome.winner ?? null,
      payout: outcome.payout ?? 0,
    });
  } catch (error) {
    await logError({
      errorType: "pool_shot_error",
      errorMessage:
        error instanceof Error ? error.message : "Pool shot failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/pool/submit-shot",
      game: "Pool",
      metadata: { operation: "submit_shot" },
    });
    return NextResponse.json(
      { ok: false, error: "server_error" },
      { status: 500 },
    );
  }
}
