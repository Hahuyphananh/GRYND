import { asc, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { quickQueueAssignmentEvents } from "../db/schema";

export interface QuickQueueAssignmentEvent {
  eventId: string;
  assignmentId: string;
  requestIds: string[];
  eventType: string;
  payload: Record<string, unknown>;
}

export type QuickQueueAssignmentEventHandler = (
  event: QuickQueueAssignmentEvent,
) => Promise<void> | void;

export async function publishQuickQueueAssignmentEvents(
  handler: QuickQueueAssignmentEventHandler,
  { batchSize = 50, now = new Date() } = {},
) {
  const rows = await db.transaction(async (tx) =>
    tx
      .select()
      .from(quickQueueAssignmentEvents)
      .where(isNull(quickQueueAssignmentEvents.publishedAt))
      .orderBy(asc(quickQueueAssignmentEvents.createdAt))
      .limit(Math.max(1, Math.min(batchSize, 500)))
      .for("update", { skipLocked: true }),
  );

  let published = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await handler({
        eventId: row.eventId,
        assignmentId: row.assignmentId,
        requestIds: Array.isArray(row.requestIds) ? row.requestIds.map(String) : [],
        eventType: row.eventType,
        payload: row.payload as Record<string, unknown>,
      });
      await db
        .update(quickQueueAssignmentEvents)
        .set({ publishedAt: now, attempts: row.attempts + 1 })
        .where(eq(quickQueueAssignmentEvents.eventId, row.eventId));
      published += 1;
    } catch (error) {
      failed += 1;
      await db
        .update(quickQueueAssignmentEvents)
        .set({ attempts: row.attempts + 1 })
        .where(eq(quickQueueAssignmentEvents.eventId, row.eventId));
      console.error("[quick-queue] assignment event delivery failed", row.eventId, error);
    }
  }
  return { attempted: rows.length, published, failed };
}
