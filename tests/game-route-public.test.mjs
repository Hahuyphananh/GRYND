/**
 * game-route-public.test.mjs
 *
 * Guards the "a signed-out visitor can READ a game lobby" contract at its
 * single source of truth: `GAME_ROUTE_PATTERNS` in src/proxy.ts.
 *
 * A guest is supposed to browse every lobby and only be asked to sign in when
 * they press PLAY (src/components/lobby/PvpLobby.jsx). That only holds if the
 * proxy classifies the route as a game route: `isGameRoute()` is what lets the
 * request skip the `/sign-in` bounce, and anything the proxy does NOT recognise
 * falls through to the auth gate and 307s straight to /sign-in.
 *
 * This has already regressed once — mini-golf, speed-typing, tic-tac-toe,
 * solitaire-duel and sudoku-duel were added to the public hub
 * (src/app/casino/PageClient.jsx `games[].href`) but never added to the list,
 * so those five lobbies bounced guests to /sign-in while the other eighteen
 * worked. Enumerating the app directory here means the NEXT game added cannot
 * repeat it.
 *
 * Run: npm run test:game-routes
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createRouteMatcher } from "@clerk/nextjs/server";

const read = (rel) => readFileSync(rel, "utf8");

const PROXY = read("src/proxy.ts");
const HUB = read("src/app/casino/PageClient.jsx");

/** The literal entries of the `GAME_ROUTE_PATTERNS` array in src/proxy.ts. */
function gameRoutePatterns() {
  const start = PROXY.indexOf("const GAME_ROUTE_PATTERNS");
  assert.ok(start > 0, "GAME_ROUTE_PATTERNS must exist in src/proxy.ts");
  const block = PROXY.slice(start, PROXY.indexOf("] as const;", start));
  return [...block.matchAll(/"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((pattern) => pattern.startsWith("/"));
}

/** Slugs with a real top-level lobby page, e.g. `mini-golf`. */
function casinoLobbySlugs() {
  return readdirSync("src/app/casino", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((slug) =>
      ["page.js", "page.jsx", "page.ts", "page.tsx"].some((file) =>
        existsSync(join("src/app/casino", slug, file)),
      ),
    )
    .sort();
}

/** Slugs the public hub links to, from `href: "/games/<slug>"`. */
function hubSlugs() {
  return [...HUB.matchAll(/href:\s*"\/games\/([a-z0-9-]+)"/g)]
    .map((m) => m[1])
    .sort();
}

const PATTERNS = gameRoutePatterns();

// The SAME matcher the proxy builds, over the SAME patterns — so this test
// cannot drift from the real classification semantics.
const isGameRoute = createRouteMatcher([...PATTERNS]);
const matches = (pathname) => isGameRoute({ nextUrl: { pathname } });

test("the pattern list is parsed from the real source, both URL prefixes", () => {
  assert.ok(PATTERNS.length >= 40, `expected the full list, got ${PATTERNS.length}`);
  // next.config.js rewrites /games/* -> /casino/* and 308s /casino/* -> /games/*,
  // so a request can reach the proxy with either prefix.
  assert.ok(PATTERNS.includes("/casino/uno(.*)"));
  assert.ok(PATTERNS.includes("/games/uno(.*)"));
});

test("every lobby page in the casino app is classified as a game route", () => {
  const missing = casinoLobbySlugs().filter(
    (slug) => !matches(`/casino/${slug}`) || !matches(`/games/${slug}`),
  );
  assert.deepEqual(
    missing,
    [],
    "a game with a lobby page but no GAME_ROUTE_PATTERNS entry bounces " +
      "signed-out visitors to /sign-in — add it to src/proxy.ts",
  );
});

test("every game the public hub advertises is classified as a game route", () => {
  const missing = hubSlugs().filter(
    (slug) => !matches(`/casino/${slug}`) || !matches(`/games/${slug}`),
  );
  assert.deepEqual(
    missing,
    [],
    "the hub links to these games, so a guest clicking one must reach the " +
      "lobby rather than the sign-in page",
  );
});

test("every game the hub advertises has a lobby page behind it", () => {
  // A card pointing at a page that no longer exists is a 404 waiting to
  // happen. (The reverse is deliberately NOT asserted: some routes are
  // aliases rather than separate cards — /casino/uno serves the "Neon Flush"
  // lobby that the hub links as /games/neon-flush.)
  const inApp = new Set(casinoLobbySlugs());
  assert.deepEqual(
    hubSlugs().filter((slug) => !inApp.has(slug)),
    [],
    "the hub advertises a game with no lobby page",
  );
});

test("sub-routes of a game stay game routes, so they cannot be read as guests", () => {
  // A deep link to a board/match page must be classified too — the guest
  // allowance is a page read, not an exemption from matchmaking enforcement.
  assert.ok(matches("/games/tic-tac-toe/match/abc"));
  assert.ok(matches("/games/speed-typing/abc-123"));
  assert.ok(matches("/casino/tic-tac-toe"));
  assert.ok(matches("/uno"));
});

test("the proxy still gates PLAY and still age-checks signed-in players", () => {
  // The three branches that make the guest read safe. If any is refactored
  // away, a guest would silently be able to start something again — or a
  // signed-in minor would slip past the age gate.
  assert.match(PROXY, /const browsingGameSignedOut = !userId && isGameRoute\(pathname\);/);
  assert.match(PROXY, /if \(!userId && !browsingGameSignedOut\) \{/);
  assert.match(PROXY, /if \(userId && !skipsAgeGate\) \{/);
});

test("regression: the five lobbies added after the list was written are covered", () => {
  for (const slug of [
    "mini-golf",
    "speed-typing",
    "tic-tac-toe",
    "solitaire-duel",
    "sudoku-duel",
  ]) {
    assert.ok(matches(`/casino/${slug}`), `/casino/${slug} must be public to read`);
    assert.ok(matches(`/games/${slug}`), `/games/${slug} must be public to read`);
  }
});
