/**
 * memory-grid-forfeit.test.mjs
 *
 * REGRESSION — the Forfeit button answered 415 "Invalid content type".
 *
 * The proxy's transport guard answers 415 to ANY POST/PUT/PATCH under /api
 * whose content-type is not application/json — body or no body (see
 * `src/proxy.ts`). Memory Grid's forfeit was a bodyless POST that declared no
 * content-type, so a player could never resign: the request died in the
 * middleware before the route ran.
 *
 * This suite drives the REAL proxy module — not a copy of its rules — with the
 * exact request each side of the seam produces:
 *
 *   1. a bare POST (what shipped) is refused with the 415 players saw;
 *   2. the same POST with the JSON content-type clears the guard;
 *   3. a non-JSON content-type is still refused, so the check is on the value;
 *   4. the Forfeit button's fetch declares the method AND the header, and every
 *      Memory Grid POST pairs with the JSON header, so the client cannot drift
 *      back to the broken shape.
 *
 * Clerk is configured so the proxy runs its guards instead of short-circuiting
 * on `hasClerkSecretKey`. The keys are well-formed throwaways: Clerk validates
 * the publishable key's FORMAT, and a sessionless request never reaches the
 * network. Telemetry is disabled so the suite stays offline.
 *
 * Run:  node --import tsx --test tests/memory-grid-forfeit.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.CLERK_TELEMETRY_DISABLED = "1";
// A placeholder, not a credential: Clerk only needs the value to be present for
// the proxy's token verification path to be initialised (the tokens in this
// suite are constructed by the suite itself). Named like the other suites' so
// it can never be mistaken for a real key.
process.env.CLERK_SECRET_KEY = "sk_test_memory_grid_suite";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY =
  "pk_test_" +
  Buffer.from("memory-grid-test.clerk.accounts.dev$").toString("base64");

// Imported AFTER the keys are set: the proxy reads them at module load.
const { default: proxy } = await import("../src/proxy.ts");
const { NextRequest } = await import("next/server");

const MATCH_CLIENT = "src/app/casino/memory-grid/[matchId]/PageClient.tsx";
const LOBBY_CLIENT = "src/app/casino/memory-grid/PageClient.tsx";
const FORFEIT_PATH = "/api/memory-grid/match/1/forfeit";

const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

function forfeitRequest({ contentType } = {}) {
  const headers = new Headers({
    host: "localhost:3000",
    origin: "http://localhost:3000",
  });
  if (contentType) headers.set("content-type", contentType);
  return new NextRequest(`http://localhost:3000${FORFEIT_PATH}`, {
    method: "POST",
    headers,
  });
}

const runProxy = (req) => proxy(req, { waitUntil() {} });

/* -------------------------------------------------------------------------- *
 * 1. The middleware, driven with the forfeit request
 * -------------------------------------------------------------------------- */

test("the proxy refuses the bare forfeit POST — the bug players hit", async () => {
  const res = await runProxy(forfeitRequest());

  assert.equal(res.status, 415);
  assert.deepEqual(await res.json(), {
    success: false,
    error: "Invalid content type. Expected application/json.",
  });
});

test("the JSON content type clears the proxy so the forfeit route can run", async () => {
  const res = await runProxy(forfeitRequest({ contentType: "application/json" }));

  // `NextResponse.next()` — the middleware passes the request through instead
  // of rejecting it. That is all the client is responsible for here; the route
  // then authenticates the seat and settles the match server-side.
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "");
});

test("a non-JSON content type is still refused (the guard checks the value)", async () => {
  const res = await runProxy(forfeitRequest({ contentType: "text/plain" }));

  assert.equal(res.status, 415);
});

/* -------------------------------------------------------------------------- *
 * 2. The client actually sends what the middleware requires
 * -------------------------------------------------------------------------- */

/** Source of the first `fetch(...)` call that mentions `needle`. */
function fetchCallContaining(src, needle) {
  const at = src.indexOf(needle);
  if (at === -1) return null;

  const start = src.lastIndexOf("fetch(", at);
  if (start === -1) return null;

  let depth = 0;
  let quote = null;
  for (let i = start + "fetch".length; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth += 1;
    else if (ch === ")" && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

test("the Forfeit button declares POST + the JSON content type", () => {
  const call = fetchCallContaining(read(MATCH_CLIENT), "/forfeit");

  assert.ok(call, "the match page must still POST to the forfeit endpoint");
  assert.match(call, /method:\s*"POST"/);
  assert.match(call, /"Content-Type":\s*"application\/json"/);
  assert.match(call, /\/api\/memory-grid\/match\/\$\{matchId\}\/forfeit/);
});

test("every Memory Grid POST pairs with a JSON content type", () => {
  // The proxy answers 415 to a POST without one — body or no body — so losing
  // a single header silently breaks the button it belongs to. Pin the pairing
  // for create/join/cancel as well, not just forfeit.
  for (const file of [LOBBY_CLIENT, MATCH_CLIENT]) {
    const src = read(file);
    const posts = (src.match(/method: "POST"/g) ?? []).length;
    const jsonHeaders = (src.match(/"Content-Type": "application\/json"/g) ?? []).length;

    assert.ok(posts > 0, `${file} is expected to issue POSTs`);
    assert.equal(
      jsonHeaders,
      posts,
      `${file}: ${posts} POST(s) but ${jsonHeaders} JSON content type header(s) — a POST without one gets a 415`,
    );
  }
});
