// src/lib/quests/claim.ts
//
// The SERVER SIDE of the quest experience: read the board, and pay a completed
// quest exactly once.
//
// ── What the client may and may not say ─────────────────────────────────────
//
// A claim names ONE thing: the quest row's id. It never names the amount, the
// target, the progress, the period or the completion state — every one of those
// is read from `user_quests`, which only the settlement bridge
// (src/lib/quests/settle.ts) writes. So a forged request can at most ask to
// claim a quest the player has not finished, and that is refused.
//
// ── Paying exactly once ────────────────────────────────────────────────────
//
// A quest reward that can be claimed twice is a coin faucet, so the claim is
// defended three times over, all inside ONE transaction:
//
//   1. `SELECT … FOR UPDATE` on the player's own quest row — a double-click,
//      a retry or two tabs racing all serialize behind the row lock, so the
//      second caller sees the first caller's `claimed = true` and is refused.
//   2. `UPDATE user_quests SET claimed = true … WHERE claimed = false` — the
//      conditional write makes the flag the durable guard even if a future
//      caller forgets the lock.
//   3. one `token_transactions` row keyed
//      `(reference_type, reference_id) = ("quest-reward", "<period>:<key>:<id>")`
//      — the same ledger pattern the daily login reward and the energy grant
//      use, so the payout is auditable after the fact and a replayed reference
//      cannot pay again.
//
// ── The period is part of the identity ────────────────────────────────────
//
// A quest belongs to one UTC day or ISO week. The row's stored `period_key` is
// compared with the period containing "now", so a quest from yesterday CANNOT
// be claimed today: an expired period is refused rather than paid late.
//
// ── No wallet ceiling ─────────────────────────────────────────────────────
//
// The stored reward is paid in full. The retired 100,000-coin wallet cap is
// gone, and nothing here re-introduces a ceiling: a player sitting on a large
// balance is paid exactly what the quest advertised.
//
// Nothing in this module touches Elo, trophies, wagers or the daily login
// reward; the only money movement is the credit itself, through `users.balance`.

import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import { periodBounds, periodKeyFor } from "./periods";
import { canClaimQuest, isQuestComplete, normalizeQuestRow, toQuestView } from "./progress";
import { getQuestBoard } from "./store";
import type { QuestPeriodType, QuestRow, QuestView } from "./types";

/** The ledger `reference_type` a quest payout is recorded under. */
export const QUEST_REWARD_REFERENCE = "quest-reward";

/** The executor is the shared `db` or a transaction around it. */
type QuestDb = any;

export type QuestBoard = {
  daily: QuestView[];
  weekly: QuestView[];
  balance: number;
  /** The period each board belongs to, so the UI can explain the reset. */
  periodKeys: { daily: string; weekly: string };
  /** `[start, end)` instants for the current periods (ISO strings). */
  resets: { dailyStart: string; dailyEnd: string; weeklyStart: string; weeklyEnd: string };
};

export type QuestStatusResult =
  | ({ ok: true } & QuestBoard)
  | { ok: false; error: string; status: number };

export type QuestClaimSuccess = {
  ok: true;
  credited: number;
  balance: number;
  quest: QuestView;
  board: QuestBoard;
};

export type QuestClaimFailure = {
  ok: false;
  error: string;
  status: number;
  /** Machine-readable reason, so the client can render the right state. */
  reason:
    | "unauthenticated"
    | "invalid-quest"
    | "not-found"
    | "incomplete"
    | "already-claimed"
    | "expired";
};

export type QuestClaimResult = QuestClaimSuccess | QuestClaimFailure;

function boardFrom(
  daily: QuestView[],
  weekly: QuestView[],
  balance: number,
  now: Date,
): QuestBoard {
  const dailyBounds = periodBounds("daily", now);
  const weeklyBounds = periodBounds("weekly", now);
  return {
    daily,
    weekly,
    balance,
    periodKeys: {
      daily: periodKeyFor("daily", now),
      weekly: periodKeyFor("weekly", now),
    },
    resets: {
      dailyStart: dailyBounds.start.toISOString(),
      dailyEnd: dailyBounds.end.toISOString(),
      weeklyStart: weeklyBounds.start.toISOString(),
      weeklyEnd: weeklyBounds.end.toISOString(),
    },
  };
}

/** The player's row id + balance, by Clerk id (the session's identity). */
async function resolvePlayer(
  clerkId: string,
  exec: QuestDb,
): Promise<{ id: number; balance: number } | null> {
  const found = await exec.execute(sql`
    SELECT id, balance FROM users WHERE clerk_id = ${clerkId} LIMIT 1
  `);
  const row = (found.rows ?? found)[0];
  if (!row) return null;
  return { id: Number(row.id), balance: Number(row.balance ?? 0) };
}

/**
 * The signed-in player's daily + weekly board.
 *
 * Creates the period's slots on first read (the store's deterministic planner,
 * `ON CONFLICT DO NOTHING`), so a brand-new player sees quests immediately and
 * a settlement that arrives first still lands in the slots this read shows.
 */
export async function getQuestStatus({
  clerkId,
  now = new Date(),
  tx,
}: {
  clerkId: string | null | undefined;
  now?: Date;
  tx?: QuestDb;
}): Promise<QuestStatusResult> {
  if (!clerkId) {
    return { ok: false, error: "Not authenticated", status: 401 };
  }

  const exec = tx ?? db;
  const player = await resolvePlayer(clerkId, exec);
  if (!player) {
    return { ok: false, error: "User not found", status: 404 };
  }

  const board = await getQuestBoard(player.id, { now, tx: exec });
  return {
    ok: true,
    ...boardFrom(board.daily, board.weekly, player.balance, now),
  };
}

/**
 * Claim one completed quest for the signed-in player.
 *
 * `clerkId` MUST come from the authenticated session; `questId` is the only
 * client-supplied value, and it is looked up scoped to that player's own rows.
 */
export async function claimQuestReward({
  clerkId,
  questId,
  now = new Date(),
  tx,
}: {
  clerkId: string | null | undefined;
  questId: unknown;
  now?: Date;
  tx?: QuestDb;
}): Promise<QuestClaimResult> {
  if (!clerkId) {
    return {
      ok: false,
      error: "Not authenticated",
      status: 401,
      reason: "unauthenticated",
    };
  }

  const id = Number(questId);
  if (!Number.isInteger(id) || id <= 0) {
    return {
      ok: false,
      error: "A valid quest is required",
      status: 400,
      reason: "invalid-quest",
    };
  }

  const run = async (exec: QuestDb): Promise<QuestClaimResult> => {
    const player = await resolvePlayer(clerkId, exec);
    if (!player) {
      return {
        ok: false,
        error: "User not found",
        status: 404,
        reason: "not-found",
      };
    }

    // ── Lock the player's OWN row ────────────────────────────────────
    // The `user_id` predicate is what stops a client claiming somebody
    // else's quest by guessing an id: a row that is not theirs simply does
    // not exist for this request.
    const locked = await exec.execute(sql`
      SELECT id, user_id, period_type, period_key, slot, quest_type,
             game_key, target, reward, progress, claimed, meta,
             completed_at AS "completedAt"
        FROM user_quests
       WHERE id = ${id} AND user_id = ${player.id}
         FOR UPDATE
    `);
    const stored = (locked.rows ?? locked)[0];
    if (!stored) {
      return {
        ok: false,
        error: "Quest not found",
        status: 404,
        reason: "not-found",
      };
    }

    const row: QuestRow = normalizeQuestRow(stored);

    // ── The active period, not just "a row exists" ───────────────────
    // Yesterday's finished-but-unclaimed quest stays in the table as history
    // and must never pay today. The stored key is the period identity, so the
    // comparison cannot drift with a boundary calculation.
    if (row.periodType !== "daily" && row.periodType !== "weekly") {
      return { ok: false, error: "Quest not found", status: 404, reason: "not-found" };
    }
    if (row.periodKey !== periodKeyFor(row.periodType as QuestPeriodType, now)) {
      return {
        ok: false,
        error: "This quest has expired",
        status: 409,
        reason: "expired",
      };
    }

    // ── Completed and unclaimed ──────────────────────────────────────
    if (row.claimed) {
      return {
        ok: false,
        error: "Already claimed",
        status: 409,
        reason: "already-claimed",
      };
    }
    if (!isQuestComplete(row) || !canClaimQuest(row)) {
      return {
        ok: false,
        error: "This quest is not complete yet",
        status: 409,
        reason: "incomplete",
      };
    }

    const reward = Math.floor(Number(row.reward));
    if (!Number.isFinite(reward) || reward <= 0) {
      // A stored row with no positive reward is a data fault, not something a
      // claim may invent an amount for.
      return {
        ok: false,
        error: "This quest has no reward",
        status: 409,
        reason: "incomplete",
      };
    }

    // ── Ledger idempotency ───────────────────────────────────────────
    // The same durable key the daily reward and energy grant use. The row lock
    // above already serializes a double-click; this is the audit trail and the
    // second line of defence if a future caller claims without the lock.
    const referenceId = `${row.periodType}:${row.periodKey}:${id}`;
    const existing = await exec.execute(sql`
      SELECT id FROM token_transactions
       WHERE reference_type = ${QUEST_REWARD_REFERENCE}
         AND reference_id = ${referenceId}
       LIMIT 1
    `);
    if ((existing.rows ?? existing).length > 0) {
      return {
        ok: false,
        error: "Already claimed",
        status: 409,
        reason: "already-claimed",
      };
    }

    // ── Mark it claimed (conditional write) ──────────────────────────
    const marked = await exec.execute(sql`
      UPDATE user_quests
         SET claimed = true
       WHERE id = ${id} AND claimed = false
       RETURNING id
    `);
    if ((marked.rows ?? marked).length === 0) {
      return {
        ok: false,
        error: "Already claimed",
        status: 409,
        reason: "already-claimed",
      };
    }

    // ── Credit the stored amount, in full ────────────────────────────
    // One atomic increment on the canonical balance, with the same peak-balance
    // high-water mark every other credit writes. No wallet ceiling: the claim
    // pays what the quest advertised, whatever the player already holds.
    const [credited] = await exec.execute(sql`
      UPDATE users
         SET balance = balance + ${reward},
             peak_balance = GREATEST(peak_balance, balance + ${reward})
       WHERE id = ${player.id}
       RETURNING balance
    `).then((result: any) => result.rows ?? result);

    if (!credited) {
      throw new Error("Quest credit failed");
    }
    const balance = Number(credited.balance);

    await exec.execute(sql`
      INSERT INTO token_transactions
        (clerk_id, type, amount, reference_type, reference_id, note)
      VALUES
        (${clerkId}, ${"reward"}, ${reward}, ${QUEST_REWARD_REFERENCE},
         ${referenceId}, ${`Quest reward (${row.periodType} ${row.periodKey})`})
    `);

    // ── The fresh board, so the response is the new truth ────────────
    const board = await getQuestBoard(player.id, { now, tx: exec });
    const claimedRow: QuestRow = { ...row, claimed: true };

    return {
      ok: true,
      credited: reward,
      balance,
      quest: toQuestView(claimedRow),
      board: boardFrom(board.daily, board.weekly, balance, now),
    };
  };

  return tx ? run(tx) : db.transaction(run);
}
