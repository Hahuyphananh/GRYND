// src/lib/httpCache.ts
//
// Shared HTTP cache headers for PUBLIC, user-agnostic read endpoints.
//
// The lobby listings (`/api/<game>/available`) return the SAME list to every
// caller — no session, no per-user data — yet every waiting player's client
// polls them on a 30s cycle. Letting Vercel's edge serve that identical JSON
// for a few seconds collapses a burst of polling clients into ONE origin
// invocation (and one database read), without changing what any client sees.
//
// Deliberately SHORT: a freshly opened lobby must become visible quickly, and
// the real-time path (Socket.IO lobby pokes) already updates the lobby at once —
// this cache only trims the polling fallback. Never use these headers for
// authoritative game state, balances, or anything private (those routes stay
// `no-store`).

/**
 * 5s at the edge, 5s of stale-while-revalidate. Worst-case staleness is one
 * polling cycle shorter than what the client already tolerated.
 */
export const PUBLIC_LOBBY_CACHE_HEADERS: Record<string, string> = {
  "Cache-Control": "public, s-maxage=5, stale-while-revalidate=5",
};
