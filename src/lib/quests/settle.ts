// src/lib/quests/settle.ts
//
// THE SETTLEMENT BRIDGE — the only way a match result may reach a quest.
//
// WHY THIS IS A SEPARATE MODULE FROM ./store
//   `./store` creates and reads slots. This module WRITES progress, and it may
//   only be called from inside a server-side settlement transaction, with the
//   ids of two REAL accounts. Keeping it apart means "can this progress?" and
//   "who is allowed to say so?" are two reviewable things.
//
// WHAT PROVES ELIGIBILITY
//   The caller hands over one seat per participant. A seat is only accepted when
//     * `userId` and `opponentUserId` are two DIFFERENT positive integers,
//     * both are real `users` rows — enforced by the foreign keys on
//       `quest_match_events`, which a bot / AI / practice seat cannot satisfy
//       because it holds no account at all,
//     * `outcome` is one of win/loss/draw, i.e. a result the settlement layer
//       decided (this function never computes an outcome, it only records one),
//     * `gameKey` normalizes to a canonical quest game.
//   A caller that cannot name a human opponent cannot construct a seat, and a
//   seat that fails any check is dropped — it is never guessed at.
//
// ONCE PER MATCH, PER PARTICIPANT
//   `quest_match_events` has UNIQUE (user_id, game_key, match_id), and the row is
//   inserted in the same transaction as the progress update. Insert-first, then
//   advance only for the participants the insert actually returned, means a
//   retried settlement, a re-sent terminal event or two racing settlements all
//   converge on exactly one counted match — durably, in Postgres, not in a
//   process-local flag.
//
// WITHIN THE SETTLEMENT TRANSACTION
//   The caller passes the transaction that finishes the match (`tx` from
//   applyRatingResult / applyPlacementTrophies / the UNO settle route). Quest
//   rows are then advanced under `SELECT … FOR UPDATE`, so two DIFFERENT matches
//   settling for the same player at the same moment cannot lose an increment,
//   and a rollback of the match also rolls back the progress. When no
//   transaction is supplied the module opens its own, exactly like the rating
//   and trophy writers.
//
// WHAT IT NEVER TOUCHES
//   Elo, trophies, wagers, payouts and the leaderboards. It writes quest slots
//   and its own journal, nothing else. Rewards stay unclaimed: a completed quest
//   is only made claimable here; paying it belongs to the claim path.

import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import { buildQuestRows } from "./definitions";
import { canonicalQuestGame } from "./games";
import { periodKeyFor } from "./periods";
import { advanceQuest, normalizeQuestRow } from "./progress";
import type {
  QuestMatchEvidence,
  QuestMatchOutcome,
  QuestPeriodType,
  QuestRow,
} from "./types";

/**
 * The shared `db` or a transaction around it — typed loosely for the same
 * reason as src/lib/rating.js and src/lib/tokens/*: both expose the same
 * `execute`/query surface, and the settlement path must be able to pass
 * whichever one it holds.
 */
type QuestDb = any;

/** Longest authoritative match id the journal column stores. */
export const QUEST_MATCH_ID_MAX_LENGTH = 128;

/** The only outcomes a settlement may hand over. */
export const QUEST_SETTLEMENT_OUTCOMES: readonly QuestMatchOutcome[] = [
  "win",
  "loss",
  "draw",
];

const PERIOD_TYPES: readonly QuestPeriodType[] = ["daily", "weekly"];

/** One participant's seat in a settled match. */
export type QuestSettlementSeat = {
  /** `users.id` of the participant (never a clerk id, never a display name). */
  userId: number | null | undefined;
  /** `users.id` of the human opponent, or null when there was none. */
  opponentUserId: number | null | undefined;
  /** The result the settlement layer decided for this seat. */
  outcome: QuestMatchOutcome;
};

export type QuestSettlementReason =
  | "recorded"
  | "duplicate"
  | "unknown-game"
  | "invalid-match"
  | "no-participants";

export type QuestSettlementResult = {
  /** True when at least one seat was newly journaled for this match. */
  recorded: boolean;
  reason: QuestSettlementReason;
  /** Canonical game id the match was counted under (null when rejected). */
  game: string | null;
  /** Participants the journal accepted on THIS call (empty on a replay). */
  recordedUserIds: number[];
  /** Participants whose slots were advanced on this call. */
  advancedUserIds: number[];
  /** How many quest slots moved (summed across both periods). */
  advancedQuests: number;
};

function toId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The seats a settlement may actually journal.
 *
 * Exported because "which of these seats is a real human-vs-human result?" is a
 * rule worth testing on its own, without a database. Every rejection is silent
 * by design: a caller passes the seats the match has, and the ones that cannot
 * prove a human opponent simply do not count.
 */
export function normalizeSettlementSeats(
  seats: readonly QuestSettlementSeat[] | null | undefined,
): Array<{ userId: number; opponentUserId: number; outcome: QuestMatchOutcome }> {
  const accepted: Array<{
    userId: number;
    opponentUserId: number;
    outcome: QuestMatchOutcome;
  }> = [];
  const seen = new Set<number>();

  for (const seat of Array.isArray(seats) ? seats : []) {
    const userId = toId(seat?.userId);
    const opponentUserId = toId(seat?.opponentUserId);
    if (!userId || !opponentUserId) continue;
    // A seat playing itself is not a match (an AI game that stamped the human
    // into both slots, a duplicated seat, a corrupt row).
    if (userId === opponentUserId) continue;
    if (!QUEST_SETTLEMENT_OUTCOMES.includes(seat?.outcome)) continue;
    if (seen.has(userId)) continue;
    seen.add(userId);
    accepted.push({ userId, opponentUserId, outcome: seat.outcome });
  }

  // Ascending user id: the quest rows are locked in this order, so two
  // settlements involving the same pair cannot deadlock on each other.
  return accepted.sort((a, b) => a.userId - b.userId);
}

function eventRowsSql(
  seats: Array<{ userId: number; opponentUserId: number; outcome: QuestMatchOutcome }>,
  game: string,
  matchId: string,
) {
  return sql.join(
    seats.map(
      (seat) =>
        sql`(${seat.userId}, ${game}, ${matchId}, ${seat.opponentUserId}, ${seat.outcome})`,
    ),
    sql`, `,
  );
}

function slotRowsSql(rows: QuestRow[], periodType: QuestPeriodType, periodKey: string) {
  return sql.join(
    rows.map(
      (row) => sql`(${row.userId}, ${periodType}, ${periodKey}, ${row.slot}, ${
        row.questType
      }, ${row.gameKey}, ${row.target}, ${row.reward}, ${row.progress}, ${
        row.claimed
      }, ${JSON.stringify(row.meta ?? {})}::jsonb)`,
    ),
    sql`, `,
  );
}

function updateRowsSql(
  rows: Array<{ id: number; progress: number; completedAt: Date | null; meta: string }>,
) {
  return sql.join(
    rows.map(
      (row) =>
        sql`(${row.id}::bigint, ${row.progress}::numeric, ${
          row.completedAt
        }::timestamp, ${row.meta}::jsonb)`,
    ),
    sql`, `,
  );
}

/**
 * Record one settled match for every seat it can prove, then advance the
 * current daily + weekly slots of those participants.
 *
 * Call this from INSIDE the settlement transaction that finishes the match, with
 * the ids of the real accounts that played it. It is safe to call again with the
 * same match id: the second call reports `duplicate` and moves nothing.
 */
export async function recordSettledMatch({
  tx,
  gameKey,
  matchId,
  seats,
  now = new Date(),
}: {
  tx?: QuestDb;
  gameKey: string;
  matchId: string;
  seats: readonly QuestSettlementSeat[];
  now?: Date;
}): Promise<QuestSettlementResult> {
  const empty: Omit<QuestSettlementResult, "reason"> = {
    recorded: false,
    game: null,
    recordedUserIds: [],
    advancedUserIds: [],
    advancedQuests: 0,
  };

  const game = canonicalQuestGame(gameKey);
  if (!game) return { ...empty, reason: "unknown-game" };

  const id = typeof matchId === "string" ? matchId.trim() : "";
  if (id.length === 0 || id.length > QUEST_MATCH_ID_MAX_LENGTH) {
    return { ...empty, reason: "invalid-match" };
  }

  const accepted = normalizeSettlementSeats(seats);
  if (accepted.length === 0) return { ...empty, reason: "no-participants" };

  const periodKeys: Record<QuestPeriodType, string> = {
    daily: periodKeyFor("daily", now),
    weekly: periodKeyFor("weekly", now),
  };

  const run = async (txc: QuestDb): Promise<QuestSettlementResult> => {
    // ── 0. Every seat must name REAL accounts ─────────────────────────
    // `users.id` lookups, not client claims: an AI seat, a bot id ("AI_BOT",
    // "chess_ai_bot") or a deleted account simply is not in this set, so its
    // seat is dropped instead of counted or allowed to break the settlement it
    // arrived with. The journal's foreign keys enforce the same thing again on
    // write.
    const referencedIds = Array.from(
      new Set(accepted.flatMap((seat) => [seat.userId, seat.opponentUserId])),
    );
    const known = await txc.execute(sql`
      SELECT id FROM users
       WHERE id IN (${sql.join(
         referencedIds.map((value) => sql`${value}`),
         sql`, `,
       )})
    `);
    const knownUserIds = new Set(
      (known.rows ?? known).map((row: any) => Number(row.id)),
    );
    const eligibleSeats = accepted.filter(
      (seat) =>
        knownUserIds.has(seat.userId) && knownUserIds.has(seat.opponentUserId),
    );
    if (eligibleSeats.length === 0) {
      return { ...empty, game, reason: "no-participants" };
    }

    // ── 1. Durable idempotency ────────────────────────────────────────
    // One row per participant per match, inserted inside the settlement
    // transaction. `RETURNING` says exactly which seats are NEW, and only those
    // may move progress — a replay returns nothing and stops here.
    const journal = await txc.execute(sql`
      INSERT INTO quest_match_events
        (user_id, game_key, match_id, opponent_user_id, outcome)
      VALUES ${eventRowsSql(eligibleSeats, game, id)}
      ON CONFLICT (user_id, game_key, match_id) DO NOTHING
      RETURNING user_id
    `);

    const freshUserIds = new Set(
      (journal.rows ?? journal).map((row: any) => Number(row.user_id ?? row.userId)),
    );
    const freshSeats = eligibleSeats.filter((seat) => freshUserIds.has(seat.userId));
    if (freshSeats.length === 0) {
      return { ...empty, game, reason: "duplicate" };
    }

    const advancedUserIds: number[] = [];
    let advancedQuests = 0;

    for (const seat of freshSeats) {
      // The evidence a seat carries is complete by construction: a real
      // account, a DIFFERENT real opponent account (both FK-checked), and a
      // decided outcome. `completed` is what the caller's terminal write
      // already proved — this function is never reachable from a live or
      // cancelled match.
      const evidence: QuestMatchEvidence = {
        matchId: id,
        gameKey: game,
        opponentKind: "human",
        completed: true,
        outcome: seat.outcome,
      };

      // Keyed by slot row id: a row can only be advanced once per match, and
      // built this way a duplicated id can never be written twice.
      const updates = new Map<
        number,
        { id: number; progress: number; completedAt: Date | null; meta: string }
      >();

      for (const periodType of PERIOD_TYPES) {
        const periodKey = periodKeys[periodType];

        // ── 2. Make sure the period's slots exist ─────────────────────
        // Same deterministic planner the read path uses, so a settlement that
        // arrives before the player ever opened the quest board still lands in
        // the slots they will see. ON CONFLICT keeps a concurrent create (or a
        // previous settlement) from duplicating a slot.
        const drafts = buildQuestRows({ userId: seat.userId, periodType, periodKey });
        if (drafts.length > 0) {
          await txc.execute(sql`
            INSERT INTO user_quests
              (user_id, period_type, period_key, slot, quest_type, game_key,
               target, reward, progress, claimed, meta)
            VALUES ${slotRowsSql(drafts, periodType, periodKey)}
            ON CONFLICT (user_id, period_type, period_key, slot) DO NOTHING
          `);
        }

        // ── 3. Lock this period's slots, then apply the pure rules ────
        // FOR UPDATE is what makes the read-modify-write safe when two
        // DIFFERENT matches settle for the same player at the same time.
        const stored = await txc.execute(sql`
          SELECT id, user_id, period_type, period_key, slot, quest_type,
                 game_key, target, reward, progress, claimed, meta,
                 completed_at AS "completedAt"
            FROM user_quests
           WHERE user_id = ${seat.userId}
             AND period_type = ${periodType}
             AND period_key = ${periodKey}
           ORDER BY slot
             FOR UPDATE
        `);

        for (const raw of stored.rows ?? stored) {
          const row = normalizeQuestRow(raw);
          if (!row.id) continue;
          const next = advanceQuest(row, evidence, now);
          if (!next.advanced) continue;
          updates.set(row.id, {
            id: row.id,
            progress: next.row.progress,
            completedAt: next.row.completedAt,
            meta: JSON.stringify(next.row.meta ?? {}),
          });
        }
      }

      // ── 4. Persist every advanced slot in one statement ────────────
      const pending = Array.from(updates.values());
      if (pending.length > 0) {
        advancedQuests += pending.length;
        advancedUserIds.push(seat.userId);
        await txc.execute(sql`
          UPDATE user_quests AS q
             SET progress = v.progress,
                 completed_at = v.completed_at,
                 meta = v.meta
            FROM (VALUES ${updateRowsSql(pending)}) AS v(id, progress, completed_at, meta)
           WHERE q.id = v.id
        `);
      }
    }

    return {
      recorded: true,
      reason: "recorded",
      game,
      recordedUserIds: freshSeats.map((seat) => seat.userId),
      advancedUserIds,
      advancedQuests,
    };
  };

  return tx ? run(tx) : db.transaction(run);
}
