import { NextResponse } from "next/server";
import { getNeonSql } from "../../../db/neon";

const PING_TIMEOUT_MS = 2000;
const ERROR_MAX_LEN = 200;

type PingResult = {
  dbPingStatus: "ok" | "failed" | "skipped";
  dbPingError: string | null;
  dbPingHost: string | null;
  dbPingSkipReason: string | null;
};

/**
 * Pull the most informative error string out of an arbitrary thrown value.
 *
 * Drizzle and the @neondatabase/serverless driver both wrap the
 * underlying Postgres error inside `Error.cause`, with the wrapper
 * itself carrying nothing more useful than `Failed query: ...`.
 * For diagnosing "the DB is unreachable but *why?*" we want the
 * *innermost* message — typically `password authentication failed
 * for user 'neondb_owner'` or `getaddrinfo ENOTFOUND ...`.
 *
 * Unwraps up to 5 levels deep to be safe against future wrappers.
 */
function extractRootMessage(err: unknown): string {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth++) {
    if (current == null) break;
    if (current instanceof Error) {
      // Prefer cause; fall back to message; stop here once we have
      // a non-empty, non-wrapper message.
      if (current.cause && current.cause !== current) {
        current = current.cause;
        continue;
      }
      if (typeof current.message === "string" && current.message) {
        return current.message;
      }
      return String(current);
    }
    if (typeof current === "string" && current) return current;
    return String(current);
  }
  return String(err);
}

function safeHost(connectionString: string | undefined): string | null {
  if (!connectionString) return null;
  try {
    // URL constructor parses any postgres:// URL; we only read `.host`
    // so even if a password is present in the URL it's never echoed
    // (the hostname is just e.g. "ep-shiny-frog-abcd.eu-west-2.aws.neon.tech").
    return new URL(connectionString).host;
  } catch {
    return null;
  }
}

/**
 * Cheap liveness probe: open a Neon HTTP query (covers both
 * DATABASE_URL and the POSTGRES_URL fallback used by the rest of the
 * app), race it against a hard timeout, surface the real
 * Postgres/Neon error message in the JSON response.
 *
 * Why this exists: the user hits /api/sync-user on the /sync page
 * and sees " Sync failed: 500" somewhere in the dev log they don't
 * know to check. The earlier diagnostic endpoint only exposed
 * `Boolean(process.env.DATABASE_URL)` which lies in the failure
 * mode Neon password has been rotated since they last refreshed
 * `.env.local` — the URL is present and parseable but the auth
 * fails on the first query. This probe *does* the first query, so
 * the user can see exactly which Neon project the ping talked to,
 * what error the server returned, and refresh `.env.local` from
 * Vercel if those don't match.
 */
async function pingDatabase(): Promise<PingResult> {
  const url =
    process.env.DATABASE_URL || (process.env.POSTGRES_URL ?? undefined);

  if (!url) {
    return {
      dbPingStatus: "skipped",
      dbPingError: null,
      dbPingHost: null,
      dbPingSkipReason:
        "Neither DATABASE_URL nor POSTGRES_URL is set in process.env",
    };
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), PING_TIMEOUT_MS);
  });

  try {
    // getNeonSql() exposes the raw neon() helper, *not* the Drizzle
    // Pool wrapper, so thrown errors carry the real Postgres message
    // (Drizzle wraps everything as "Failed query: ..." which hides
    // the actual cause from the user).
    const sql = getNeonSql();
    const result = await Promise.race([sql`SELECT 1 as ok`, timeoutPromise]);

    if (result === "timeout") {
      return {
        dbPingStatus: "failed",
        dbPingError: `DB ping timed out after ${PING_TIMEOUT_MS}ms`,
        dbPingHost: safeHost(url),
        dbPingSkipReason: null,
      };
    }
    return {
      dbPingStatus: "ok",
      dbPingError: null,
      dbPingHost: safeHost(url),
      dbPingSkipReason: null,
    };
  } catch (err: unknown) {
    const message = extractRootMessage(err);
    const clipped =
      message.length > ERROR_MAX_LEN
        ? message.slice(0, ERROR_MAX_LEN) + "…"
        : message;
    return {
      dbPingStatus: "failed",
      // Prefix with a stable label so the user can paste it without
      // confusion about whether it's a Neon vs pg-driver vs app-level
      // message. Truncate + ellipsis so no oversized payload and no
      // accidental URL fragment leak.
      dbPingError: `NeonDB: ${clipped}`,
      dbPingHost: safeHost(url),
      dbPingSkipReason: null,
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { success: false, error: "Not found" },
      { status: 404 },
    );
  }

  const ping = await pingDatabase();

  return NextResponse.json({
    success: ping.dbPingStatus === "ok",
    nodeEnv: process.env.NODE_ENV,
    hasClerkSecretKey: Boolean(process.env.CLERK_SECRET_KEY),
    hasClerkJWTKey: Boolean(process.env.CLERK_JWT_KEY),
    // Presence doesn't guarantee validity — see dbPingStatus below.
    // Both env vars are consumed somewhere in the codebase:
    //   DATABASE_URL  → src/db/client.ts, src/db/index.ts
    //   POSTGRES_URL  → src/db/neon.ts (fallback only)
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    hasPostgresUrl: Boolean(process.env.POSTGRES_URL),
    // Live probe via src/db/neon.ts (single HTTP transport, falls
    // back DATABASE_URL→POSTGRES_URL). Runs `SELECT 1` and surfaces
    // the actual Neon/Postgres error (not the Drizzle wrapper).
    // This is the field that catches the real-world dev failure
    // mode where the URL is set but the password is stale.
    dbPingStatus: ping.dbPingStatus,
    dbPingError: ping.dbPingError,
    dbPingHost: ping.dbPingHost,
    dbPingSkipReason: ping.dbPingSkipReason,
  });
}
