import { and, asc, eq } from "drizzle-orm";
import { db } from "../db";
import { quickQueueAssignmentEvents, quickQueueAssignments, quickQueueRequests } from "../db/schema";
import { findCompatibleQuickQueueCandidate, normalizeQuickQueueRequest } from "./quickQueue";

export async function claimQuickQueueAssignment({ limit = 100 } = {}) {
  return db.transaction(async (tx) => {
    const requests = await tx
      .select()
      .from(quickQueueRequests)
      .where(eq(quickQueueRequests.status, "queued"))
      .orderBy(asc(quickQueueRequests.queuedAt))
      .limit(Math.max(1, Math.min(limit, 500)))
      .for("update", { skipLocked: true });

    for (const source of requests) {
      const request = normalizeQuickQueueRequest({
        userId: source.userId,
        preferredGames: source.preferredGames,
        preferredModes: source.preferredModes,
        region: source.region,
        playerCount: source.playerCount,
        maxWaitMs: source.maxWaitMs,
      });
      const candidate = findCompatibleQuickQueueCandidate(request, requests.map((row) => ({
        gameKey: request.preferredGames[0],
        mode: request.preferredModes[0] ?? "pvp",
        region: row.region,
        playerCount: row.playerCount,
        queuedAt: row.queuedAt.getTime(),
        available: row.status === "queued" && row.userId !== source.userId,
      })));
      if (!candidate) continue;

      const partner = requests.find((row) => row.userId !== source.userId && row.queuedAt.getTime() === candidate.queuedAt);
      if (!partner) continue;
      const requestIds = [source.id, partner.id];
      const [assignment] = await tx.insert(quickQueueAssignments).values({
        requestIds,
        gameKey: candidate.gameKey,
        mode: candidate.mode,
        playerCount: requestIds.length,
        status: "ready",
      }).returning();
      await tx.update(quickQueueRequests).set({ status: "assigned", updatedAt: new Date() }).where(eq(quickQueueRequests.id, source.id));
      await tx.update(quickQueueRequests).set({ status: "assigned", updatedAt: new Date() }).where(eq(quickQueueRequests.id, partner.id));
      await tx.insert(quickQueueAssignmentEvents).values({
        assignmentId: assignment.id,
        requestIds,
        eventType: "quick_queue:ready",
        payload: {
          assignmentId: assignment.id,
          requestIds,
          gameKey: assignment.gameKey,
          mode: assignment.mode,
          playerCount: assignment.playerCount,
          status: assignment.status,
        },
      });
      return assignment;
    }
    return null;
  });
}
