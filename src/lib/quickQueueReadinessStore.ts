import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { quickQueueReadiness, quickQueueRequests } from "../db/schema";
import { normalizeQuickQueueReadiness } from "./quickQueueReadiness";

export async function setQuickQueueReadiness(input: unknown) {
  const readiness = normalizeQuickQueueReadiness(input);
  const now = new Date();

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(quickQueueReadiness)
      .where(and(eq(quickQueueReadiness.userId, readiness.userId), eq(quickQueueReadiness.status, "ready")))
      .orderBy(desc(quickQueueReadiness.updatedAt))
      .limit(1);

    const values = {
      preferredGames: readiness.preferredGames,
      preferredModes: readiness.preferredModes,
      region: readiness.region,
      playerCount: readiness.playerCount,
      maxWaitMs: readiness.maxWaitMs,
      minesStakeAmount: readiness.minesStakeAmount?.toFixed(2) ?? null,
      minesCount: readiness.minesCount,
      expiresAt: readiness.expiresAt,
      updatedAt: now,
    };

    const [savedReadiness] = existing
      ? await tx.update(quickQueueReadiness).set(values).where(eq(quickQueueReadiness.id, existing.id)).returning()
      : await tx.insert(quickQueueReadiness).values({ userId: readiness.userId, ...values }).returning();

    const [existingRequest] = await tx
      .select()
      .from(quickQueueRequests)
      .where(and(eq(quickQueueRequests.userId, readiness.userId), eq(quickQueueRequests.status, "queued")))
      .orderBy(desc(quickQueueRequests.createdAt))
      .limit(1);

    const requestValues = {
      preferredGames: readiness.preferredGames,
      preferredModes: readiness.preferredModes,
      region: readiness.region,
      playerCount: readiness.playerCount,
      maxWaitMs: readiness.maxWaitMs,
      minesStakeAmount: readiness.minesStakeAmount?.toFixed(2) ?? null,
      minesCount: readiness.minesCount,
      updatedAt: now,
    };
    const [request] = existingRequest
      ? await tx.update(quickQueueRequests).set(requestValues).where(eq(quickQueueRequests.id, existingRequest.id)).returning()
      : await tx.insert(quickQueueRequests).values({ userId: readiness.userId, ...requestValues }).returning();

    return { readiness: savedReadiness, request };
  });
}

export async function cancelQuickQueueReadiness(userId: string) {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [readiness] = await tx
      .update(quickQueueReadiness)
      .set({ status: "cancelled", updatedAt: now })
      .where(and(eq(quickQueueReadiness.userId, userId), eq(quickQueueReadiness.status, "ready")))
      .returning();

    const requests = await tx
      .update(quickQueueRequests)
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(and(eq(quickQueueRequests.userId, userId), eq(quickQueueRequests.status, "queued")))
      .returning();

    return { readiness: readiness ?? null, requests };
  });
}
