/**
 * memory-grid-forfeit.test.mjs
 *
 * ARCHIVED-GAME BOUNDARY — Memory Grid is archived by the Solitaire-first
 * transition (src/lib/gameAvailability.js). Its implementation, tables and
 * routes all stay in the repository, but `src/proxy.ts` closes every
 * game-specific API namespace it owns with a plain 404 before rate limiting,
 * CSRF, the content-type guard or the route handler can run.
 *
 * This suite drives the REAL proxy module — not a copy of its rules — with the
 * exact requests the old clients produce:
 *
 *   1. every content-type shape on the forfeit endpoint (bare POST, JSON POST,
 *      text/plain POST) is answered with the archived-game 404, so the endpoint
 *      is unreachable no matter what a stale client sends;
 *   2. that 404 wins over the transport guard: a bare POST that would be a 415
 *      on an active route is a 404 here, which is what proves the availability
 *      gate runs first;
 *   3. the application/json content-type guard is still enforced, driven
 *      through an ACTIVE route (Solitaire Duel's forfeit endpoint) so the
 *      protection is proven without pretending an archived route is reachable;
 *   4. the preserved Memory Grid clients still pair every POST with the JSON
 *      header, so the archived code stays valid if the game is ever
 *      reactivated.
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

import { GAME_UNAVAILABLE_MESSAGE } from "../src/lib/gameAvailability.js";

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

/** Archived: the proxy answers this namespace with a 404. */
const ARCHIVED_FORFEIT_PATH = "/api/memory-grid/match/1/forfeit";
/** Active: the one public game, used to exercise the transport guard. */
const ACTIVE_FORFEIT_PATH = "/api/solitaire-duel/match/1/forfeit";

const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

function postRequest(pathname, { contentType } = {}) {
  const headers = new Headers({
    host: "localhost:3000",
    origin: "http://localhost:3000",
  });
  if (contentType) headers.set("content-type", contentType);
  return new NextRequest(`http://localhost:3000${pathname}`, {
    method: "POST",
    headers,
  });
}

const runProxy = (req) => proxy(req, { waitUntil() {} });

/* -------------------------------------------------------------------------- *
 * 1. The middleware, driven with the archived forfeit request
 * -------------------------------------------------------------------------- */

test("the archived forfeit endpoint is a 404 for every content type", async () => {
  // The seat check, the settlement and the 415 regression all lived behind this
  // route. It is closed now, so the ONLY correct answer — body or no body, JSON
  // or not — is the availability 404.
  for (const contentType of [undefined, "application/json", "text/plain"]) {
    const res = await runProxy(postRequest(ARCHIVED_FORFEIT_PATH, { contentType }));

    assert.equal(res.status, 404, `content-type: ${contentType ?? "none"}`);
    assert.deepEqual(await res.json(), {
      success: false,
      gameUnavailable: true,
      error: GAME_UNAVAILABLE_MESSAGE,
    });
  }
});

test("the archived namespace is closed before the 415 guard, not by it", async () => {
  // A bare POST is a 415 on an active route (next test) but a 404 here: the
  // availability gate runs ahead of rate limiting, CSRF and content type, so no
  // archived handler, socket or matchmaking query is ever started.
  const bare = await runProxy(postRequest(ARCHIVED_FORFEIT_PATH));
  assert.equal(bare.status, 404);
  assert.equal(bare.status === 415, false, "the 415 guard must not be what closes it");
});

/* -------------------------------------------------------------------------- *
 * 2. The transport guard itself, proven on an active route
 * -------------------------------------------------------------------------- */

test("the application/json content type guard still protects an active route", async () => {
  const bare = await runProxy(postRequest(ACTIVE_FORFEIT_PATH));
  assert.equal(bare.status, 415);
  assert.deepEqual(await bare.json(), {
    success: false,
    error: "Invalid content type. Expected application/json.",
  });

  const json = await runProxy(
    postRequest(ACTIVE_FORFEIT_PATH, { contentType: "application/json" }),
  );
  // `NextResponse.next()` — the middleware passes the request through instead
  // of rejecting it; the route then authenticates the seat and settles the
  // match server-side.
  assert.equal(json.status, 200);
  assert.equal(await json.text(), "");

  const text = await runProxy(
    postRequest(ACTIVE_FORFEIT_PATH, { contentType: "text/plain" }),
  );
  assert.equal(text.status, 415, "the guard checks the value, not just its presence");
});

/* -------------------------------------------------------------------------- *
 * 3. The preserved clients still send what the middleware requires
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

test("the preserved Memory Grid clients post to the archived endpoint with JSON", () => {
  const call = fetchCallContaining(read(MATCH_CLIENT), "/forfeit");

  assert.ok(call, "the match page must keep POSTing to the forfeit endpoint");
  assert.match(call, /method:\s*"POST"/);
  assert.match(call, /"Content-Type":\s*"application\/json"/);
  assert.match(call, /\/api\/memory-grid\/match\/\$\{matchId\}\/forfeit/);
});

test("every preserved Memory Grid POST pairs with a JSON content type", () => {
  // Reactivating the game must not resurrect the 415 bug: the proxy still
  // answers 415 to a POST without the header, so pin the pairing for
  // create/join/cancel as well, not just forfeit.
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
