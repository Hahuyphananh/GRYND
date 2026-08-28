import { claimMatchingAvailabilityAlerts, type AvailabilitySignal } from "./availabilityAlerts";
import type { LifecycleEventDelivery } from "./matchLifecycleOutbox";

export function availabilitySignalFromLifecycleEvent(
  event: LifecycleEventDelivery,
): AvailabilitySignal | null {
  const payload = event.payload;
  const status = String(payload.status ?? "");
  if (!["queued", "forming", "ready", "started", "completed", "cancelled", "expired", "failed"].includes(status)) {
    return null;
  }

  const gameKey = String(payload.game_key ?? payload.gameKey ?? "");
  const mode = String(payload.mode ?? "");
  const playerCount = Number(payload.player_count ?? payload.playerCount ?? 0);
  if (!gameKey || !mode || !Number.isInteger(playerCount) || playerCount < 0) return null;

  return {
    gameKey,
    mode,
    region: payload.region == null ? null : String(payload.region),
    playerCount,
    availabilityKey: `${gameKey}:${mode}:${String(payload.region ?? "global")}:${status}:${event.matchId}`,
  };
}

/**
 * Claims matching alert subscriptions for one lifecycle event. It deliberately
 * returns claims only; a later notification worker decides how to deliver them.
 */
export async function consumeLifecycleEventForAvailability(
  event: LifecycleEventDelivery,
) {
  const signal = availabilitySignalFromLifecycleEvent(event);
  if (!signal) return [];
  return claimMatchingAvailabilityAlerts(signal);
}
