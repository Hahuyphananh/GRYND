import { eq } from "drizzle-orm";
import { db } from "../../db";
import { matchLifecycle } from "../../db/schema";

export async function getKenoCanonicalLifecycle(matchId: number | string) {
  try {
    const [row] = await db
      .select({
        status: matchLifecycle.status,
        queuedAt: matchLifecycle.queuedAt,
        startedAt: matchLifecycle.startedAt,
        endedAt: matchLifecycle.endedAt,
        cancelReason: matchLifecycle.cancelReason,
        playerCount: matchLifecycle.playerCount,
        mode: matchLifecycle.mode,
        queueWaitMs: matchLifecycle.queueWaitMs,
      })
      .from(matchLifecycle)
      .where(eq(matchLifecycle.matchId, String(matchId)))
      .limit(1);
    if (!row) return null;
    return {
      status: row.status,
      queued_at: row.queuedAt?.toISOString() ?? null,
      started_at: row.startedAt?.toISOString() ?? null,
      ended_at: row.endedAt?.toISOString() ?? null,
      cancel_reason: row.cancelReason,
      player_count: row.playerCount,
      mode: row.mode,
      queue_wait_ms: row.queueWaitMs,
    };
  } catch (error) {
    console.warn("[keno-pvp] canonical lifecycle lookup failed", error);
    return null;
  }
}
