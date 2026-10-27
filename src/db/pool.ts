import fs from "node:fs";

import { Pool } from "pg";

/**
 * Shared singleton Postgres pool for the whole app.
 *
 * Every DB access path (Drizzle ORM, the `sql` helpers, cron jobs) goes
 * through this one pool so connection counts stay predictable regardless
 * of which module does the query. The connection string is read from
 * `DATABASE_URL` (preferred) with `POSTGRES_URL` as a fallback — point
 * whichever one you use at your Postgres provider (Supabase pooler or
 * direct connection both work).
 *
 * TLS is verified on every non-local connection against the provider's own
 * root CA, which the operator installs on the host and names with
 * `DATABASE_SSL_CA_PATH`. There is no unverified path and no fallback: a
 * non-local connection either verifies the server certificate or throws
 * before a socket is opened. See
 * `docs/SUPABASE_MIGRATION.md` → "Verifying the database certificate".
 */
let poolInstance: Pool | null = null;

/** Names the PEM CA bundle used to verify non-local TLS. */
export const SSL_CA_PATH_ENV = "DATABASE_SSL_CA_PATH";

/**
 * Where an installed release expects the CA bundle: alongside the env files,
 * outside `releases/`, which is also the only place the release tooling
 * accepts certificate material (`deploy/lib/inspect.mjs`).
 */
export const PRODUCTION_SSL_CA_PATH = "/home/ubuntu/grynd/env/db-ca.pem";

/** Verified TLS: pinned CA, and verification that cannot be switched off. */
export type VerifiedSslOptions = { ca: string; rejectUnauthorized: true };

const LOCAL_HOST = /localhost|127\.0\.0\.1|::1/;

function extractHost(connectionString: string): string {
  try {
    return new URL(connectionString).hostname || "";
  } catch {
    // Not a parseable URL. An empty host is NOT local, so the connection is
    // treated as remote and must present a verifiable certificate — the safe
    // direction to fail in.
    return "";
  }
}

/**
 * The `ssl` option for a connection, or `undefined` for a local host.
 *
 * Never returns an option that skips verification: a non-local connection
 * either verifies against the operator-supplied CA or throws here, before
 * anything is dialled. The thrown messages name the variable and the path
 * only — never the connection string, and never any of its certificate
 * contents, which would end up in logs.
 *
 * @param connectionString already stripped of `sslmode` (see `getPool`)
 * @param env process environment, injectable for tests
 */
export function resolveSslConfig(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
): VerifiedSslOptions | undefined {
  const host = extractHost(connectionString);

  // Local development is unchanged: no TLS on the loopback, so no CA to
  // install and no requirement to set one.
  if (LOCAL_HOST.test(host)) return undefined;

  const target = host || "this database host";
  const caPath = (env[SSL_CA_PATH_ENV] || "").trim();

  if (!caPath) {
    throw new Error(
      `${SSL_CA_PATH_ENV} is not set, so the TLS certificate presented by ${target} cannot be verified. ` +
        `Install the root CA bundle published by your database provider and set ${SSL_CA_PATH_ENV} to its path ` +
        `(production: ${PRODUCTION_SSL_CA_PATH}, configured in /home/ubuntu/grynd/env/app.env). ` +
        `Certificate verification is not disabled to work around a missing bundle.`,
    );
  }

  let ca: string;
  try {
    ca = fs.readFileSync(caPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code || "unreadable";
    throw new Error(
      `${SSL_CA_PATH_ENV} points at ${caPath}, which could not be read (${code}). ` +
        `The file must exist and be readable by the account that runs the app; no unverified fallback is used.`,
    );
  }

  if (!ca.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error(
      `${SSL_CA_PATH_ENV} points at ${caPath}, which is not a PEM certificate bundle. ` +
        `Point it at the PEM root CA published by the provider, not a DER file or an empty one.`,
    );
  }

  return { ca, rejectUnauthorized: true };
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

  // `pg` parses the connection string and assigns the result OVER the explicit
  // options (`Object.assign({}, config, parse(connectionString))` in
  // node_modules/pg/lib/connection-parameters.js), so an `sslmode` query param
  // would replace the `ssl` option below in either direction: `sslmode=require`
  // becomes `{}` (verify the server, but against no CA — which rejects the
  // pooler's chain with SELF_SIGNED_CERT_IN_CHAIN) and `sslmode=no-verify`
  // becomes an option that skips verification altogether, undoing the pinning
  // this function establishes. TLS is therefore controlled solely by
  // `resolveSslConfig()`, and `sslmode` is removed from the URL so it cannot
  // override it.
  const sanitizedConnectionString = connectionString.replace(
    /([?&])sslmode=[^&]*(&|$)/g,
    (_match, prefix: string, suffix: string) => (suffix === "&" ? prefix : ""),
  );

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
    // Cloud Postgres (Supabase, Neon, RDS) requires TLS. Local dev Postgres
    // usually doesn't have it enabled, so this is undefined for the loopback.
    ssl: resolveSslConfig(sanitizedConnectionString),
  });

  return poolInstance;
}
