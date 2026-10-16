// tests/profile-load-fanout.test.mjs
//
// Regression guards for the profile page's loading behaviour.
//
// The profile mounts twelve loaders at once (src/app/profil/PageClient.jsx).
// Three of them read the SAME endpoint — loadTitles, loadVipTitles and
// loadStreakTitles each kept a different slice of /api/titles — so one visit
// cost three identical requests and six queries for one unchanged payload. And
// the referral branch after that batch read the `stats` state variable, which
// the effect closure had resolved at mount (still null), so it was always
// truthy and fired two more requests on every single load.
//
// These tests pin the fixes:
//
//   1. the three /api/titles callers go through fetchDeduped() (one request),
//   2. /api/titles is cached and every write path clears that cache key,
//   3. the bootstrap reads the stats THIS load fetched, never stale state,
//   4. generating a referral code clears the cached stats payload, so the code
//      is not re-requested from every subsequent load.
//
// Run: node --import tsx --test tests/profile-load-fanout.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const PROFILE = "src/app/profil/PageClient.jsx";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

test("profile: the three /api/titles loaders share one de-duplicated request", () => {
  const source = read(PROFILE);

  const dedupedCalls = source.match(/fetchDeduped\("\/api\/titles"/g) ?? [];
  assert.equal(
    dedupedCalls.length,
    3,
    "loadTitles, loadVipTitles and loadStreakTitles must each use fetchDeduped()",
  );

  assert.equal(
    /(^|[^d])fetch\("\/api\/titles"/.test(source),
    false,
    "a raw fetch('/api/titles') reintroduces the duplicate request",
  );

  assert.match(
    source,
    /import \{ fetchDeduped \} from "\.\.\/\.\.\/lib\/dedupeFetch";/,
    "the dedupe helper must be imported",
  );

  // All three must use the same options, or they land on different cache keys
  // inside the helper and stop being de-duplicated.
  const options = source.match(
    /fetchDeduped\("\/api\/titles", \{\s*credentials: "include",\s*\}\)/g,
  );
  assert.equal(options?.length, 3, "all three call sites must share the same request options");
});

test("titles: /api/titles caches its payload per user", () => {
  const route = read("src/app/api/titles/route.js");

  assert.match(
    route,
    /import \{ CacheKeys, CacheTTL \} from "\.\.\/\.\.\/\.\.\/lib\/redis\/keys";/,
  );
  assert.match(
    route,
    /cacheOrFetch\(\s*CacheKeys\.titles\(userId\),\s*CacheTTL\.titles,/,
    "/api/titles must serve its payload from the Redis cache",
  );
  assert.match(
    route,
    /if \(!dbUser\) return null;/,
    "a missing users row must not be cached as a 404",
  );

  const keys = read("src/lib/redis/keys.ts");
  assert.match(
    keys,
    /titles: \(clerkId: string\) => `\$\{PREFIX\}:titles:\$\{clerkId\}`/,
    "CacheKeys.titles must stay per-user",
  );
  assert.match(keys, /titles: 60,/, "CacheTTL.titles must exist");
});

test("titles: every write path clears the cached payload", () => {
  for (const route of ["select", "equip-special", "equip-streak", "sync"]) {
    const source = read(`src/app/api/titles/${route}/route.js`);
    assert.match(
      source,
      /await cacheDelete\(CacheKeys\.titles\(userId\)\);/,
      `/api/titles/${route} must invalidate CacheKeys.titles`,
    );
  }
});

test("profile: the referral branch reads fresh stats, not the mount-time closure", () => {
  const source = read(PROFILE);

  const bootstrap = source.slice(
    source.indexOf("const bootstrap = async"),
    source.indexOf("[PROFILE_BOOTSTRAP_ERROR]"),
  );
  assert.ok(bootstrap.length > 0, "the bootstrap block must exist");

  // Scope matters: `stats?.referralCode` in the copy/share event handlers is
  // fine (those run in a later render, where stats is current). Inside the
  // effect, the binding belongs to the mount render and is always null.
  assert.equal(
    /stats\?\.referralCode/.test(bootstrap),
    false,
    "the bootstrap must not read the `stats` state variable — it is null at mount",
  );

  assert.match(
    source,
    /const statsPromise = loadStats\(\);/,
    "the bootstrap must keep a handle on the stats request it started",
  );
  assert.match(
    source,
    /if \(!\(await statsPromise\)\?\.referralCode\) \{/,
    "the referral decision must use the stats value this load fetched",
  );
  assert.match(
    source,
    /return data\.stats;/,
    "loadStats() must return the payload so the bootstrap can inspect it",
  );

  // The redundant refetch is gone: it read the same 3-minute user-stats cache
  // entry, which still had no code, and its setStats overwrote the code that
  // initializeReferral() had just merged into state.
  assert.equal(
    /await loadStats\(\)/.test(bootstrap),
    false,
    "the bootstrap must not refetch stats after generating the referral code",
  );
});

test("referral: generating a code clears the cached stats payload", () => {
  const source = read("src/app/api/referral/generate/route.js");

  assert.match(
    source,
    /import \{ cacheDelete \} from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/redis\/cache";/,
  );
  assert.match(
    source,
    /await cacheDelete\(CacheKeys\.userStats\(userId\)\);/,
    "the 3-minute user-stats payload must not keep serving referralCode: \"\"",
  );
});
