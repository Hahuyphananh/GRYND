import { Client, Pool, type QueryResult } from "pg";

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
 *    Why Hyperdrive is REQUIRED for Supabase (not merely an optimization):
 *    Workers TCP sockets always validate the origin's certificate and expose no
 *    `rejectUnauthorized` / custom-CA option (`node:tls` on workerd throws
 *    "The options.rejectUnauthorized option is not implemented"). Supabase's
 *    pooler (`*.pooler.supabase.com:6543`) and direct host
 *    (`db.<ref>.supabase.co:5432`) both serve a chain rooted at the private
 *    "Supabase Root 2021 CA", so the handshake is rejected by the runtime —
 *    and `pg` reports that as the unhelpful "Connection terminated
 *    unexpectedly", which is what a DATABASE_URL-only Worker hits. Hyperdrive
 *    terminates the origin connection itself, which is why binding it fixes it.
 *
 *    The Worker → Hyperdrive hop is an internal address and is deliberately NOT
 *    TLS (see the `ssl` option below), so nothing in this file has to negotiate
 *    TLS for the database on Workers.
 *
 * 2. Everywhere else (Vercel, local `next dev`, scripts): `DATABASE_URL`
 *    (preferred) with `POSTGRES_URL` as a fallback, exactly as before. SSL is
 *    enabled automatically for non-local hosts.
 *
 * The two paths share all pool/SSL handling below; only the *source* of the
 * connection string differs. That keeps the Vercel behavior byte-for-byte
 * identical.
 */
let poolInstance: Pool | null = null;

/**
 * Test-only: drop the cached pool so a test can re-read the connection source.
 * The pool is a module-level singleton, so without this a second case in the
 * same process would keep whichever pool was built first. Mirrors
 * `resetEdgeMaintenanceCache` in src/lib/security/edgeFlags.ts.
 */
export function resetPoolForTests(): void {
  poolInstance = null;
}

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

/**
 * Workers + Hyperdrive: a connection-per-operation "pool".
 *
 * A real `Pool` cannot be used on Workers. When a request stalls, the runtime
 * cancels it and takes its async context with it — so pg-pool never gets the
 * checked-out client back. Once `_clients.length` reaches `max`, EVERY later
 * query in that isolate fails with "timeout exceeded when trying to connect"
 * (that message is pg-pool's *check-out* timeout, not a connect). Because a
 * Worker isolate is long-lived and shared, one stalled request poisons the
 * database for every request that follows it.
 *
 * Measured on the deployed Worker: ~50% of `/api/health` requests failed, an
 * eight-query burst timed out on all eight, and short idle timeouts did NOT
 * help (the stuck client is checked out, not idle). Fresh one-shot clients were
 * 6/6 reliable at 4-300ms.
 *
 * Cloudflare's own pg + Hyperdrive example avoids this by creating a client per
 * request — "Hyperdrive maintains the underlying database connection pool, so
 * creating a new client is fast and recommended". This is that, per operation,
 * so nothing is ever reused and a stalled request can only ever affect itself.
 *
 * The class name and shape are load-bearing: `drizzle-orm/node-postgres`
 * decides whether it may run transactions by testing
 * `constructor.name.includes("Pool")` and then calling `connect()` and using the
 * returned client's `release()`. Transactions are used throughout this app, so
 * both have to work here.
 */
class HyperdrivePool {
  readonly options: {
    connectionString: string;
    max: number;
    connectionTimeoutMillis: number;
    /** Always undefined: Hyperdrive's endpoint answers `N` to SSLRequest. */
    ssl: undefined;
  };

  constructor(connectionString: string) {
    this.options = {
      connectionString,
      max: 1,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      ssl: undefined,
    };
  }

  /**
   * A brand-new connection. Note there is deliberately no `ssl` option:
   * Hyperdrive's own connection string carries `sslmode=disable` and its
   * endpoint answers "The server does not support SSL connections" to a
   * Postgres SSLRequest (both verified on the deployed Worker).
   */
  private async openClient(): Promise<Client> {
    const client = new Client({
      connectionString: this.options.connectionString,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      statement_timeout: 8_000,
    });
    await client.connect();
    return client;
  }

  /** One query on its own connection, closed as soon as it settles. */
  async query(text: string, params?: unknown[]): Promise<QueryResult> {
    const client = await this.openClient();
    try {
      return await client.query(text, params as any[] | undefined);
    } finally {
      await client.end().catch(() => {
        /* already gone */
      });
    }
  }

  /**
   * A dedicated connection for the caller's lifetime (Drizzle transactions).
   * `release()` is what Drizzle calls in its `finally`, so it must exist — a
   * bare `Client` only has `end()`.
   */
  async connect(): Promise<Client & { release: () => void }> {
    const client = (await this.openClient()) as Client & {
      release: () => void;
    };
    client.release = () => {
      void client.end().catch(() => {
        /* already gone */
      });
    };
    return client;
  }

  // ── pg-pool API compatibility ──────────────────────────────────────────
  // `on("error")` guards against unhandled 'error' events; a connection that
  // dies between requests can never raise one here, since none is held.
  on(): this {
    return this;
  }

  async end(): Promise<void> {
    /* nothing is held open */
  }

  /** Always zero: no connection outlives the operation that opened it. */
  get totalCount(): number {
    return 0;
  }

  get idleCount(): number {
    return 0;
  }

  get waitingCount(): number {
    return 0;
  }
}

/**
 * How long to wait for a connection before giving up. Kept at the previous
 * 5s: measured Hyperdrive connects are 4-300ms when they succeed, so anything
 * slower is a stall, and failing fast bounds the damage.
 */
const CONNECT_TIMEOUT_MS = 5_000;

export function getPool(): Pool {
  if (poolInstance) return poolInstance;

  const hyperdriveConnectionString = getHyperdriveConnectionString();
  const connectionString =
    hyperdriveConnectionString ||
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

  // Workers must never hold a connection between requests — see HyperdrivePool.
  if (hyperdriveConnectionString) {
    poolInstance = new HyperdrivePool(
      sanitizedConnectionString,
    ) as unknown as Pool;
    return poolInstance;
  }

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
    //
    // Hyperdrive is exempt on purpose: its connection string targets an
    // internal address (`.hyperdrive.local`) that does not speak the Postgres
    // SSLRequest negotiation, and Cloudflare's own example passes the string to
    // `new Client({ connectionString })` with no `ssl` option. Requesting TLS
    // there trades the certificate problem below for a "server does not support
    // SSL connections" one.
    //
    // This option is also a no-op on Workers for the DATABASE_URL path — see the
    // header: the runtime always verifies the certificate there, whatever
    // `rejectUnauthorized` says. It still does the right thing on Vercel/Node
    // against Supabase's self-signed pooler leaf.
    ssl:
      hyperdriveConnectionString || isLocal
        ? undefined
        : { rejectUnauthorized: false },
  });

  // An idle client that dies — Hyperdrive or the provider reaping a connection,
  // a network blip — makes pg-pool emit `error` on the POOL. An EventEmitter
  // `error` event with no listener THROWS, and on Workers that surfaces as an
  // uncaught exception: a 500 ("Worker threw a JavaScript exception") on
  // whichever unrelated request happens to be in flight, instead of an error on
  // the query that caused it. Measured on the first deploy with Hyperdrive
  // bound: roughly half of `/api/health` requests answered 500 this way.
  //
  // pg-pool already discards the dead client, so logging is all that is needed —
  // the next query opens a fresh connection. This is the standard node-postgres
  // guidance ("always add a pool error listener"), and without it a single
  // dropped socket can 500 an unrelated user request.
  poolInstance.on("error", (err) => {
    console.error("[db] idle pool client error:", (err as Error)?.message);
  });

  return poolInstance;
}
