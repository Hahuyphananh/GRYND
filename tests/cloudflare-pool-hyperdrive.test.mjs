/**
 * Guards the Cloudflare database path (final phase of the Vercel → Cloudflare
 * migration): Hyperdrive first, and **no TLS** on the Worker → Hyperdrive hop.
 *
 * Why the TLS half matters: Workers TCP sockets always validate the origin
 * certificate and expose no `rejectUnauthorized`/custom-CA option, and Supabase
 * serves a private-CA chain, so a direct connection dies in the handshake and
 * `pg` reports the unhelpful "Connection terminated unexpectedly" (measured —
 * see docs/CLOUDFLARE_ENV_AND_DOMAIN.md §2). Hyperdrive terminates that
 * connection itself and hands the Worker an *internal* address that does not
 * take part in the Postgres `SSLRequest` negotiation. `src/db/pool.ts` therefore
 * has to skip its `ssl` option for that path: leaving TLS on trades the
 * certificate failure for a "server does not support SSL connections" one.
 *
 * Both branches are asserted behaviourally on the Pool's own options, so a
 * future refactor cannot quietly re-enable TLS on the Hyperdrive hop or stop
 * preferring the binding.
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const POOL_PATH = "src/db/pool.ts";
const CLOUDFLARE_CONTEXT_SYMBOL = Symbol.for("__cloudflare-context__");

// Normalising CRLF -> LF keeps the source assertions valid on a Windows
// checkout (core.autocrlf=true) as well as the LF checkout CI uses.
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const DATABASE_URL =
  "postgres://user:pass@aws-1-us-east-2.pooler.supabase.com:6543/postgres?sslmode=require";
const HYPERDRIVE_URL =
  "postgres://user:pass@abc123.hyperdrive.local:5432/postgres";

// `getPool()` returns a module-level singleton, so each case has to clear it
// first (`resetPoolForTests`, the same kind of hook as
// `resetEdgeMaintenanceCache`) — otherwise the second case would keep whichever
// pool the first one built.
const poolModule = await import(`../${POOL_PATH}`);
const { getPool, resetPoolForTests } = poolModule;

test("without Hyperdrive it keeps using DATABASE_URL, with TLS for cloud hosts", () => {
  process.env.DATABASE_URL = DATABASE_URL;
  try {
    resetPoolForTests();
    const pool = getPool();

    // sslmode is stripped: pg merges the URL over the Pool options, so leaving
    // it in would clobber the explicit `ssl` option below and re-enable
    // certificate verification (SELF_SIGNED_CERT_IN_CHAIN on Supabase).
    assert.equal(
      pool.options.connectionString,
      DATABASE_URL.replace("?sslmode=require", ""),
      "sslmode must be stripped from the connection string",
    );
    assert.deepEqual(
      pool.options.ssl,
      { rejectUnauthorized: false },
      "cloud Postgres keeps TLS, and it still works as written on Vercel/Node",
    );
  } finally {
    delete process.env.DATABASE_URL;
  }
});

test("getPool() prefers the Hyperdrive binding over DATABASE_URL, and drops TLS for that hop", () => {
  process.env.DATABASE_URL = DATABASE_URL;
  globalThis[CLOUDFLARE_CONTEXT_SYMBOL] = {
    env: { HYPERDRIVE: { connectionString: HYPERDRIVE_URL } },
  };
  try {
    resetPoolForTests();
    const pool = getPool();

    assert.equal(
      pool.options.connectionString,
      HYPERDRIVE_URL,
      "the HYPERDRIVE binding must win over the DATABASE_URL fallback",
    );
    assert.equal(
      pool.options.ssl,
      undefined,
      "Hyperdrive's internal endpoint does not answer SSLRequest, so it must not be sent one",
    );
  } finally {
    delete globalThis[CLOUDFLARE_CONTEXT_SYMBOL];
    delete process.env.DATABASE_URL;
  }
});

test("the Hyperdrive path never holds a connection between requests", () => {
  globalThis[CLOUDFLARE_CONTEXT_SYMBOL] = {
    env: { HYPERDRIVE: { connectionString: HYPERDRIVE_URL } },
  };
  try {
    resetPoolForTests();
    const pool = getPool();

    // A real pg Pool reuses clients across requests; on Workers a request that
    // the runtime cancels leaves its client checked out forever, and every
    // later query in that isolate then fails (measured). So the Workers path
    // must not pool at all.
    assert.equal(
      pool.totalCount,
      0,
      "no connection may outlive the operation that opened it",
    );
    assert.equal(pool.idleCount, 0, "nothing may sit idle waiting to be reused");

    // drizzle-orm/node-postgres gates transactions on this exact check, and the
    // app uses db.transaction() widely, so the name has to keep matching.
    assert.ok(
      pool.constructor.name.includes("Pool"),
      'Drizzle decides transactions are available via constructor.name.includes("Pool")',
    );
    assert.equal(
      typeof pool.connect,
      "function",
      "Drizzle's transaction path calls pool.connect()",
    );
    assert.equal(pool.options.ssl, undefined);
  } finally {
    delete globalThis[CLOUDFLARE_CONTEXT_SYMBOL];
  }
});

test("the Workers client hands Drizzle a client it can release", () => {
  // Drizzle's `finally` block calls `session.client.release()` on whatever
  // `connect()` returned, which a bare pg Client does not have.
  assert.match(
    read(POOL_PATH),
    /client\.release = /,
    "connect() must attach release() to the client it returns",
  );
});

test("pool.ts documents why the Hyperdrive hop skips TLS", () => {
  const src = read(POOL_PATH);

  // The explanation is the only thing stopping a future reader from
  // "simplifying" the conditional back into an unconditional `ssl` option.
  assert.match(
    src,
    /rejectUnauthorized option is not implemented|always validate/i,
    "the header must record that the Workers runtime always verifies the origin certificate",
  );
  assert.match(
    src,
    /hyperdriveConnectionString \|\| isLocal/,
    "the ssl option must stay conditional on the Hyperdrive path",
  );
});
