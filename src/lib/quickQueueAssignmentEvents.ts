import { asc, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { quickQueueAssignmentEvents, quickQueueRequests } from "../db/schema";
import { availabilityAlertDeliveries, availabilityAlerts } from "../db/schema";

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

export type QuickQueueAssignmentAlertHandler = (input: {
  userId: string;
  event: QuickQueueAssignmentEvent;
}) => Promise<void> | void;

async function claimAssignmentAlert(userId: string, event: QuickQueueAssignmentEvent, now: Date) {
  const gameKey = String(event.payload.gameKey ?? event.payload.game_key ?? "");
  const mode = String(event.payload.mode ?? "");
  const playerCount = Number(event.payload.playerCount ?? event.payload.player_count ?? 0);
  if (!gameKey || !mode || !Number.isInteger(playerCount)) return false;
  const alerts = await db.select().from(availabilityAlerts).where(eq(availabilityAlerts.userId, userId));
  for (const alert of alerts) {
    if (!alert.active || (alert.expiresAt && alert.expiresAt <= now)) continue;
    if (alert.gameKey && alert.gameKey !== gameKey) continue;
    if (alert.mode && alert.mode !== mode) continue;
    if (playerCount < alert.minPlayerCount) continue;
    const [delivery] = await db.insert(availabilityAlertDeliveries).values({
      alertId: alert.id,
      availabilityKey: `quick-queue:${event.assignmentId}`,
      deliveredAt: now,
    }).onConflictDoNothing().returning();
    if (delivery) return true;
  }
  return false;
}

export async function publishQuickQueueAssignmentEvents(
  handler: QuickQueueAssignmentEventHandler,
  { batchSize = 50, now = new Date(), onAssignmentAlert }: { batchSize?: number; now?: Date; onAssignmentAlert?: QuickQueueAssignmentAlertHandler } = {},
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
      const event = {
        eventId: row.eventId,
        assignmentId: row.assignmentId,
        requestIds: Array.isArray(row.requestIds) ? row.requestIds.map(String) : [],
        eventType: row.eventType,
        payload: row.payload as Record<string, unknown>,
      };
      await handler(event);
      if (onAssignmentAlert) {
        const requests = await db
          .select({ userId: quickQueueRequests.userId })
          .from(quickQueueRequests)
          .where(eq(quickQueueRequests.id, event.requestIds[0]));
        for (const request of requests) {
          const claimed = await claimAssignmentAlert(request.userId, event, now);
          if (claimed) await onAssignmentAlert({ userId: request.userId, event });
        }
      }
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
