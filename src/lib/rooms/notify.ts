// src/lib/rooms/notify.ts
//
// The realtime ACCELERATOR for rooms and challenges. The database row is the
// source of truth — this only makes a pending invitation (or a started match)
// appear on the friend's screen in ~50 ms instead of on the next poll tick.
//
// HOW: a POST to the realtime server's internal `/emit` endpoint (the same
// transport src/lib/matchLifecycleRelay.ts uses), addressed to the
// server-verified `user:<clerkId>` room that a socket is only allowed into
// through the realtime server's own `user:join` handler (it derives the id from
// the VERIFIED Clerk token, never from client input).
//
// WHAT IT CARRIES: a bare "something changed, refetch" signal. No room id, no
// code, no game, no inviter, no settings — so even a client that somehow
// received another user's signal learns nothing. Every invitation is read back
// through the recipient's own authenticated session (`GET /api/rooms`), which
// re-derives what they are allowed to see.
//
// FAILURE IS NEVER FATAL: no realtime URL, no secret, a timeout or a 500 all
// mean "the client will poll instead". An invitation that was written to the
// database is a delivered invitation; the push is an optimisation, so nothing
// here is allowed to fail the request that caused it.

/** Event name the Friends tab listens for. */
export const ROOMS_CHANGED_EVENT = "rooms:changed";

/** The per-user notification room id (matches the realtime server's `user:join`). */
export function userRoom(clerkId: string): string {
  return `user:${clerkId}`;
}

function realtimeUrl(): string {
  return String(
    process.env.REALTIME_INTERNAL_URL || process.env.NEXT_PUBLIC_SOCKET_URL || "",
  )
    .trim()
    .replace(/\/+$/, "");
}

/**
 * Fire-and-forget: tell each of `clerkIds` to refetch their rooms/invitations.
 *
 * Never throws and never awaits anything the caller depends on — call it after
 * the database write has committed, and ignore its result.
 */
export async function notifyRoomsChanged(clerkIds: readonly (string | null | undefined)[]): Promise<void> {
  const baseUrl = realtimeUrl();
  if (!baseUrl) return;

  const secret = process.env.REALTIME_INTERNAL_SECRET;
  if (!secret) return;

  const unique = Array.from(new Set(clerkIds.filter((id): id is string => Boolean(id))));
  if (unique.length === 0) return;

  const payload = { at: new Date().toISOString() };

  await Promise.all(
    unique.map(async (clerkId) => {
      try {
        await fetch(`${baseUrl}/emit`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-secret": secret,
          },
          body: JSON.stringify({
            room: userRoom(clerkId),
            event: ROOMS_CHANGED_EVENT,
            payload,
          }),
          signal: AbortSignal.timeout(2000),
        });
      } catch {
        // Offline friend, cold realtime instance, network blip: the poll covers it.
      }
    }),
  );
}
