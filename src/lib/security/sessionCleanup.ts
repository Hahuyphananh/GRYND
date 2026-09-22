// src/lib/security/sessionCleanup.ts
// Client-side logout hygiene.
//
// Clerk's signOut() revokes the session server-side and clears its own
// cookies, but it knows nothing about app-owned artifacts that survive on
// the device after logout:
//   - the self-hosted `admin_mfa` cookie (HttpOnly — only a server response
//     can clear it, see /api/auth/clear-session),
//   - per-user caches in sessionStorage (`admin:<id>`, `navmeta:<id>`),
//   - per-user game-session tokens in localStorage
//     (`hexDuelAiSessionId:<id>`).
//
// Device preferences (theme, language, cookie consent, personal bests,
// onboarding-tour state) are deliberately NOT cleared — they are not
// login indicators.

import { clearPersistentCache } from "../cache/persistentSwrCache";

const SESSION_STORAGE_PREFIXES = ["admin:", "navmeta:"];
const LOCAL_STORAGE_PREFIXES = ["hexDuelAiSessionId:"];
const CLEAR_SESSION_ENDPOINT = "/api/auth/clear-session";

function removeKeysByPrefix(storage: Storage | null, prefixes: string[]) {
  if (!storage) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && prefixes.some((p) => key.startsWith(p))) doomed.push(key);
    }
    for (const key of doomed) storage.removeItem(key);
  } catch {
    // Storage unavailable (private mode, sandboxed iframe) — nothing to clear.
  }
}

function clearCookie(name: string) {
  const secure =
    typeof window !== "undefined" &&
    window.location.protocol === "https:";
  document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax${
    secure ? "; Secure" : ""
  }`;
}

/**
 * Removes every app-owned key from sessionStorage/localStorage that
 * indicates a logged-in state, plus non-HttpOnly cookies. Safe to call
 * repeatedly and safe to call while signed out (leftovers from an earlier
 * session on this machine are swept too).
 */
export function clearClientSessionArtifacts(): void {
  if (typeof window === "undefined") return;

  removeKeysByPrefix(window.sessionStorage, SESSION_STORAGE_PREFIXES);
  removeKeysByPrefix(window.localStorage, LOCAL_STORAGE_PREFIXES);
  // Drop the persisted SWR payloads so the next player on this device never
  // sees the previous session's cached data.
  clearPersistentCache();

  try {
    // Best-effort non-HttpOnly app cookie. The HttpOnly admin_mfa cookie
    // is handled by clearSessionOnServer().
    clearCookie("csrf_token");
  } catch {
    // ignore
  }
}

/**
 * Asks the server to clear HttpOnly cookies that document.cookie cannot
 * touch (admin_mfa, Clerk's __session/__client/__clerk_db_jwt). Fire and
 * forget with `keepalive` so the request survives the post-sign-out
 * navigation/redirect.
 */
export function clearSessionOnServer(): void {
  if (typeof window === "undefined") return;
  fetch(CLEAR_SESSION_ENDPOINT, {
    method: "POST",
    credentials: "include",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => {
    // Best effort — the server-side revocation performed by Clerk's
    // signOut() is the real gate; this is defense in depth.
  });
}

/**
 * Full logout sweep. Call BEFORE Clerk's signOut() so the device is left
 * clean even if the revocation or the redirect races/fails.
 */
export function clearSessionArtifacts(): void {
  clearClientSessionArtifacts();
  clearSessionOnServer();
}
