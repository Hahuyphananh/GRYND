// src/lib/gamePresenceClient.js
//
// Client transport for the per-game ACTIVE PLAYER presence heartbeat (the
// casino lobby's "N playing" badge). The React wrapper is
// src/hooks/useActiveGamePresence.js; this module holds the parts that carry
// no React state, so they are unit-testable outside a browser:
//
//   1. getPresenceSessionId() — a stable PER-TAB session id. It is NOT an
//      identity: the server always writes the caller's own users.id from the
//      Clerk session (see src/app/api/presence/active-game/route.ts). All the
//      id does is let one tab's deliberate leave clear only its own row, so a
//      second tab playing the same game keeps counting.
//   2. sendPresenceBeat()  — POST /api/presence/active-game  (idempotent upsert)
//   3. sendPresenceLeave() — POST /api/presence/active-game/leave (optional)
//
// Everything here is best-effort and fire-and-forget. Presence is auxiliary:
// a failed request must never surface an error, block rendering or interrupt a
// game. Both senders resolve to a boolean ("landed") and NEVER reject — the
// server-side activity window is the ultimate fallback, so a dropped beat (or
// a whole crashed browser) simply ages out of the count.
//
// No game rules, wagers, XP or match state are read or written here, and none
// of these calls can influence a game's outcome.

"use client";

/**
 * sessionStorage key holding this tab's presence session id.
 * Versioned like src/lib/recentlyPlayed.js so the shape can evolve without
 * stale-data bugs. sessionStorage is per TAB, which is exactly the scope the
 * id describes.
 */
const SESSION_KEY = "grynd.gamePresence.session.v1";

/** The key above, exported for tests and any future session-cleanup sweep. */
export const PRESENCE_SESSION_KEY = SESSION_KEY;

/** sessionStorage, or null when unavailable (SSR, private mode, disabled). */
function getStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** A fresh opaque id. crypto.randomUUID is used when present, with a
 *  dependency-free fallback so an older/insecure context still gets one. */
function createSessionId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the manual id
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * This tab's presence session id, created on first use and reused for the
 * whole tab (including across a reload, since sessionStorage survives one).
 *
 * Returns null when storage is unavailable — the caller then simply sends no
 * session id, which is valid: it is optional in the API and is never part of
 * the (user, game) uniqueness rule.
 */
export function getPresenceSessionId() {
  const store = getStorage();
  if (!store) return null;
  try {
    const existing = store.getItem(SESSION_KEY);
    if (existing) return existing;
    const created = createSessionId();
    store.setItem(SESSION_KEY, created);
    return created;
  } catch {
    // Storage threw (quota / disabled) — presence still works without it.
    return null;
  }
}

/**
 * POST a body to a presence endpoint. Never rejects, never throws (not even
 * when `fetch` itself is missing), and reports whether the request landed via
 * the resolved boolean — which is all a test needs to assert the exact wire
 * format without a server.
 *
 * `keepalive` matters for the leave call, which usually races a page
 * navigation; credentials are included so the Clerk session authorizes the
 * write. A non-2xx response (401 signed-out visitor, 429 rate limit, 500) is
 * returned as `false` and deliberately NOT logged — a signed-out browser
 * walking the casino would otherwise spam its console.
 */
async function postPresence(url, body) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      keepalive: true,
      body: JSON.stringify(body),
    });
    return Boolean(response?.ok);
  } catch {
    // Network failure / offline / aborted: presence is cosmetic. Swallow it,
    // exactly like src/lib/recentlyPlayed.js does for the play counter.
    return false;
  }
}

/**
 * One heartbeat: mark the caller active in `gameLabel`.
 * `gameLabel` is the label the game page already uses for
 * <CreatorModeHost gameLabel> / useRecordPlayedGame; the server resolves it to
 * a canonical game id (src/lib/gamePresence.js) and rejects anything unknown.
 */
export function sendPresenceBeat(gameLabel, sessionId = null) {
  if (!gameLabel) return Promise.resolve(false);
  return postPresence("/api/presence/active-game", { gameLabel, sessionId });
}

/**
 * Deliberate departure. Optional by design — a row stops counting when its
 * heartbeat falls out of the activity window — but it makes "user left the
 * game" (and "the match just finished") instant instead of taking up to
 * ACTIVE_PLAYER_WINDOW_SECONDS.
 *
 * Scoped by sessionId, so one tab leaving can never wipe a second tab's
 * still-live presence for the same game.
 */
export function sendPresenceLeave(gameLabel, sessionId = null) {
  if (!gameLabel) return Promise.resolve(false);
  return postPresence("/api/presence/active-game/leave", { gameLabel, sessionId });
}
