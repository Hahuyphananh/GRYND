import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "../db";
import { availabilityAlertDeliveries, availabilityAlerts } from "../db/schema";

export interface AvailabilitySignal {
  gameKey: string;
  mode: string;
  region?: string | null;
  playerCount: number;
  availabilityKey: string;
}

export function matchesAvailabilitySignal(
  alert: {
    gameKey: string | null;
    mode: string | null;
    region: string | null;
    minPlayerCount: number;
    maxWaitMs: number | null;
  },
  signal: AvailabilitySignal,
): boolean {
  return (
    (!alert.gameKey || alert.gameKey === signal.gameKey) &&
    (!alert.mode || alert.mode === signal.mode) &&
    (!alert.region || alert.region === signal.region) &&
    signal.playerCount >= alert.minPlayerCount &&
    (!alert.maxWaitMs || alert.maxWaitMs > 0)
  );
}

/** Find active, unexpired subscriptions and atomically claim each signal once. */
export async function claimMatchingAvailabilityAlerts(
  signal: AvailabilitySignal,
  now = new Date(),
) {
  if (!signal.gameKey || !signal.mode || signal.playerCount < 0) {
    throw new Error("Invalid availability signal");
  }

  const candidates = await db
    .select()
    .from(availabilityAlerts)
    .where(
      and(
        eq(availabilityAlerts.active, true),
        or(isNull(availabilityAlerts.expiresAt), eq(availabilityAlerts.expiresAt, now)),
      ),
    );

  const claimed = [];
  for (const alert of candidates) {
    if (alert.expiresAt && alert.expiresAt <= now) continue;
    if (!matchesAvailabilitySignal(alert, signal)) continue;

    const [delivery] = await db
      .insert(availabilityAlertDeliveries)
      .values({ alertId: alert.id, availabilityKey: signal.availabilityKey, deliveredAt: now })
      .onConflictDoNothing()
      .returning();
    if (delivery) claimed.push({ alert, delivery });
  }
  return claimed;
}
