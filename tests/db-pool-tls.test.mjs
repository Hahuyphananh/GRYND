/**
 * tests/db-pool-tls.test.mjs — the TLS postures `src/db/pool.ts` is allowed to
 * take, and the one it must never take.
 *
 * The pool is the single connection path for the whole app, so its `ssl` option
 * is the difference between "the database we reached is the one we meant" and
 * "anything answering on that host and port is trusted". The policy gate
 * (`deploy/production-fixes.json`) pins the shape of the code; this suite pins
 * its behaviour, including the two outcomes that matter most in production:
 *
 *   * a remote host with no usable CA must FAIL CLOSED — before a socket is
 *     opened — rather than connect and verify nothing;
 *   * `sslmode` in the connection string must not be able to downgrade that,
 *     because `pg` parses the URL OVER the explicit options
 *     (`Object.assign({}, config, parse(connectionString))`).
 *
 * Local development is asserted to be untouched: the loopback stays TLS-free
 * and needs no bundle installed.
 *
 * NOT covered here, deliberately: the TLS handshake itself. That needs a live
 * server and a real certificate authority, and an acceptance test against a
 * production database is not something a unit suite should perform. These tests
 * assert the configuration that handshake is performed with — including on the
 * real `Pool` instance the app would use.
 *
 * Run: node --import tsx --test tests/db-pool-tls.test.mjs   (also in `npm test`)
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "pg";

import {
  PRODUCTION_SSL_CA_PATH,
  SSL_CA_PATH_ENV,
  getPool,
  resolveSslConfig,
} from "../src/db/pool.ts";

/**
 * A PEM-shaped bundle. It is never parsed — nothing in this suite performs a
 * handshake — only read, length-checked and handed to `pg`, which is why a
 * fixture is honest here where a fake "certificate" would not be.
 */
const PEM_CA = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBkTCB+wIJAJ0notARealCertificateOnlyAFixtureForTheConfigurationTests",
  "-----END CERTIFICATE-----",
  "",
].join("\n");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "grynd-db-tls-"));

function writeFixture(name, contents) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

const CA_FILE = writeFixture("ca.pem", PEM_CA);
const NOT_PEM_FILE = writeFixture("not-a-cert.pem", "this is not a certificate\n");
const MISSING_FILE = path.join(TMP, "does-not-exist.pem");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** A remote DSN, with a password that must never reach an error message. */
const REMOTE = "postgres://grynd:sup3rsecret@db.example.supabase.com:6543/postgres";

// ── local development ─────────────────────────────────────────────────────

test("loopback hosts get no TLS option at all, and need no CA installed", () => {
  // The env is EMPTY on purpose: local dev must work without any bundle.
  for (const url of [
    "postgres://grynd@localhost:5432/grynd",
    "postgres://grynd@127.0.0.1:5432/grynd",
    "postgres://grynd@[::1]:5432/grynd",
  ]) {
    assert.equal(
      resolveSslConfig(url, {}),
      undefined,
      `${url} must connect without TLS, exactly as before this change`,
    );
  }
});

// ── fail closed: the required behaviour in production ─────────────────────

test("a remote host with no CA configured throws instead of connecting unverified", () => {
  assert.throws(
    () => resolveSslConfig(REMOTE, {}),
    (error) => {
      assert.match(error.message, new RegExp(SSL_CA_PATH_ENV), "the message must name the variable to set");
      assert.match(error.message, /cannot be verified/);
      assert.ok(
        error.message.includes(PRODUCTION_SSL_CA_PATH),
        "the message must name the path an installed release reads",
      );
      assert.ok(
        !error.message.includes("sup3rsecret"),
        "the error must never echo the connection string",
      );
      return true;
    },
  );
});

test("a CA path that cannot be read throws, and names the reason without contents", () => {
  assert.throws(
    () => resolveSslConfig(REMOTE, { [SSL_CA_PATH_ENV]: MISSING_FILE }),
    (error) => {
      assert.match(error.message, /could not be read/);
      assert.ok(error.message.includes(MISSING_FILE), "the operator needs the path that failed");
      assert.match(error.message, /ENOENT/, "the errno is what distinguishes a typo from a permission problem");
      assert.ok(!error.message.includes(PEM_CA), "certificate contents must never be logged");
      return true;
    },
  );
});

test("a file that is not a PEM bundle throws instead of being passed through", () => {
  assert.throws(
    () => resolveSslConfig(REMOTE, { [SSL_CA_PATH_ENV]: NOT_PEM_FILE }),
    /not a PEM certificate bundle/,
  );
});

test("a blank CA path is treated as missing, not as 'no CA needed'", () => {
  for (const blank of ["", "   "]) {
    assert.throws(() => resolveSslConfig(REMOTE, { [SSL_CA_PATH_ENV]: blank }), new RegExp(SSL_CA_PATH_ENV));
  }
});

// ── the secure configuration itself ───────────────────────────────────────

test("a configured CA is used, and verification is explicitly on", () => {
  assert.deepEqual(resolveSslConfig(REMOTE, { [SSL_CA_PATH_ENV]: CA_FILE }), {
    ca: PEM_CA,
    rejectUnauthorized: true,
  });
});

test("the pool the app actually builds carries the CA and cannot be downgraded by sslmode", (t) => {
  const previous = {
    DATABASE_URL: process.env.DATABASE_URL,
    POSTGRES_URL: process.env.POSTGRES_URL,
    [SSL_CA_PATH_ENV]: process.env[SSL_CA_PATH_ENV],
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // `sslmode=no-verify` is the interesting case: pg parses it to an option that
  // skips verification, and would override the pinned CA if it survived into
  // the connection string.
  process.env.DATABASE_URL = `${REMOTE}?sslmode=no-verify`;
  delete process.env.POSTGRES_URL;
  process.env[SSL_CA_PATH_ENV] = CA_FILE;

  const ssl = getPool().options.ssl;

  assert.equal(ssl.rejectUnauthorized, true, "the server certificate must be verified");
  assert.equal(ssl.ca, PEM_CA, "the pinned CA must reach the pool, not just the resolver");
  assert.ok(
    !String(getPool().options.connectionString || "").includes("sslmode"),
    "sslmode must be stripped so it cannot override the explicit ssl option",
  );
});

test("pg would silently drop the CA if sslmode were left in the URL", () => {
  // The reason getPool() sanitises the connection string, asserted against the
  // driver rather than assumed: `pg` parses the URL OVER the explicit options,
  // so the query param wins and the pinned CA never reaches the TLS layer.
  // No I/O — constructing a Client only builds ConnectionParameters.
  const pinned = { ca: PEM_CA, rejectUnauthorized: true };

  const overridden = new Client({
    connectionString: `${REMOTE}?sslmode=no-verify`,
    ssl: pinned,
  }).connectionParameters.ssl;
  assert.equal(overridden.rejectUnauthorized, false, "the URL param overrides the explicit ssl option");
  assert.equal(overridden.ca, undefined, "and the CA is discarded with it — the downgrade the strip prevents");

  const applied = new Client({ connectionString: REMOTE, ssl: pinned }).connectionParameters.ssl;
  assert.equal(applied.rejectUnauthorized, true, "stripped of sslmode, the pinned CA is what is used");
  assert.equal(applied.ca, PEM_CA);
});

test("the production CA path is the env/ directory, outside every release", () => {
  // `deploy/lib/inspect.mjs` rejects certificate material inside a release and
  // points at `<root>/env/`; the two must agree or the documented path would be
  // one the artifact gate refuses to install.
  assert.equal(PRODUCTION_SSL_CA_PATH, "/home/ubuntu/grynd/env/db-ca.pem");
  assert.ok(!PRODUCTION_SSL_CA_PATH.includes("/releases/"));
});
