import type { LifecycleEventDelivery } from "./matchLifecycleOutbox";

function getRealtimeUrl(): string {
  return String(
    process.env.REALTIME_INTERNAL_URL || process.env.NEXT_PUBLIC_SOCKET_URL || "",
  ).trim().replace(/\/$/, "");
}

/** Deliver one canonical event to its match room without blocking gameplay. */
export async function relayMatchLifecycleEvent(
  event: LifecycleEventDelivery,
): Promise<void> {
  const baseUrl = getRealtimeUrl();
  if (!baseUrl) return;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.REALTIME_INTERNAL_SECRET) {
    headers["x-internal-secret"] = process.env.REALTIME_INTERNAL_SECRET;
  }

  try {
    const response = await fetch(`${baseUrl}/emit`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        room: `match:lifecycle:${event.matchId}`,
        event: "match:lifecycle",
        payload: {
          ...event.payload,
          event_id: event.eventId,
          match_id: event.matchId,
          event_type: event.eventType,
        },
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      throw new Error(`Realtime relay returned ${response.status}`);
    }
  } catch (error) {
    console.warn("[match-lifecycle] realtime relay failed", event.eventId, error);
    throw error;
  }
}
