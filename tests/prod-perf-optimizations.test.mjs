/**
 * Production-performance optimization contracts.
 *
 * These pin the safe, verifiable optimizations from the perf pass:
 *
 *   1. `useMembershipStatus` shares ONE request across every upgrade surface in
 *      a tab (the home page mounts both <UpgradeProButton> and <GryndProWidget>).
 *   2. Public, user-agnostic lobby listings are edge-cacheable so a burst of
 *      polling clients collapses to one origin invocation — and they must stay
 *      UNAUTHENTICATED (no per-user data) for that to be safe.
 *
 * Run:  node --import tsx --test tests/prod-perf-optimizations.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

/** `//` line comments removed, so prose can't satisfy a code check. */
const code = (p) =>
  read(p)
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

const UPGRADE_HOOK = "src/lib/upgradePro.ts";
const CACHE_HELPER = "src/lib/httpCache.ts";

// The public lobby listings that were given the shared cache header. Depth
// differs, so the helper path is asserted generically.
const PUBLIC_LOBBY_ROUTES = [
  "src/app/api/chess/available-games/route.js",
  "src/app/api/dots-and-boxes/available-games/route.js",
  "src/app/api/four-in-a-row/available-games/route.js",
  "src/app/api/hex-duel/multiplayer/available/route.ts",
  "src/app/api/keno-pvp/available/route.js",
  "src/app/api/memory-grid/available/route.js",
  "src/app/api/mines-pvp/available/route.js",
  "src/app/api/rps/pvp/available/route.js",
];

// ── 1. Membership request dedup ──────────────────────────────────────────

test("membership status is fetched once per tab, not once per component", () => {
  const hook = code(UPGRADE_HOOK);

  // A single module-level request path with an in-flight guard and a
  // subscriber set — the three pieces that turn N components into 1 request.
  assert.equal(
    countOf(hook, 'fetch("/api/membership/status"'),
    1,
    "there is exactly one membership fetch",
  );
  assert.match(hook, /let membershipInflight: Promise<void> \| null = null;/);
  assert.match(hook, /if \(membershipInflight\) return membershipInflight;/);
  assert.match(hook, /const membershipSubscribers = new Set</);
  assert.match(hook, /function publishMembership\(/);
  assert.match(hook, /membershipSubscribers\.add\(notify\)/);
  assert.match(hook, /membershipSubscribers\.delete\(notify\)/);

  // A short TTL and a forced refresh keep it from ever being stale for long.
  assert.match(hook, /const MEMBERSHIP_TTL_MS = 30_000;/);
  assert.match(hook, /async function loadMembership\(force: boolean\)/);
  assert.match(hook, /await loadMembership\(true\)/);

  // Security is unchanged: `active` still comes ONLY from the response body and
  // only for a Pro tier — the cache can never manufacture an entitlement.
  assert.match(hook, /active: Boolean\(data\?\.active\) && data\?\.tier === "pro"/);
  assert.doesNotMatch(hook, /(localStorage|sessionStorage)\s*\./);
});

test("every upgrade surface still goes through the shared hook", () => {
  for (const file of [
    "src/components/UpgradeProButton.tsx",
    "src/components/GryndProWidget.tsx",
    "src/app/upgrade-pro/PageClient.tsx",
  ]) {
    const src = code(file);
    assert.match(src, /useMembershipStatus\(\)/, `${file} uses the shared hook`);
    assert.doesNotMatch(
      src,
      /fetch\("\/api\/membership\/status"/,
      `${file} must not fetch membership directly`,
    );
  }
});

// ── 2. Public lobby-listing caching ──────────────────────────────────────

test("the shared cache header is public, short, and never no-store", () => {
  const helper = code(CACHE_HELPER);
  assert.match(helper, /export const PUBLIC_LOBBY_CACHE_HEADERS/);
  assert.match(helper, /"Cache-Control": "public, s-maxage=5, stale-while-revalidate=5"/);
  assert.doesNotMatch(helper, /no-store/);
  // Short enough that a freshly opened lobby is visible within one poll cycle.
  const sMaxAge = Number(helper.match(/s-maxage=(\d+)/)?.[1]);
  assert.ok(sMaxAge > 0 && sMaxAge <= 10, `s-maxage ${sMaxAge}s`);
});

test("public lobby listings are edge-cached AND unauthenticated", () => {
  for (const route of PUBLIC_LOBBY_ROUTES) {
    const src = code(route);
    assert.match(
      src,
      /import \{ PUBLIC_LOBBY_CACHE_HEADERS \} from "[./]*lib\/httpCache";/,
      `${route} imports the cache header`,
    );
    assert.match(
      src,
      /headers: PUBLIC_LOBBY_CACHE_HEADERS/,
      `${route} sets the cache header on its success response`,
    );
    // Caching is only safe because the payload is identical for every caller.
    assert.doesNotMatch(src, /\bauth\(\)|\brequireAgeVerifiedUser\(|\bcurrentUser\(/, `${route} stays public`);
  }
});
