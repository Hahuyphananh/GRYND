import { auth } from "@clerk/nextjs/server";
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
import { broadcastTableUpdate } from "../../../../lib/crash-arena/rooms";
import {
  applyAction,
  openNextCheckpoint,
  expireStaleActions,
  isCrashDueAt,
  resumeFlight,
} from "../../../../lib/crash-poker/roundSystem";
import { checkpointMultiplier as checkpointMultiplierOf } from "../../../../lib/crash-poker/constants";
import { settleCrashPokerHand } from "../../../../lib/crash-poker/settleHand";
import {
  resolveCrashArenaAiBotId,
  isCrashArenaAiBotClerkId,
} from "../../../../lib/crash-arena/aiBot";
import type { CrashPokerHand } from "../../../../lib/crash-poker/types";
import { logError } from "../../../../lib/logError";

/**
 * POST /api/crash-arena/action
 *
 * Body: { roundId, checkpointIndex, action, raiseTo?, forBot? }
 *
 * Server-authoritative betting decision for a Crash Poker hand.
 *
 *   1. Validates the caller (or, on AI practice tables, the bot on the
 *      caller's behalf via `forBot: true`) has an active entry.
 *   2. Validates the checkpoint: either the currently open one, or the next
 *      one once the open one fully resolved (the server opens it lazily —
 *      clients only offer betting once their shared curve crosses the
 *      checkpoint multiplier).
 *   3. Validates the action against the pure rules engine (fold / call /
 *      raise, min-raise = required bet + one big blind, can't double-act
 *      without an intervening raise, can't commit more than the table
 *      balance).
 *   4. Persists to crash_arena_entries + the round's hand state.
 *   5. If a fold leaves exactly one active player the hand ends immediately
 *      and the shared settleCrashPokerHand resolves the fold-out winner.
 *
 * CRASH CUT-OFF (deterministic ordering): the crash moment is fixed
 * server-side — round creation time + the curve's growth rate. An action
 * arriving after that moment is rejected and the hand is settled (post-
 * commit) instead. A betting action racing the crash is therefore ordered
 * by server time, never by network latency: an action that reached the
 * server before the crash counts; one that didn't is refused.
 *
 * RACE SAFETY: the entire read-apply-persist runs inside ONE transaction
 * that takes `SELECT … FOR UPDATE` on the round row. Two players acting at
 * the same checkpoint therefore serialize on that row — the second waiter
 * re-reads the hand state AFTER the first commit, so a simultaneous raise
 * can never clobber the other's contribution / required bet / re-opened
 * action flags. Settlement (fold-out / expiry) runs AFTER the transaction
 * commits so it acquires its own lock instead of self-deadlocking.
 *
 * Returns the updated hand window + the acting player's new contribution.
 */
export async function POST(req: Request) {
  try {
    const { userId: callerId } = await auth();
    if (!callerId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const roundId = Number(body?.roundId);
    const checkpointIndex = Number(body?.checkpointIndex);
    const actionRaw = String(body?.action ?? "");
    const raiseTo = body?.raiseTo != null ? Number(body.raiseTo) : undefined;
    const forBot = Boolean(body?.forBot);
    // For private-table AI seats (multiple bots per table) the client names
    // the exact bot user it is acting for; the server validates it is a
    // reserved bot seat at this table.
    const forBotUserId = body?.forBotUserId != null ? Number(body.forBotUserId) : null;

    if (!Number.isFinite(roundId) || !Number.isFinite(checkpointIndex)) {
      return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });
    }
    if (actionRaw !== "fold" && actionRaw !== "call" && actionRaw !== "raise") {
      return NextResponse.json({ success: false, error: "Invalid action" }, { status: 400 });
    }
    const action = actionRaw as "fold" | "call" | "raise";

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
        // on AI practice tables (mirrors /api/crash-arena/ai-cashout) and on
        // PRIVATE tables where the caller is the host (AIs may only be added
        // to private games, so only their host can drive them).
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

      // ── Acting player's entry + table balance (authoritative under lock) ─
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

      const seatData = await tx
        .select({ balance: crashArenaPlayers.balance })
        .from(crashArenaPlayers)
        .where(
          and(
            eq(crashArenaPlayers.tableId, table.id),
            eq(crashArenaPlayers.userId, actingUserId),
          ),
        )
        .limit(1);

      const seatBalance = Number(seatData[0]?.balance ?? 0);

      // ── Build the hand from the persisted snapshot ──────────────────────
      const rawHand = round.handState;
      if (!rawHand || typeof rawHand !== "object") {
        return {
          ok: false,
          error: "This hand has no Crash Poker state",
          status: 400 as const,
        };
      }
      let hand: CrashPokerHand = rawHand as CrashPokerHand;

      // ── Crash cut-off: if the PAUSE-AWARE curve already reached the
      //    crash point, NO betting action may be accepted — the crash
      //    already happened (the flight stops at betting checkpoints, so
      //    while a window is open the curve is paused below the crash
      //    point and actions are still valid). The settle runs AFTER this
      //    transaction commits (it takes its own row lock, so settling
      //    here would self-deadlock).
      const now = Date.now();
      const crashPointNum = Number(round.crashPoint);
      if (
        Number.isFinite(crashPointNum) &&
        crashPointNum > 0 &&
        isCrashDueAt(hand, now, crashPointNum)
      ) {
        return { ok: false as const, crashDue: true as const, table };
      }

      // ── Stall guard: auto-resolve silent players at the open checkpoint
      //    BEFORE the checkpoint gate so a resolved checkpoint can advance
      //    (server-authoritative — never trust a client timer). Silent
      //    players who owe a call are auto-folded; matched-but-silent
      //    players are auto-checked so the checkpoint still resolves.
      // The acting player is about to submit their own decision — exclude
      // them so the guard can't auto-resolve them a moment before they act.
      const expired = expireStaleActions(hand, now, actingUserId);
      if (expired.autoFolded.length > 0 || expired.autoChecked.length > 0) {
        hand = expired.hand;
        // A deadline auto-resolve that closed the window resumes the flight.
        if (!hand.bettingOpen) hand = resumeFlight(hand, now);
        const foldedIds = new Set(expired.autoFolded);
        const checkedIds = new Set(expired.autoChecked);
        for (const hp of hand.players) {
          const isFolded = foldedIds.has(hp.userId);
          const isChecked = checkedIds.has(hp.userId);
          if (!isFolded && !isChecked) continue;
          const entryRow = await tx
            .select({ id: crashArenaEntries.id })
            .from(crashArenaEntries)
            .where(
              and(
                eq(crashArenaEntries.roundId, roundId),
                eq(crashArenaEntries.userId, hp.userId),
              ),
            )
            .limit(1);
          if (entryRow[0]) {
            await tx
              .update(crashArenaEntries)
              .set({
                lastAction: isFolded ? "fold" : "check",
                foldedAtMultiplier:
                  isFolded && hp.foldedAtMultiplier != null
                    ? String(hp.foldedAtMultiplier)
                    : undefined,
                isActive: isFolded ? false : true,
              })
              .where(eq(crashArenaEntries.id, entryRow[0].id));
          }
        }
      }

      // ── Checkpoint gating ───────────────────────────────────────────────
      const openIndex = Number(hand.checkpointIndex ?? -1);
      if (checkpointIndex === openIndex + 1 && !hand.bettingOpen) {
        hand = openNextCheckpoint(hand);
      }
      if (Number(hand.checkpointIndex ?? -1) !== checkpointIndex) {
        return {
          ok: false,
          error: `Betting is at checkpoint ${hand.checkpointIndex}, not ${checkpointIndex}`,
          status: 400 as const,
        };
      }

      // ── Active check before the engine runs ─────────────────────────────
      const me = hand.players.find((p) => p.userId === actingUserId);
      if (me && !me.isActive) {
        return { ok: false, error: "Not active in this hand", status: 400 as const };
      }

      // ── Apply the action through the pure engine. The seat's table
      //    balance is passed as the authoritative stack, so the engine caps
      //    any call / raise at what the player actually has and marks them
      //    all-in when they commit their whole stack — instead of rejecting.
      //    Client-supplied balances / raise amounts are never trusted. ─────
      const result = applyAction(hand, {
        userId: actingUserId,
        action,
        raiseTo,
        stack: seatBalance,
      });
      if (result.error) {
        return { ok: false, error: result.error, status: 400 as const };
      }
      hand = result.hand;
      // The acting player's decision closed the checkpoint → the flight
      // resumes from the checkpoint multiplier at this moment (pause-aware
      // curve), and everyone who hasn't acted yet would have their window
      // auto-resolved by the sweep / next action.
      if (!hand.bettingOpen) hand = resumeFlight(hand, Date.now());

      // ── Persist acting player's entry + balance deduction + hand window
      //    (same transaction, under the row lock — atomic + serialized). ───
      const actingHandPlayer = hand.players.find((p) => p.userId === actingUserId);
      const wasFold = action === "fold";
      const addedAmount = round2(
        (actingHandPlayer?.contributed ?? 0) - Number(entry.contributed ?? 0),
      );

      await tx
        .update(crashArenaEntries)
        .set({
          contributed: Number(actingHandPlayer?.contributed ?? entry.contributed).toFixed(2),
          lastAction: actingHandPlayer?.lastAction ?? entry.lastAction,
          foldedAtMultiplier: wasFold
            ? actingHandPlayer?.foldedAtMultiplier != null
              ? String(actingHandPlayer.foldedAtMultiplier)
              : null
            : entry.foldedAtMultiplier,
          isActive: wasFold ? false : entry.isActive !== false,
          allIn: Boolean(actingHandPlayer?.allIn ?? entry.allIn),
        })
        .where(eq(crashArenaEntries.id, entry.id));

      // Deduct the added commitment from the table balance (never below 0).
      if (addedAmount > 0) {
        await tx
          .update(crashArenaPlayers)
          .set({ balance: Math.max(0, round2(seatBalance - addedAmount)).toFixed(2) })
          .where(
            and(
              eq(crashArenaPlayers.tableId, table.id),
              eq(crashArenaPlayers.userId, actingUserId),
            ),
          );
      }

      await tx
        .update(crashArenaRounds)
        .set({
          handState: hand,
          checkpointIndex: hand.checkpointIndex,
          requiredBet: hand.requiredBet.toFixed(2),
          bettingOpen: hand.bettingOpen,
        })
        .where(eq(crashArenaRounds.id, roundId));

      return {
        ok: true as const,
        table,
        hand,
        result,
        expired,
        actingHandPlayer,
        entry,
        actingUserId,
      };
    });

    if (!outcome.ok) {
      // The crash beat the action — the hand is due. Settle it now (after
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
          pots: settled.pots,
          returns: settled.returns,
          entries: settled.entries,
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

    const { table, hand, result, expired, actingHandPlayer, actingUserId } = outcome;

    // ── A hand that ended inside the lock (expiry or fold-out) settles now,
    //    AFTER the transaction committed — settleCrashPokerHand takes its
    //    own row lock, so running it here cannot self-deadlock. ─────────────
    let results = null;
    if (expired.handOver || result.handOver) {
      const settled = await settleCrashPokerHand(roundId);
      results = {
        winnerUserId: settled.winnerUserId,
        pot: settled.pot,
        rake: settled.rake,
        payout: settled.payout,
        payoutGross: settled.payoutGross,
        carryOver: settled.carryOver,
        activeAtCrash: settled.activeAtCrash,
        pots: settled.pots,
        returns: settled.returns,
        entries: settled.entries,
        // Absolute epoch-ms of the next round start — every client counts
        // down to the same moment (the settle scheduled it).
        nextRoundAt: settled.nextRoundAt,
      };
    }

    // Best-effort fanout so the whole table sees the action instantly.
    broadcastTableUpdate(table.id, {
      action: {
        userId: actingUserId,
        action: actingHandPlayer?.lastAction ?? action,
        amount: actingHandPlayer?.contributed ?? 0,
        allIn: Boolean(actingHandPlayer?.allIn),
        checkpointIndex: hand.checkpointIndex,
      },
      hand: {
        checkpointIndex: hand.checkpointIndex,
        requiredBet: hand.requiredBet,
        bettingOpen: hand.bettingOpen,
        pot: hand.pot,
        flightResumedAt: hand.flightResumedAt ?? null,
        windowDeadlineAt: hand.windowDeadlineAt ?? null,
      },
      ...(results ? { handOver: true, results } : {}),
      ...(expired.autoFolded.length > 0 ? { autoFolded: expired.autoFolded } : {}),
      ...(expired.autoChecked.length > 0 ? { autoChecked: expired.autoChecked } : {}),
    });

    return NextResponse.json({
      success: true,
      data: {
        roundId,
        checkpointIndex: hand.checkpointIndex,
        currentCheckpointMultiplier: checkpointMultiplierOf(hand.checkpointIndex),
        requiredBet: hand.requiredBet,
        bettingOpen: hand.bettingOpen,
        pot: hand.pot,
        flightResumedAt: hand.flightResumedAt ?? null,
        windowDeadlineAt: hand.windowDeadlineAt ?? null,
        autoFolded: expired.autoFolded.length > 0 ? expired.autoFolded : undefined,
        autoChecked: expired.autoChecked.length > 0 ? expired.autoChecked : undefined,
        action: {
          userId: actingUserId,
          action: actingHandPlayer?.lastAction ?? action,
          contributed: actingHandPlayer?.contributed ?? 0,
          allIn: Boolean(actingHandPlayer?.allIn),
        },
        handOver: Boolean(results),
        ...(results ? { results } : {}),
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
      metadata: { operation: "submit_action" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}

/** Round to 2 decimals (cents). */
function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
