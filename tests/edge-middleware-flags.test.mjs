/**
 * Guards the Cloudflare Edge-middleware contract (Phase 3 of the
 * Vercel → Cloudflare migration).
 *
 * The page middleware must stay on the EDGE runtime, because Cloudflare's
 * OpenNext adapter does not support Node.js middleware. That means:
 *
 *   1. The file must keep the `middleware` convention. Next sends `proxy.ts`
 *      to the Node server unconditionally and `middleware.ts` to the edge
 *      server (see `next/dist/build/entries.js`).
 *   2. It must never import `pg`/`db` — importing `pg` at module scope is what
 *      crashed every request with MIDDLEWARE_INVOCATION_FAILED before this
 *      refactor.
 *   3. The four DB-backed gates must read through the Edge-safe module
 *      (PostgREST over fetch), not the Node helpers.
 *
 * These are structural assertions, so a future "simplification" that
 * re-introduces a `pg` import into the middleware fails here instead of in
 * production.
 */
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const MIDDLEWARE_PATH = "src/middleware.ts";
const EDGE_FLAGS_PATH = "src/lib/security/edgeFlags.ts";
const SCHEMA_PATH = "src/db/schema.ts";

const read = (p) => readFileSync(p, "utf8");

test("the middleware uses the Edge `middleware` convention, never `proxy`", () => {
  assert.ok(
    existsSync(`${MIDDLEWARE_PATH}`),
    "src/middleware.ts must exist — the Edge convention is required by the Cloudflare adapter",
  );
  assert.ok(
    !existsSync("src/proxy.ts"),
    "src/proxy.ts must NOT exist: Next routes proxy.ts to the Node.js server unconditionally, which OpenNext cannot run",
  );

  const middleware = read(MIDDLEWARE_PATH);
  // Declaring the Node runtime would silently move it back off Edge.
  assert.doesNotMatch(
    middleware,
    /export\s+const\s+runtime\s*=\s*["']nodejs["']/,
    "middleware must not declare runtime = 'nodejs' — that is the unsupported Node.js middleware",
  );
});

test("the middleware never imports pg / db at module scope", () => {
  const middleware = read(MIDDLEWARE_PATH);

  // The exact imports that used to pull `pg` into the Edge bundle.
  assert.doesNotMatch(middleware, /from\s+["']pg["']/, "must not import pg");
  assert.doesNotMatch(
    middleware,
    /from\s+["'][^"']*\/db(?:\/["'][^"']*)?["']/,
    "must not import the db client",
  );
  assert.doesNotMatch(
    middleware,
    /from\s+["']drizzle-orm["']/,
    "must not import drizzle-orm",
  );
  assert.doesNotMatch(
    middleware,
    /from\s+["'][^"']*db\/schema["']/,
    "must not import the schema",
  );

  // The Node-only helpers are backed by pg — reaching either of these from the
  // middleware is exactly the regression this guards against.
  assert.doesNotMatch(
    middleware,
    /from\s+["'][^"']*security\/maintenance["']/,
    "must not import the Node maintenance helper (pg-backed)",
  );
  assert.doesNotMatch(
    middleware,
    /from\s+["'][^"']*auth\/isAdmin["']/,
    "must not import the Node isAdmin helper (pg-backed)",
  );
});

test("the middleware reads every DB-backed gate through the Edge-safe module", () => {
  const middleware = read(MIDDLEWARE_PATH);

  assert.match(
    middleware,
    /from\s+["']\.\/lib\/security\/edgeFlags["']/,
    "must import the Edge-safe flags module",
  );

  for (const fn of [
    "edgeIsMaintenanceMode",
    "edgeIsAdmin",
    "edgeUserAge",
    "edgeUserMfaEnabled",
  ]) {
    assert.match(
      middleware,
      new RegExp(`${fn}\\(`),
      `${fn} must actually be called by the middleware`,
    );
  }
});

test("the Edge flags module is fetch-based (no pg, no drizzle)", () => {
  const edgeFlags = read(EDGE_FLAGS_PATH);

  assert.match(edgeFlags, /@supabase\/supabase-js/, "should read via PostgREST");
  assert.doesNotMatch(edgeFlags, /from\s+["']pg["']/, "must not import pg");
  assert.doesNotMatch(
    edgeFlags,
    /from\s+["']drizzle-orm["']/,
    "must not import drizzle-orm",
  );
  assert.doesNotMatch(
    edgeFlags,
    /from\s+["'][^"']*\/db(?:\/["'][^"']*)?["']/,
    "must not import the db client",
  );
});

test("maintenance constants cannot drift from the schema", () => {
  // The Edge module re-declares these (importing src/db/schema.ts into the Edge
  // bundle would pull the whole schema in) — so pin the literal values to the
  // schema's source of truth.
  const schema = read(SCHEMA_PATH);
  const edgeFlags = read(EDGE_FLAGS_PATH);

  const schemaKey = schema.match(
    /export const MAINTENANCE_MODE_KEY\s*=\s*"([^"]+)"/,
  )?.[1];
  const schemaOn = schema.match(
    /export const MAINTENANCE_MODE_ON\s*=\s*"([^"]+)"/,
  )?.[1];

  assert.ok(schemaKey, "schema must export MAINTENANCE_MODE_KEY");
  assert.ok(schemaOn, "schema must export MAINTENANCE_MODE_ON");

  assert.match(
    edgeFlags,
    new RegExp(`MAINTENANCE_MODE_KEY\\s*=\\s*"${schemaKey}"`),
    `edgeFlags MAINTENANCE_MODE_KEY must equal the schema's "${schemaKey}"`,
  );
  assert.match(
    edgeFlags,
    new RegExp(`MAINTENANCE_MODE_ON\\s*=\\s*"${schemaOn}"`),
    `edgeFlags MAINTENANCE_MODE_ON must equal the schema's "${schemaOn}"`,
  );
});
