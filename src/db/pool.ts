import { Pool } from "pg";

/**
 * Shared singleton Postgres pool for the whole app.
 *
 * Every DB access path (Drizzle ORM, the `sql` helpers, cron jobs) goes
 * through this one pool so connection counts stay predictable regardless
 * of which module does the query. The connection string is read from
 * `DATABASE_URL` (preferred) with `POSTGRES_URL` as a fallback — point
 * whichever one you use at your Postgres provider (Supabase pooler or
 * direct connection both work; SSL is enabled automatically for non-local
 * hosts).
 */
let poolInstance: Pool | null = null;

function extractHost(connectionString: string): string {
  try {
    return new URL(connectionString).hostname || "";
  } catch {
    // Not a parseable URL (e.g. an unencrypted local DSN) — fall back to
    // assuming local so we don't force SSL on it.
    return "";
  }
}

export function getPool(): Pool {
  if (poolInstance) return poolInstance;

  const connectionString =
    process.env.DATABASE_URL || process.env.POSTGRES_URL || "";

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Set it in your runtime environment (for example, Vercel Project Settings > Environment Variables).",
    );
  }

  // pg merges the connection string over the Pool options
  // (`Object.assign({}, config, parse(connectionString))`), so an
  // `sslmode` query param in the URL would clobber the explicit `ssl`
  // option below and re-enable certificate verification — which breaks
  // connections to Supabase's pooler (self-signed leaf cert) with
  // `SELF_SIGNED_CERT_IN_CHAIN`. SSL is controlled solely by the `ssl`
  // option, so strip `sslmode` (and friends) from the URL.
  const sanitizedConnectionString = connectionString.replace(
    /([?&])sslmode=[^&]*(&|$)/g,
    (_match, prefix: string, suffix: string) => (suffix === "&" ? prefix : ""),
  );

  const host = extractHost(sanitizedConnectionString);
  const isLocal = /localhost|127\.0\.0\.1|::1/.test(host);

  poolInstance = new Pool({
    connectionString: sanitizedConnectionString,
    // Serverless platforms spin up one pool per warm instance, so the real
    // pressure on Supabase's pooler is `max × concurrent instances`, not `max`
    // alone. At 10 per instance a traffic spike could hold hundreds of server
    // connections, which is what forces a larger compute tier. The pooler
    // multiplexes many clients onto few server connections, so a small local
    // max still serves the same throughput.
    //
    // Raise this only with `npm run loadtest:read-mix` as evidence — a value
    // that is too low surfaces as queueing (bounded into a fast 500 by
    // `connectionTimeoutMillis`), not as silent data loss.
    max: 3,
    // Establish connections fast (or fail fast): with a 10s handshake
    // timeout, a slow pooler made every queued request wait ~10s and the
    // resulting backlog stacked into 12-14s requests and cascading 500s.
    connectionTimeoutMillis: 5_000,
    // Release idle connections promptly. This was 60s to avoid re-paying the
    // TLS handshake on bursty traffic, but it also meant every instance that
    // went quiet held its share of the pool for a full minute — connections
    // that a scaled-down fleet no longer needs but Supabase still counts.
    idleTimeoutMillis: 15_000,
    // TCP keepalive so the provider doesn't reap connections the pool still
    // thinks are alive (the "Connection terminated unexpectedly" errors).
    keepAlive: true,
    // A hung query must never pin a connection (or a request) forever.
    // 8s is generous for game queries but still bounds worst-case latency
    // when the provider pooler misbehaves or a lock is stuck.
    statement_timeout: 8_000,
    // Cloud Postgres (Supabase, Neon, RDS) requires SSL. Local dev
    // Postgres usually doesn't have SSL enabled, so skip it for localhost.
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  });

  return poolInstance;
}
