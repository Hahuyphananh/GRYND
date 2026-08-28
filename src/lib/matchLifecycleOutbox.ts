import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { matchLifecycleEvents } from "../db/schema";

export interface LifecycleEventDelivery {
  eventId: string;
  matchId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export type LifecycleEventHandler = (event: LifecycleEventDelivery) => Promise<void> | void;

export interface PublishOptions {
  batchSize?: number;
  staleAfterMs?: number;
  now?: Date;
}

/**
 * Publishes a bounded batch of durable outbox events. Claiming is performed
 * in a transaction with row locks, so multiple workers do not process the
 * same event concurrently. Delivery is at-least-once; handlers must be
 * idempotent. Failed rows remain unpublished and are retried later.
 */
export async function publishMatchLifecycleEvents(
  handler: LifecycleEventHandler,
  options: PublishOptions = {},
): Promise<{ attempted: number; published: number; failed: number }> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 50, 500));
  const now = options.now ?? new Date();
  let attempted = 0;
  let published = 0;
  let failed = 0;

  const events = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(matchLifecycleEvents)
      .where(
        and(
          isNull(matchLifecycleEvents.publishedAt),
        ),
      )
      .orderBy(matchLifecycleEvents.createdAt)
      .limit(batchSize)
      .for("update", { skipLocked: true });
    return rows;
  });

  for (const row of events) {
    attempted += 1;
    try {
      const payload = row.payload as Record<string, unknown>;
      await handler({
        eventId: row.eventId,
        matchId: row.matchId,
        eventType: row.eventType,
        payload,
      });
      await db
        .update(matchLifecycleEvents)
        .set({ publishedAt: now, attempts: row.attempts + 1 })
        .where(eq(matchLifecycleEvents.eventId, row.eventId));
      published += 1;
    } catch (error) {
      failed += 1;
      await db
        .update(matchLifecycleEvents)
        .set({ attempts: row.attempts + 1 })
        .where(eq(matchLifecycleEvents.eventId, row.eventId));
      console.error("[match-lifecycle] event delivery failed", row.eventId, error);
    }
  }

  return { attempted, published, failed };
}
