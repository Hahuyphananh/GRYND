import { db } from "../../../../db/client";
import {
  users,
  crashArenaTables,
  crashArenaPlayers,
  crashArenaRounds,
  crashArenaEntries,
} from "../../../../db/schema";
import { eq, and } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { broadcastTableUpdate } from "../../../../lib/crash-arena/rooms";
import {
  applyFold,
  curveMultiplierAt,
  isCrashDueAt,
  pauseHandOnFold,
} from "../../../../lib/crash-poker/roundSystem";
import { settleCrashPokerHand } from "../../../../lib/crash-poker/settleHand";
import {
  roundMoney,
  FOLD_PAUSE_MS,
  FOLD_OUT_SETTLE_GRACE_MS,
} from "../../../../lib/crash-poker/constants";
import {
  resolveCrashArenaAiBotId,
  isCrashArenaAiBotClerkId,
} from "../../../../lib/crash-arena/aiBot";
import type { CrashPokerHand } from "../../../../lib/crash-poker/types";
import { logError } from "../../../../lib/logError";

/**
 * POST /api/crash-arena/action
 *
 * Body: { roundId, action: "fold", forBot?, forBotUserId? }
 *
 * Server-authoritative FOLD for a Crash Arena hand. Folding is the ONLY
 * action in the game — anyone can fold at ANY moment (no checkpoints, no
 * deadlines), and the fold's multiplier is the server-authoritative curve
 * value at the moment the server accepts it.
 *
 *   1. Validates the caller (or, on AI practice tables, the bot on the
 *      caller's behalf via `forBot: true`) has an active entry.
 *   2. Rejects any action once the curve has reached the crash point —
 *      the hand is settled instead (ordering by server time, never
 *      network latency).
 *   3. Computes the fold multiplier from the deterministic curve at the
 *      server's current time and applies the fold through the pure engine.
 *   4. Persists to crash_arena_entries + the round's hand state.
 *   5. If the fold leaves exactly one active player the hand is OVER
 *      (fold-out): the curve freezes for FOLD_PAUSE_MS plus a settle grace
 *      and the hand is stamped settlePendingAt — the crash-check sweep
 *      resolves the ranked payouts at that deadline and broadcasts the
 *      results. The action route never settles the hand itself.
 *
 * FOLD-OUT DEFER (race safety): a fold-out used to settle in this route,
 * but two seats folding back-to-back raced the fold-pause accounting and
 * the hand-ends-now settle. Now a fold-out just freezes the curve with a
 * settlePendingAt deadline, exactly like a normal pause — every later
 * action is rejected while the deadline is pending, and the SINGLE crash
 * sweep (the only writer past the deadline) settles + broadcasts once.
 *
 * CRASH CUT-OFF (deterministic ordering): the crash moment is fixed
 * server-side — round creation time + the curve's growth rate. An action
 * arriving after that moment is rejected and the hand is settled (post-
 * commit) instead. A fold racing the crash is therefore ordered by server
 * time, never by network latency: a fold that reached the server before
 * the crash counts; one that didn't is refused.
 *
 * RACE SAFETY: the entire read-apply-persist runs inside ONE transaction
 * that takes `SELECT … FOR UPDATE` on the round row. Concurrent folds
 * serialize on that row, so the fold log stays chronological and the
 * fold-out settle can't be double-triggered. Settlement (fold-out)
 * runs AFTER the transaction commits so it acquires its own lock instead
 * of self-deadlocking.
 *
 * Returns the updated fold state + the acting player's entry.
 */
export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;
    const callerId = gate.userId;

    const body = await req.json().catch(() => ({}));
    const roundId = Number(body?.roundId);
    const actionRaw = String(body?.action ?? "");
    const forBot = Boolean(body?.forBot);
    // For private-table AI seats (multiple bots per table) the client names
    // the exact bot user it is acting for; the server validates it is a
    // reserved bot seat at this table.
    const forBotUserId = body?.forBotUserId != null ? Number(body.forBotUserId) : null;

    if (!Number.isFinite(roundId)) {
      return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });
    }
    if (actionRaw !== "fold") {
      return NextResponse.json({
        success: false,
        error: "Invalid action — Crash Arena only supports folding",
      }, { status: 400 });
    }

    // ── Caller identity (stable — safe outside the lock) ─────────────────
    const callerData = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, callerId))
      .limit(1);
    if (!callerData.length) {
      return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });
    }
    const caller = callerData[0];

    // ── THE LOCKED TRANSACTION: read → validate → apply → persist ─────────
    const outcome = await db.transaction(async (tx) => {
      // Serialize every action on this hand: concurrent requests block here
      // and re-read the hand AFTER the previous action committed.
      const roundData = await tx
        .select()
        .from(crashArenaRounds)
        .where(eq(crashArenaRounds.id, roundId))
        .limit(1)
        .for("update");

      if (!roundData.length) {
        return { ok: false, error: "Round not found", status: 404 as const };
      }
      const round = roundData[0];
      if (round.status !== "running") {
        return { ok: false, error: "Hand is not active", status: 400 as const };
      }

      const tableDataLocked = await tx
        .select()
        .from(crashArenaTables)
        .where(eq(crashArenaTables.id, round.tableId))
        .limit(1);
      if (!tableDataLocked.length) {
        return { ok: false, error: "Table not found", status: 404 as const };
      }
      const table = tableDataLocked[0];

      // ── Resolve who is acting ───────────────────────────────────────────
      let actingUserId = caller.id;
      if (forBot) {
        // Bots have no account — the seated human acts on their behalf. Allowed
        // on AI practice tables and on PRIVATE tables where the caller is the
        // host (AIs may only be added to private games, so only their host can
        // drive them).
        const isPractice = table.isAi;
        const isPrivateHost = Boolean(table.isPrivate && table.hostId === caller.id);
        if (!isPractice && !isPrivateHost) {
          return {
            ok: false,
            error: "Bots can only be driven by the host of a private table",
            status: 400 as const,
          };
        }
        const callerSeat = await tx
          .select({ id: crashArenaPlayers.id })
          .from(crashArenaPlayers)
          .where(
            and(
              eq(crashArenaPlayers.tableId, table.id),
              eq(crashArenaPlayers.userId, caller.id),
              eq(crashArenaPlayers.status, "seated"),
            ),
          )
          .limit(1);
        if (!callerSeat.length) {
          return { ok: false, error: "Not seated at this table", status: 400 as const };
        }
        let botId: number | null = null;
        if (isPractice) {
          botId = await resolveCrashArenaAiBotId();
        } else if (forBotUserId != null && Number.isFinite(forBotUserId)) {
          // Private table: the client names the bot seat; validate it is a
          // reserved bot user seated at THIS table.
          const botUser = await tx
            .select({ id: users.id, clerkId: users.clerkId })
            .from(users)
            .where(eq(users.id, forBotUserId))
            .limit(1);
          if (!botUser[0] || !isCrashArenaAiBotClerkId(botUser[0].clerkId)) {
            return { ok: false, error: "Not a bot user", status: 400 as const };
          }
          const botSeat = await tx
            .select({ id: crashArenaPlayers.id })
            .from(crashArenaPlayers)
            .where(
              and(
                eq(crashArenaPlayers.tableId, table.id),
                eq(crashArenaPlayers.userId, forBotUserId),
                eq(crashArenaPlayers.status, "seated"),
              ),
            )
            .limit(1);
          if (!botSeat.length) {
            return { ok: false, error: "Bot not seated at this table", status: 400 as const };
          }
          botId = forBotUserId;
        }
        if (botId == null) {
          return { ok: false, error: "AI bot not found", status: 404 as const };
        }
        actingUserId = botId;
      }

      // ── Acting player's entry ───────────────────────────────────────────
      const entryData = await tx
        .select()
        .from(crashArenaEntries)
        .where(
          and(
            eq(crashArenaEntries.roundId, roundId),
            eq(crashArenaEntries.userId, actingUserId),
          ),
        )
        .limit(1);

      if (!entryData.length) {
        return { ok: false, error: "Not entered in this hand", status: 400 as const };
      }
      const entry = entryData[0];

      if (entry.result !== "pending") {
        return { ok: false, error: "Already resolved this hand", status: 400 as const };
      }

      // ── Build the hand from the persisted snapshot ──────────────────────
      const rawHand = round.handState;
      if (!rawHand || typeof rawHand !== "object") {
        return {
          ok: false,
          error: "This hand has no Crash Arena state",
          status: 400 as const,
        };
      }
      const hand: CrashPokerHand = rawHand as CrashPokerHand;

      // ── Crash cut-off: if the continuous curve already reached the crash
      //    point, NO fold may be accepted — the crash already happened. The
      //    settle runs AFTER this transaction commits (it takes its own row
      //    lock, so settling here would self-deadlock).
      const now = Date.now();

      // The curve may not have started climbing yet — the new round's hint
      // window delays the anchor (startedAt = now + CRASH_START_DELAY_MS).
      // Accepting a fold now would let a player farm the 1.00x floor the
      // moment money is posted. Folds open once the anchor is reached.
      if (now < Number(hand.flightResumedAt ?? 0)) {
        return {
          ok: false,
          error: "The round hasn't started yet",
          status: 400 as const,
        };
      }

      // A fold-out is being resolved: the hand froze at its settlePendingAt
      // deadline and the crash-check sweep owns settlement from here on.
      // Reject any further action so nothing corrupts the pending payout.
      if (hand.settlePendingAt != null) {
        return {
          ok: false,
          error: "The hand is ending",
          status: 400 as const,
        };
      }

      const crashPointNum = Number(round.crashPoint);
      if (
        Number.isFinite(crashPointNum) &&
        crashPointNum > 0 &&
        isCrashDueAt(hand, now, crashPointNum)
      ) {
        return { ok: false as const, crashDue: true as const, table };
      }

      const me = hand.players.find((p) => p.userId === actingUserId);
      if (!me || !me.isActive) {
        return { ok: false, error: "Not active in this hand", status: 400 as const };
      }

      // ── Apply the fold through the pure engine. The fold multiplier is
      //    the server-authoritative curve value at THIS moment — a client
      //    can never report its own multiplier. ───────────────────────────
      const foldMultiplier = curveMultiplierAt(hand, now);
      const result = applyFold(hand, {
        userId: actingUserId,
        multiplier: foldMultiplier,
      });
      if (result.error) {
        return { ok: false, error: result.error, status: 400 as const };
      }
      const nextHand = result.hand;

      // ── Fold pause (server-authoritative freeze): an accepted fold
      //    freezes the shared curve so every player gets time to read the
      //    reveal. The pause window is persisted with the hand (the
      //    crash-clock math runs through it) and broadcast to every client
      //    as an ABSOLUTE `until` deadline, so all clients freeze at the
      //    exact same frozen multiplier for the exact same window.
      //    A NON-fold-out pause lasts FOLD_PAUSE_MS and then the flight
      //    resumes. A fold-out pause lasts FOLD_PAUSE_MS plus a settle
      //    grace; it also stamps settlePendingAt so the crash-check sweep
      //    settles the hand AT the pause deadline instead of this route —
      //    one writer, one broadcast, no fold-out/pause race.
      let pause: { from: number; until: number; handOver?: boolean } | null = null;
      let persistedHand;
      if (result.handOver) {
        persistedHand = pauseHandOnFold(
          nextHand,
          now,
          FOLD_PAUSE_MS + FOLD_OUT_SETTLE_GRACE_MS,
        );
        persistedHand = {
          ...persistedHand,
          settlePendingAt: Number(persistedHand.pausedUntil),
        };
        pause = {
          from: roundMoney(foldMultiplier),
          until: Number(persistedHand.pausedUntil),
          handOver: true,
        };
      } else {
        persistedHand = pauseHandOnFold(nextHand, now);
        pause = {
          from: roundMoney(foldMultiplier),
          until: Number(persistedHand.pausedUntil),
        };
      }

      // ── Persist the fold (same transaction, under the row lock). ───────
      const actingHandPlayer = nextHand.players.find((p) => p.userId === actingUserId);
      await tx
        .update(crashArenaEntries)
        .set({
          lastAction: "fold",
          foldedAtMultiplier:
            actingHandPlayer?.foldedAtMultiplier != null
              ? String(actingHandPlayer.foldedAtMultiplier)
              : null,
          isActive: false,
        })
        .where(eq(crashArenaEntries.id, entry.id));

      await tx
        .update(crashArenaRounds)
        .set({
          handState: persistedHand,
        })
        .where(eq(crashArenaRounds.id, roundId));

      return {
        ok: true as const,
        table,
        hand: nextHand,
        result,
        actingHandPlayer,
        actingUserId,
        pause,
      };
    });

    if (!outcome.ok) {
      // The crash beat the fold — the hand is due. Settle it now (after
      // the transaction committed) and tell the acting player the hand
      // ended, with the authoritative results attached.
      if (outcome.crashDue) {
        const settled = await settleCrashPokerHand(roundId);
        const results = {
          winnerUserId: settled.winnerUserId,
          pot: settled.pot,
          rake: settled.rake,
          payout: settled.payout,
          payoutGross: settled.payoutGross,
          carryOver: settled.carryOver,
          activeAtCrash: settled.activeAtCrash,
          payouts: settled.payouts,
          entries: settled.entries,
          signals: settled.signals,
          // Absolute epoch-ms of the next round start — every client counts
          // down to the same moment (the settle scheduled it).
          nextRoundAt: settled.nextRoundAt,
        };
        broadcastTableUpdate(outcome.table.id, {
          crashed: true,
          multiplier: settled.crashPoint,
          handOver: true,
          results,
        });
        return NextResponse.json({
          success: true,
          data: {
            roundId,
            handOver: true,
            crashed: true,
            crashMultiplier: settled.crashPoint,
            results,
          },
        });
      }
      return NextResponse.json(
        { success: false, error: outcome.error },
        { status: outcome.status },
      );
    }

    const { table, hand, result, actingHandPlayer, actingUserId, pause } = outcome;

    // A fold-out is NOT settled here — the transaction above froze the
    // curve with a settlePendingAt deadline; the crash-check sweep settles
    // it at that deadline and broadcasts the results (one consistent
    // broadcast instead of a per-fold settle + a pause nailed to it). No
    // results are attached to this fold.

    // Best-effort fanout so the whole table sees the fold instantly. The
    // folding player's PRIVATE insight is now public — folded equals shown.
    // A fold-out carries `handOver: true` + the freeze pause (no results);
    // a normal fold carries just the pause.
    broadcastTableUpdate(table.id, {
      action: {
        userId: actingUserId,
        action: "fold",
        contributed: actingHandPlayer?.contributed ?? 0,
        foldedAtMultiplier: actingHandPlayer?.foldedAtMultiplier ?? null,
        signal: actingHandPlayer?.signal ?? null,
      },
      // Absolute pause window every client freezes inside.
      ...(pause ? { pause } : {}),
      ...(result.handOver ? { handOver: true } : {}),
    });

    return NextResponse.json({
      success: true,
      data: {
        roundId,
        action: {
          userId: actingUserId,
          action: "fold",
          contributed: actingHandPlayer?.contributed ?? 0,
          foldedAtMultiplier: actingHandPlayer?.foldedAtMultiplier ?? null,
          signal: actingHandPlayer?.signal ?? null,
        },
        ...(pause ? { pause } : {}),
        handOver: Boolean(result.handOver),
      },
    });
  } catch (err) {
    console.error("[crash-arena:action]", err);
    await logError({
      errorType: "crash_arena_action_error",
      errorMessage: err instanceof Error ? err.message : "Crash Arena action failed",
      stackTrace: err instanceof Error ? err.stack : undefined,
      endpoint: "/api/crash-arena/action",
      game: "Crash Arena",
      metadata: { operation: "submit_fold" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}