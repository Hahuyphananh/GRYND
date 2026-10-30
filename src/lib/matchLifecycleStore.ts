import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { matchLifecycle, matchLifecycleEvents } from "../db/schema";
import {
  canTransitionMatchLifecycle,
  calculateQueueWaitMs,
  createMatchLifecycleEvent,
  type MatchCancelReason,
  type MatchLifecycleStatus,
} from "./matchLifecycle";

export interface CreateMatchLifecycleInput {
  matchId: string;
  gameKey: string;
  mode: string;
  playerCount?: number;
  queuedAt?: Date;
  /**
   * Optional caller transaction. Passing it makes the lifecycle row and its
   * event commit atomically with the caller's own writes (e.g. LAST RUN's
   * match record + Elo), so a failure cannot leave one half applied.
   */
  tx?: any;
}

export async function createMatchLifecycle(input: CreateMatchLifecycleInput) {
  if (!input.matchId || !input.gameKey || !input.mode) {
    throw new Error("matchId, gameKey, and mode are required");
  }
  const playerCount = input.playerCount ?? 0;
  if (!Number.isInteger(playerCount) || playerCount < 0) {
    throw new Error("playerCount must be a non-negative integer");
  }

  const queuedAt = input.queuedAt ?? new Date();
  const conn = input.tx ?? db;
  const [row] = await conn
    .insert(matchLifecycle)
    .values({
      matchId: input.matchId,
      gameKey: input.gameKey,
      mode: input.mode,
      playerCount,
      queuedAt,
      status: "queued",
    })
    .returning();

  const event = createMatchLifecycleEvent(
    toCanonicalLifecycle(row),
    input.matchId,
    crypto.randomUUID(),
    queuedAt.toISOString(),
  );
  await conn.insert(matchLifecycleEvents).values({
    eventId: event.event_id,
    matchId: input.matchId,
    eventType: event.event_type,
    payload: event,
    occurredAt: queuedAt,
  });
  return row;
}

export async function transitionMatchLifecycle(input: {
  matchId: string;
  to: MatchLifecycleStatus;
  cancelReason?: MatchCancelReason;
  playerCount?: number;
  at?: Date;
  eventId?: string;
  /**
   * Game-specific detail for the emitted event (e.g. a result, a duration or a
   * per-seat distance). It rides in the canonical payload's `metadata` field,
   * which is additive — no schema change, and consumers that ignore it are
   * unaffected.
   */
  metadata?: Record<string, unknown>;
  /** Optional caller transaction — see CreateMatchLifecycleInput.tx. */
  tx?: any;
}) {
  const conn = input.tx ?? db;
  const [current] = await conn
    .select()
    .from(matchLifecycle)
    .where(eq(matchLifecycle.matchId, input.matchId))
    .limit(1);
  if (!current) throw new Error("Match lifecycle not found");

  const from = current.status as MatchLifecycleStatus;
  if (!canTransitionMatchLifecycle(from, input.to)) {
    throw new Error(`Invalid match lifecycle transition: ${from} -> ${input.to}`);
  }
  if (input.to === "cancelled" && !input.cancelReason) {
    throw new Error("cancelReason is required when cancelling a match");
  }
  if (input.to !== "cancelled" && input.cancelReason) {
    throw new Error("cancelReason is only valid for cancelled matches");
  }

  const at = input.at ?? new Date();
  const startedAt = input.to === "started" ? at : current.startedAt;
  const terminal = ["completed", "cancelled", "expired", "failed"].includes(input.to);
  const endedAt = terminal ? at : current.endedAt;
  const queueWaitMs =
    input.to === "started" || terminal
      ? calculateQueueWaitMs(current.queuedAt, input.to === "started" ? startedAt! : endedAt!)
      : current.queueWaitMs;

  const [row] = await conn
    .update(matchLifecycle)
    .set({
      status: input.to,
      startedAt,
      endedAt,
      cancelReason: input.cancelReason ?? null,
      playerCount: input.playerCount ?? current.playerCount,
      queueWaitMs,
      updatedAt: at,
    })
    .where(and(eq(matchLifecycle.matchId, input.matchId), eq(matchLifecycle.status, from)))
    .returning();
  if (!row) throw new Error("Match lifecycle changed concurrently; retry the transition");

  const event = createMatchLifecycleEvent(
    toCanonicalLifecycle(row),
    input.matchId,
    input.eventId ?? crypto.randomUUID(),
    at.toISOString(),
    input.metadata,
  );
  await conn.insert(matchLifecycleEvents).values({
    eventId: event.event_id,
    matchId: input.matchId,
    eventType: event.event_type,
    payload: event,
    occurredAt: at,
  });
  return row;
}

/**
 * Append one lifecycle event for a row whose status is already terminal.
 *
 * The state machine refuses a second `completed`, so a match that was marked
 * completed by an earlier partial write cannot be transitioned again. This lets
 * the settlement repair the missing event with the SAME deterministic event id,
 * `ON CONFLICT DO NOTHING` — never a second event, never a second result.
 */
export async function appendMatchLifecycleEvent(input: {
  row: typeof matchLifecycle.$inferSelect;
  eventId: string;
  at?: Date;
  metadata?: Record<string, unknown>;
  tx?: any;
}) {
  const conn = input.tx ?? db;
  const at = input.at ?? new Date();
  const event = createMatchLifecycleEvent(
    toCanonicalLifecycle(input.row),
    input.row.matchId,
    input.eventId,
    at.toISOString(),
    input.metadata,
  );
  await conn
    .insert(matchLifecycleEvents)
    .values({
      eventId: event.event_id,
      matchId: input.row.matchId,
      eventType: event.event_type,
      payload: event,
      occurredAt: at,
    })
    .onConflictDoNothing();
  return event;
}

function toCanonicalLifecycle(row: typeof matchLifecycle.$inferSelect) {
  return {
    status: row.status as MatchLifecycleStatus,
    queued_at: row.queuedAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    ended_at: row.endedAt?.toISOString() ?? null,
    cancel_reason: (row.cancelReason as MatchCancelReason | null) ?? null,
    player_count: row.playerCount,
    mode: row.mode,
    queue_wait_ms: row.queueWaitMs,
  };
}
