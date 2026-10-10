/**
 * Edge-safe reads of the values the page middleware needs to enforce.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `src/middleware.ts` runs on the **Edge runtime** (Next 16 sends `proxy.ts` to
 * the Node.js server unconditionally, but `middleware.ts` to the edge server —
 * see `build/entries.js`). Cloudflare's OpenNext adapter does not support
 * Node.js middleware, so the middleware must not import `pg`.
 *
 * Four of the middleware's decisions are backed by Postgres — the maintenance
 * flag, `is_admin`, `age`, and `mfa_enabled`. Rather than move those gates out
 * of the middleware (which would change WHERE they run and risk silently
 * weakening them), this module reads the same four values over PostgREST,
 * which is plain `fetch` and therefore Edge-safe. The checks stay exactly where
 * they were; only their transport changes.
 *
 * The Node-side helpers in `src/lib/auth/isAdmin.ts` and
 * `src/lib/security/maintenance.ts` are intentionally left untouched — they
 * still serve every route handler, admin page and script through `pg`.
 *
 * FAILURE MODES are mirrored from those Node helpers on purpose:
 *   - maintenance: fail OPEN (a DB hiccup must never take the whole site down)
 *   - isAdmin:     fall back to the CHAT_ADMIN_CLERK_IDS env allowlist
 *   - age / mfa:   return "unknown" so the caller's existing branch runs
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { withTimeout } from "./withTimeout";

// Must match src/db/schema.ts (MAINTENANCE_MODE_KEY / _ON). Asserted equal by
// tests/edge-middleware-flags.test.mjs so the two can never drift.
export const MAINTENANCE_MODE_KEY = "maintenance_mode";
export const MAINTENANCE_MODE_ON = "true";

const DB_TIMEOUT_MS = 1500;
const MAINTENANCE_CACHE_TTL_MS = 10_000;

let _client: SupabaseClient | null | undefined;

/**
 * Lazily-created service-role Supabase client (PostgREST over fetch).
 * Returns null when the project isn't configured — every caller treats that
 * as "value unknown" and applies its own fail-safe.
 */
function getSupabase(): SupabaseClient | null {
  if (_client !== undefined) return _client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    _client = null;
    return _client;
  }

  _client = createClient(url.trim().replace(/\/$/, ""), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

/**
 * Bound a PostgREST call so a slow/hung request can never block page delivery.
 *
 * `withTimeout` takes a `Promise`, but Supabase's query builder is a thenable
 * (a `PostgrestBuilder`), so it has to be wrapped before it can be raced.
 */
function withDbTimeout<T>(query: PromiseLike<T>, fallback: T): Promise<T> {
  return withTimeout(Promise.resolve(query), DB_TIMEOUT_MS, fallback);
}

function envAdminIds(): string[] {
  return (process.env.CHAT_ADMIN_CLERK_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

// ── Maintenance mode ────────────────────────────────────────────────────
// Same 10s in-process TTL + concurrent-lookup dedupe as the Node helper, so a
// page-load burst costs one PostgREST call, not N.

let maintenanceCache: { value: boolean; expiresAt: number } | null = null;
let maintenanceInflight: Promise<boolean> | null = null;

export async function edgeIsMaintenanceMode(): Promise<boolean> {
  if (maintenanceCache && maintenanceCache.expiresAt > Date.now()) {
    return maintenanceCache.value;
  }
  if (maintenanceInflight) return maintenanceInflight;

  maintenanceInflight = (async () => {
    let on = false; // fail open
    try {
      const sb = getSupabase();
      if (sb) {
        const { data, error } = await withDbTimeout<any>(
          sb
            .from("app_settings")
            .select("value")
            .eq("key", MAINTENANCE_MODE_KEY)
            .limit(1)
            .maybeSingle() as unknown as PromiseLike<any>,
          { data: null, error: null },
        );
        on = !error && data?.value === MAINTENANCE_MODE_ON;
      }
    } catch (err) {
      console.warn(
        "[maintenance] edge flag lookup failed, treating as off:",
        (err as Error)?.message,
      );
      on = false;
    } finally {
      maintenanceCache = { value: on, expiresAt: Date.now() + MAINTENANCE_CACHE_TTL_MS };
      maintenanceInflight = null;
    }
    return on;
  })();

  return maintenanceInflight;
}

/** Test-only: drop the maintenance cache so a test can re-read the flag. */
export function resetEdgeMaintenanceCache(): void {
  maintenanceCache = null;
}

// ── users row: age / mfa_enabled / is_admin ─────────────────────────────

export type EdgeUserFlags = {
  age: number | null;
  mfaEnabled: boolean;
  isAdmin: boolean;
};

/**
 * Read the three user columns the middleware gates on, in one round-trip.
 * Returns null when the row can't be read — callers apply their own fallback.
 */
export async function edgeReadUserFlags(
  clerkId: string,
): Promise<EdgeUserFlags | null> {
  const sb = getSupabase();
  if (!sb || !clerkId) return null;

  try {
    const { data, error } = await withDbTimeout<any>(
      sb
        .from("users")
        .select("age, mfa_enabled, is_admin")
        .eq("clerk_id", clerkId)
        .limit(1)
        .maybeSingle() as unknown as PromiseLike<any>,
      { data: null, error: null },
    );
    if (error || !data) return null;

    const row = data as {
      age: number | null;
      mfa_enabled: boolean | null;
      is_admin: boolean | null;
    };
    return {
      age: row.age ?? null,
      mfaEnabled: row.mfa_enabled === true,
      isAdmin: row.is_admin === true,
    };
  } catch {
    return null;
  }
}

/**
 * Edge equivalent of `isAdmin()` in src/lib/auth/isAdmin.ts — identical
 * outcome: the DB badge wins, then the CHAT_ADMIN_CLERK_IDS allowlist.
 */
export async function edgeIsAdmin(clerkId: string): Promise<boolean> {
  const flags = await edgeReadUserFlags(clerkId);
  if (flags?.isAdmin === true) return true;
  return envAdminIds().includes(clerkId);
}

/** Edge equivalent of the middleware's cached `users.age` lookup. */
export async function edgeUserAge(clerkId: string): Promise<number | null> {
  const flags = await edgeReadUserFlags(clerkId);
  return flags?.age ?? null;
}

/** Edge equivalent of the middleware's cached `users.mfa_enabled` lookup. */
export async function edgeUserMfaEnabled(clerkId: string): Promise<boolean> {
  const flags = await edgeReadUserFlags(clerkId);
  return flags?.mfaEnabled === true;
}
