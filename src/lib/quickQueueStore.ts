import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { quickQueueAssignments, quickQueueRequests } from "../db/schema";
import { normalizeQuickQueueRequest } from "./quickQueue";

export async function createQuickQueueRequest(input: unknown) {
  const request = normalizeQuickQueueRequest(input);
  const [existing] = await db
    .select()
    .from(quickQueueRequests)
    .where(and(eq(quickQueueRequests.userId, request.userId), eq(quickQueueRequests.status, "queued")))
    .limit(1);
  if (existing) return existing;

  // No priority matchmaking: the `premium` column stays at its default
  // (false) for everyone, so membership can never affect who you're paired
  // with. Kept in the schema for backward-compatible reads.
  const [created] = await db
    .insert(quickQueueRequests)
    .values({
      userId: request.userId,
      preferredGames: request.preferredGames,
      preferredModes: request.preferredModes,
      region: request.region,
      playerCount: request.playerCount,
      maxWaitMs: request.maxWaitMs,
    })
    .returning();
  return created;
}

export async function listQuickQueueRequests(userId: string) {
  return db
    .select()
    .from(quickQueueRequests)
    .where(eq(quickQueueRequests.userId, userId))
    .orderBy(desc(quickQueueRequests.createdAt));
}

export async function getQuickQueueAssignmentForUser(userId: string, assignmentId?: string) {
  const rows = await db
    .select({ assignment: quickQueueAssignments, request: quickQueueRequests })
    .from(quickQueueAssignments)
    .innerJoin(
      quickQueueRequests,
      and(
        eq(quickQueueRequests.userId, userId),
        eq(quickQueueRequests.status, "assigned"),
      ),
    )
    .where(
      assignmentId
        ? eq(quickQueueAssignments.id, assignmentId)
        : undefined,
    )
    .orderBy(desc(quickQueueAssignments.assignedAt));

  if (assignmentId) {
    const matching = rows.filter((row) => {
      const ids = Array.isArray(row.assignment.requestIds)
        ? row.assignment.requestIds.map(String)
        : [];
      return ids.includes(String(row.request.id));
    });
    return matching[0]?.assignment ?? null;
  }

  return rows.find((row) => {
    const ids = Array.isArray(row.assignment.requestIds)
      ? row.assignment.requestIds.map(String)
      : [];
    return ids.includes(String(row.request.id));
  })?.assignment ?? null;
}

export async function cancelQuickQueueRequest(userId: string, requestId: string) {
  const [cancelled] = await db
    .update(quickQueueRequests)
    .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(quickQueueRequests.id, requestId), eq(quickQueueRequests.userId, userId), eq(quickQueueRequests.status, "queued")))
    .returning();
  return cancelled ?? null;
}
