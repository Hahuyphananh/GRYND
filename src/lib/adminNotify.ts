/**
 * Server-side admin notification helper.
 *
 * Pushes an event to the realtime server's admin-only room (`admin:
 * notifications`) via its `POST /emit` endpoint. Used after the backend
 * inserts a player report or contact message, so admin dashboards update
 * live without polling.
 *
 * This is deliberately separate from src/lib/realtime.ts (which is the
 * CLIENT-side Supabase Realtime wrapper) — this module talks to the
 * Socket.IO server and must never be imported into client components.
 *
 * Env: REALTIME_INTERNAL_URL (server-to-server URL of the realtime server;
 * falls back to NEXT_PUBLIC_SOCKET_URL). When REALTIME_INTERNAL_SECRET is
 * set on BOTH sides, it is sent as `x-internal-secret` (same convention as
 * the crash-arena sweep).
 */

export type AdminNotification =
  | { type: "report" }
  | { type: "message" };

function getRealtimeUrl(): string {
  const url =
    process.env.REALTIME_INTERNAL_URL || process.env.NEXT_PUBLIC_SOCKET_URL || "";
  return url.trim().replace(/\/$/, "");
}

/**
 * Fire-and-forget — never throws, never blocks the caller. The insert has
 * already committed by the time this runs, so a failure here only means the
 * admin badge is delayed until the next manual refresh.
 */
export async function notifyAdmins(notification: AdminNotification): Promise<void> {
  const baseUrl = getRealtimeUrl();
  if (!baseUrl) return;

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.REALTIME_INTERNAL_SECRET) {
      headers["x-internal-secret"] = process.env.REALTIME_INTERNAL_SECRET;
    }

    await fetch(`${baseUrl}/emit`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        room: "admin:notifications",
        event: "admin:notify",
        payload: notification,
      }),
      // Don't let a slow realtime server hold up the insert response.
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    console.warn("[adminNotify] failed to notify admins:", err);
  }
}
