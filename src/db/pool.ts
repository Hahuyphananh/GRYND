import { Pool } from "pg";

/**
 * Shared singleton Postgres pool for the whole app.
 *
 * Every DB access path (Drizzle ORM, the `sql` helpers, cron jobs) goes
 * through this one pool so connection counts stay predictable regardless
 * of which module does the query.
 *
 * ── Where the connection string comes from ─────────────────────────────
 *
 * 1. Cloudflare Workers: the Hyperdrive binding (`env.HYPERDRIVE`). Hyperdrive
 *    performs the connection pooling to the origin database, so the Worker
 *    never talks to Postgres directly. Cloudflare's documented driver for this
 *    is node-postgres (`pg`), which is what this file already uses — see
 *    https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/
 *    Note: when setting up Hyperdrive for Supabase, use Supabase's **Direct**
 *    connection string (not the pooled one) — Hyperdrive does the pooling.
 *
 * 2. Everywhere else (Vercel, local `next dev`, scripts, the realtime server
 *    is not a DB client): `DATABASE_URL` (preferred) with `POSTGRES_URL` as a
 *    fallback, exactly as before. SSL is enabled automatically for non-local
 *    hosts.
 *
 * The two paths share all pool/SSL handling below; only the *source* of the
 * connection string differs. That keeps the Vercel behavior byte-for-byte
 * identical.
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

/**
 * Symbol under which `@opennextjs/cloudflare` places the Cloudflare context
 * (its worker entrypoint in production, `initOpenNextCloudflareForDev` in dev).
 * This is the same slot its exported `getCloudflareContext()` helper reads.
 *
 * Why not call `getCloudflareContext()` directly? That package is ESM-only
 * (`"type": "module"`) while this project compiles to CommonJS
 * (`tsconfig: module: node16`), so a static import raises TS1479 — and this
 * getter is synchronous, so `await import(...)` is not an option. Reading the
 * global slot avoids the interop problem entirely and means no OpenNext code
 * is pulled into the Vercel/Node bundle.
 */
const CLOUDFLARE_CONTEXT_SYMBOL = Symbol.for("__cloudflare-context__");

type CloudflareContextLike = {
  env?: { HYPERDRIVE?: { connectionString?: string } };
};

/**
 * Returns the Hyperdrive connection string when this code is running on
 * Cloudflare Workers, or `null` on every other runtime (Vercel, Node scripts,
 * unit tests, `next dev`), where the global slot is simply absent.
 */
function getHyperdriveConnectionString(): string | null {
  try {
    const context = (globalThis as Record<symbol, unknown>)[
      CLOUDFLARE_CONTEXT_SYMBOL
    ] as CloudflareContextLike | undefined;
    const connectionString = context?.env?.HYPERDRIVE?.connectionString;
    return typeof connectionString === "string" && connectionString.length > 0
      ? connectionString
      : null;
  } catch {
    // A malformed/partial context must never take down DB access — fall back
    // to the environment variables below.
    return null;
  }
}

export function getPool(): Pool {
  if (poolInstance) return poolInstance;

  const connectionString =
    getHyperdriveConnectionString() ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    "";

  if (!connectionString) {
    throw new Error(
      "No database connection string available. Set DATABASE_URL in your runtime environment (for example, Vercel Project Settings > Environment Variables), or bind Cloudflare Hyperdrive as HYPERDRIVE.",
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
    //
    // On Workers this also bounds how long a socket that was closed while the
    // isolate was suspended can linger in the pool.
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
    //
    // Hyperdrive terminates TLS on the Worker's behalf, so this applies to
    // that path too — the connection string it hands back is a normal
    // Postgres DSN.
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  });

  return poolInstance;
}
