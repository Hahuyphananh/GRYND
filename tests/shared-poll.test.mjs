/**
 * Browser-wide shared poll — helper unit tests + wiring contracts.
 *
 * The React hook itself cannot run without a browser here, so (matching the
 * repo's other suites) this file pins:
 *
 *   1. the PURE lease/freshness helpers of src/lib/sharedPoll.ts with real unit
 *      tests (a fake localStorage makes the cross-tab arithmetic deterministic);
 *   2. the safety/lifecycle invariants of src/hooks/useSharedPoll.ts by reading
 *      its source;
 *   3. the call sites that were migrated onto it (home live stats + friend
 *      presence, casino friend presence + active players) and the heartbeat
 *      dedup (global presence beat + the two game-presence hooks), plus the
 *      removal of the profile's duplicate heartbeat writer.
 *
 * Run:  node --import tsx --test tests/shared-poll.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  SHARED_POLL_SLACK,
  claimFetchSlot,
  getPollStorage,
  isFresh,
  leaseIsFree,
  parseStamp,
  renewLease,
} from "../src/lib/sharedPoll.ts";

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

/** Source with comments removed, so prose can't satisfy a check. `//` lines
 *  go first: a `/*` mentioned INSIDE a line comment (a glob like
 *  `src/app/casino/*`) must not open a bogus block that swallows real code. */
function strip(src) {
  const noLineComments = src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return noLineComments.replace(/\/\*[\s\S]*?\*\//g, "");
}

const LIB = "src/lib/sharedPoll.ts";
const HOOK = "src/hooks/useSharedPoll.ts";
const HEARTBEAT_COMPONENT = "src/components/PresenceHeartbeat.tsx";
const GAME_PRESENCE_HOOK = "src/hooks/useGamePresence.js";
const ACTIVE_GAME_PRESENCE_HOOK = "src/hooks/useActiveGamePresence.js";
const PROFIL = "src/app/profil/PageClient.jsx";
const HOME = "src/app/PageClient.jsx";
const LOBBY = "src/app/casino/PageClient.jsx";

/** Minimal localStorage stand-in (exactly the surface sharedPoll needs). */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

// ── 1. Pure helpers ──────────────────────────────────────────────────────

test("parseStamp reads a usable epoch-ms stamp, and nothing else", () => {
  assert.equal(parseStamp("1000"), 1000);
  assert.equal(parseStamp("0"), 0);
  assert.equal(parseStamp("-5"), 0);
  assert.equal(parseStamp("nope"), 0);
  assert.equal(parseStamp(null), 0);
  assert.equal(parseStamp(undefined), 0);
});

test("isFresh treats recent work as another tab's, and stale work as mine", () => {
  const t0 = 1_000_000;
  const interval = 30_000; // 0.8 slack → a 24s freshness window
  assert.equal(SHARED_POLL_SLACK, 0.8);
  assert.equal(isFresh(0, t0, interval), false, "never fetched is never fresh");
  assert.equal(isFresh(t0, t0 + 1_000, interval), true);
  assert.equal(isFresh(t0, t0 + 23_000, interval), true);
  assert.equal(isFresh(t0, t0 + 24_500, interval), false, "window elapsed");
  assert.equal(isFresh(t0, t0 + 1_000, 0), false, "a bad cadence still fetches");
});

test("claimFetchSlot lets exactly one tab win the window, then the next", () => {
  const storage = makeStorage();
  const t0 = 2_000_000;
  const interval = 30_000;

  // First tab claims and records the claim.
  assert.equal(claimFetchSlot(storage, "live-stats", t0, interval), true);
  // A second tab arriving moments later sees it as fresh and skips.
  assert.equal(claimFetchSlot(storage, "live-stats", t0 + 500, interval), false);
  assert.equal(claimFetchSlot(storage, "live-stats", t0 + 20_000, interval), false);
  // Once the window elapses, a tab may claim again.
  assert.equal(claimFetchSlot(storage, "live-stats", t0 + 30_000, interval), true);

  // Storage unavailable (SSR / private mode) → always claim, never block.
  assert.equal(claimFetchSlot(null, "live-stats", t0, interval), true);

  // A broken store degrades to "claim" rather than throwing.
  const throwing = {
    getItem() {
      throw new Error("SecurityError");
    },
    setItem() {
      throw new Error("SecurityError");
    },
  };
  assert.equal(claimFetchSlot(throwing, "live-stats", t0, interval), true);
});

test("lease helpers hand one browser-wide owner the slot", () => {
  const storage = makeStorage();
  const t0 = 3_000_000;

  // Never taken → free.
  assert.equal(leaseIsFree(storage, "leader", t0), true);

  renewLease(storage, "leader", t0, 90_000);
  assert.equal(leaseIsFree(storage, "leader", t0 + 89_000), false, "held");
  assert.equal(leaseIsFree(storage, "leader", t0 + 90_001), true, "expired");

  // A renewal by the owner extends it.
  renewLease(storage, "leader", t0 + 60_000, 90_000);
  assert.equal(leaseIsFree(storage, "leader", t0 + 140_000), false);

  // No store → always free (every tab keeps its previous behaviour).
  assert.equal(leaseIsFree(null, "leader", t0), true);
  assert.doesNotThrow(() => renewLease(null, "leader", t0, 1000));
});

test("getPollStorage returns null outside a browser (SSR-safe)", () => {
  // This test file runs in Node: there is no window.
  assert.equal(typeof globalThis.window, "undefined");
  assert.equal(getPollStorage(), null);
});

// ── 2. The hook's invariants ─────────────────────────────────────────────

test("useSharedPoll is one fetch per browser, shared through a channel", () => {
  const hook = strip(read(HOOK));

  // Named export + default, so callers can pick either convention.
  assert.match(hook, /export function useSharedPoll<T>\(/);
  assert.match(hook, /export default useSharedPoll;/);

  // One registry entry per logical stream, keyed by `name`.
  assert.match(hook, /const registry = new Map<string, Entry>\(\)/);
  assert.match(hook, /registry\.get\(name\)/);

  // Cross-tab coordination: a BroadcastChannel plus a localStorage leader
  // lease. Both are optional — without them every tab polls on its own.
  assert.match(hook, /new BroadcastChannel\(/);
  assert.match(hook, /canShare\(\)/);
  assert.match(hook, /window\.localStorage/);
  assert.match(hook, /leaseIsFree\(storage, leaseKey, now\)/);
  assert.match(hook, /renewLease\(storage, leaseKey, now,/);

  // The leader fetches; a follower answers "hello" and only self-heals when it
  // has gone stale — so a coordination failure degrades to polling, never to a
  // frozen lobby.
  assert.match(hook, /if \(leaseIsFree\(storage, leaseKey, now\)\) \{/);
  assert.match(hook, /msg\.type === "hello"/);
  assert.match(hook, /now - entry\.lastDataAt > entry\.intervalMs \* 1\.6/);

  // `undefined` is the explicit "no update" signal; failures set an error
  // status instead of silently pinning stale data.
  assert.match(hook, /if \(payload === undefined\) return;/);
  assert.match(hook, /entry\.status = "error"/);

  // A freshly opened tab asks the leader for its payload first, with a short
  // fallback so a missing leader can only delay it — never freeze it.
  assert.match(hook, /if \(entry\.lastDataAt === 0\) \{/);
  assert.match(hook, /scheduleHelloFallback\(entry\)/);
  assert.match(hook, /clearHelloFallback\(entry\)/);
});

test("useSharedPoll stops hidden tabs and tears every listener down", () => {
  const hook = strip(read(HOOK));

  // Hidden tabs do no work at all.
  assert.match(hook, /document\.visibilityState === "hidden"/);
  assert.match(hook, /if \(isHidden\(\)\) return; \/\/ hidden tabs do no work/);

  // Visibility + online regain both resume work immediately.
  assert.match(hook, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
  assert.match(hook, /window\.addEventListener\("online", onVisibilityChange\)/);
  assert.match(
    hook,
    /document\.removeEventListener\("visibilitychange", onVisibilityChange\)/,
  );
  assert.match(hook, /window\.removeEventListener\("online", onVisibilityChange\)/);

  // Timers are cleared and the registry entry dropped when the last subscriber
  // unmounts (the channel is closed too).
  assert.match(hook, /clearInterval\(entry\.timer\)/);
  assert.match(hook, /entry!\.channel\?\.close\(\)/);
  assert.match(hook, /registry\.delete\(name\)/);

  // Disabled / unnamed / zero-cadence subscribers never start a timer.
  assert.match(hook, /if \(!enabled \|\| !name \|\| !intervalMs\) return undefined;/);
});

// ── 3. Migrated call sites ───────────────────────────────────────────────

test("the home page shares live-stats and friend-presence across tabs", () => {
  const home = strip(read(HOME));

  assert.match(home, /useSharedPoll\("live-stats", fetchLiveStats, \{/);
  assert.match(home, /useSharedPoll\("friend-presence", fetchFriendPresence, \{/);
  // Friend presence only runs for a signed-in user.
  assert.match(home, /enabled: Boolean\(user\)/);

  // The old per-tab intervals are gone.
  assert.doesNotMatch(home, /setInterval\(fetchLiveStats/);
  assert.doesNotMatch(home, /setInterval\(fetchFriendPresence/);
  // The fetchers return the payload the poller broadcasts.
  assert.match(home, /if \(response\.ok && data\.success\) return data\.byGame \|\| \{\};/);
});

test("the casino lobby shares friend-presence and the active-player aggregate", () => {
  const lobby = strip(read(LOBBY));

  assert.match(lobby, /useSharedPoll\("friend-presence", fetchFriendPresence, \{/);
  assert.match(lobby, /useSharedPoll\("active-players", fetchActivePlayers, \{/);
  assert.match(lobby, /intervalMs: ACTIVE_PLAYERS_POLL_MS/);

  // No per-tab interval survives for either feed.
  assert.doesNotMatch(lobby, /setInterval\(fetchFriendPresence/);
  assert.doesNotMatch(lobby, /setInterval\(load,/);
  // Fail-closed active-player state is a broadcastable value, not a throw.
  assert.match(
    lobby,
    /if \(!res\.ok \|\| data\?\.success !== true\) return \{ status: "error", counts: \{\} \};/,
  );
});

// ── 4. Presence-heartbeat dedup ──────────────────────────────────────────

test("the global heartbeat is one POST per browser, gated as before", () => {
  const beat = strip(read(HEARTBEAT_COMPONENT));

  // Deduped through the same claim helper, keyed once per browser.
  assert.match(beat, /import \{ claimFetchSlot \} from "\.\.\/lib\/sharedPoll";/);
  assert.match(beat, /const HEARTBEAT_CLAIM_KEY = "grynd:presence:heartbeat";/);
  assert.match(beat, /claimFetchSlot\(\s*getStorage\(\),/);

  // The cadence and the gating are preserved: 5 min visible, 10 min hidden or
  // offline, and a beat the moment we come back online/visible.
  assert.match(beat, /return 600000;/);
  assert.match(beat, /return 300000;/);
  assert.match(beat, /if \(typeof document !== "undefined" && !document\.hidden\) ping\(\);/);
  assert.match(beat, /window\.addEventListener\("online", handleOnline\)/);
  assert.match(beat, /window\.addEventListener\("offline", handleOffline\)/);

  // One writer, one endpoint, cleaned up on unmount.
  assert.match(beat, /fetch\("\/api\/presence\/heartbeat"/);
  assert.match(beat, /document\.removeEventListener\("visibilitychange", handleVisibility\)/);
});

test("the profile page no longer runs a second heartbeat writer", () => {
  const profil = strip(read(PROFIL));
  // The global <PresenceHeartbeat /> (mounted in providers.tsx) owns presence
  // freshness; a page-local writer would only duplicate the same row's writes.
  assert.doesNotMatch(profil, /\/api\/presence\/heartbeat/);
  assert.doesNotMatch(profil, /setInterval\(sendHeartbeat/);
});

test("the game-presence hooks elect one tab instead of every tab writing", () => {
  const game = strip(read(GAME_PRESENCE_HOOK));
  assert.match(game, /import \{ getPollStorage, leaseIsFree, renewLease \} from "\.\.\/lib\/sharedPoll";/);
  assert.match(game, /leaseIsFree\(storage, leaseKey, now\)/);
  assert.match(game, /renewLease\(storage, leaseKey, now,/);
  // The keep-alive cadence and the fetch are unchanged.
  assert.match(game, /setInterval\(setInGame, 120000\)/);
  assert.match(game, /fetch\("\/api\/presence\/game"/);

  const active = strip(read(ACTIVE_GAME_PRESENCE_HOOK));
  assert.match(
    active,
    /import \{ getPollStorage, leaseIsFree, renewLease \} from "\.\.\/lib\/sharedPoll";/,
  );
  assert.match(active, /if \(!leaseIsFree\(storage, leaseKey, now\)\) return;/);
  assert.match(active, /renewLease\(storage, leaseKey, now, PRESENCE_HEARTBEAT_MS \* 1\.5\)/);
  // Only a tab that actually beat owns the row and may clear it on unmount.
  assert.match(active, /if \(!didBeatRef\.current\) return;/);
  assert.match(active, /sendPresenceLeave\(latestRef\.current\.gameLabel, sessionIdRef\.current\)/);
});
