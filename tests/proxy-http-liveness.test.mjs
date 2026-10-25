/**
 * proxy-http-liveness.test.mjs — the production server must ANSWER, not hang.
 *
 * This is the end-to-end regression for the zero-byte hang: it starts the real
 * production server (`next start`) on a free loopback port and asserts that the
 * homepage, the sign-in page and the health endpoint all come back with a
 * bounded, meaningful response.
 *
 * BEFORE the fix in `src/lib/security/middlewareSelfRewrite.ts`, each page
 * request was proxied to the server itself (Clerk rewrites to the request's own
 * absolute url, Next treats that as external on the Node runtime), so `/` and
 * `/sign-in` returned ZERO bytes until the 30s proxyTimeout and then a 500
 * "Internal Server Error", while the log filled with
 * `MaxListenersExceededWarning … close listeners added to [ServerResponse]`.
 * This test fails on that behaviour (bounded time, real body) and passes after.
 *
 * Skipped — with the reason printed — when it cannot be meaningful:
 *   • no production build (run `npm run build` first);
 *   • no Clerk secret, because the proxy then short-circuits and never reaches
 *     the code path that emitted the self-rewrite.
 *
 * Run:  node --import tsx --test tests/proxy-http-liveness.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";

const NEXT_BIN = "node_modules/next/dist/bin/next";
const BUILD_ID = ".next/BUILD_ID";

/** A free loopback port, handed to the child process. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * True when a Clerk secret is configured for the app.
 *
 * Only the KEY is inspected — the value is never read into an assertion, printed
 * or logged.
 */
function hasClerkSecret() {
  if (process.env.CLERK_SECRET_KEY) return true;
  for (const file of [".env.local", ".env.production", ".env"]) {
    if (!existsSync(file)) continue;
    const configured = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .some((line) => /^CLERK_SECRET_KEY=\S/.test(line));
    if (configured) return true;
  }
  return false;
}

const SKIP = !existsSync(BUILD_ID)
  ? "no production build — run `npm run build` first"
  : !hasClerkSecret()
    ? "no Clerk secret configured, so the proxy would short-circuit and the bug cannot reproduce"
    : false;

/** GET with a hard deadline; returns status, body length and elapsed ms. */
async function get(url, timeoutMs = 12_000) {
  const startedAt = Date.now();
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "manual",
  });
  const body = await response.text();
  return { status: response.status, bytes: body.length, ms: Date.now() - startedAt, body };
}

/** Start `next start`, wait until it serves a static file, and return a handle. */
async function startServer() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let log = "";
  const child = spawn(
    process.execPath,
    [NEXT_BIN, "start", "-H", "127.0.0.1", "-p", String(port)],
    { env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`next start never became ready on ${base}\n${log.slice(-2000)}`);
    }
    try {
      // A static file: it bypasses the proxy matcher, so this only proves the
      // HTTP server is up — not that the request pipeline works.
      const ping = await get(`${base}/manifest.json`, 2_000);
      if (ping.status === 200) break;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return { base, child, log: () => log, stop: () => child.kill() };
}

test(
  "production: the homepage, sign-in and health endpoint answer instead of hanging",
  { skip: SKIP },
  async (t) => {
    const server = await startServer();
    t.after(() => server.stop());

    // The three routes the outage was measured on. A healthy Node server answers
    // each of them in well under two seconds; the pre-fix behaviour was 30s and
    // then a 500 with a 21-byte body.
    for (const path of ["/", "/sign-in"]) {
      const response = await get(`${server.base}${path}`);
      assert.equal(response.status, 200, `${path} should render (got ${response.status})`);
      assert.ok(response.bytes > 1_000, `${path} should return a real page, got ${response.bytes} bytes`);
      assert.ok(response.ms < 10_000, `${path} should answer promptly, took ${response.ms}ms`);
    }

    const health = await get(`${server.base}/api/health`);
    assert.equal(health.status, 200, `health should report 200, got ${health.status}: ${health.body}`);
    const report = JSON.parse(health.body);
    assert.equal(report.ok, true, "and it should be a real report, not a fixed string");
    assert.ok("db" in report, "including the database dependency");
    assert.ok(health.ms < 10_000, `health should answer promptly, took ${health.ms}ms`);

    // A static asset keeps working (the fix touches only header normalisation).
    const manifest = await get(`${server.base}/manifest.json`);
    assert.equal(manifest.status, 200);

    // The two journal signatures of the outage must not appear.
    const log = server.log();
    assert.equal(
      /Failed to proxy \S+\s+Error: socket hang up/.test(log),
      false,
      "the server must not proxy to itself",
    );
    assert.equal(
      /MaxListenersExceededWarning/.test(log),
      false,
      "no listener leak from abandoned proxy passes",
    );
  },
);
