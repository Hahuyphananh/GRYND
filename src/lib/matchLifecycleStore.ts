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
  const [row] = await db
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
  await db.insert(matchLifecycleEvents).values({
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
}) {
  const [current] = await db
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

  const [row] = await db
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
  );
  await db.insert(matchLifecycleEvents).values({
    eventId: event.event_id,
    matchId: input.matchId,
    eventType: event.event_type,
    payload: event,
    occurredAt: at,
  });
  return row;
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
