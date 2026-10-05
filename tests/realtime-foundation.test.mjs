/**
 * Shared realtime foundation — contract + unit tests.
 *
 * The Supabase client cannot be exercised against a live backend in a unit
 * test, so (matching the repo's other realtime suites) this file pins:
 *
 *   1. the PURE helpers of src/lib/realtime.ts (filter building, channel keys,
 *      env resolution) with real unit tests;
 *   2. the safety/lifecycle invariants of src/lib/realtime.ts + the new
 *      src/hooks/useRealtimeSubscription.ts by reading the source;
 *   3. the migration allowlist + journal registration for 0204.
 *
 * Run:  node --import tsx --test tests/realtime-foundation.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildRealtimeFilter,
  realtimeChannelKey,
  realtimeConfigFromEnv,
  subscribeToTableChanges,
} from "../src/lib/realtime.ts";

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

/** Source with block/line comments removed, so prose can never satisfy a code check. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const REALTIME = read("src/lib/realtime.ts");
const REALTIME_CODE = stripComments(REALTIME);
const HOOK = read("src/hooks/useRealtimeSubscription.ts");
const MIGRATION = read("src/db/migrations/0204_realtime_publication_game_tables.sql");
const JOURNAL = JSON.parse(read("src/db/migrations/meta/_journal.json"));
const JOURNAL_RAW = read("src/db/migrations/meta/_journal.json");

// ── 1. Pure helpers ─────────────────────────────────────────────────────────

test("buildRealtimeFilter builds a safe PostgREST equality filter", () => {
  assert.equal(buildRealtimeFilter("id", "abc-123"), "id=eq.abc-123");
  assert.equal(buildRealtimeFilter("match_id", 42), "match_id=eq.42");
  assert.equal(buildRealtimeFilter("id", "00000000-0000-0000-0000-000000000000"), "id=eq.00000000-0000-0000-0000-000000000000");
});

test("buildRealtimeFilter refuses anything that could break out of the filter", () => {
  // Injection / truncation attempts must return null, never a widened filter.
  assert.equal(buildRealtimeFilter("id", "1,is_deleted=eq.false"), null);
  assert.equal(buildRealtimeFilter("id", "a)or(1"), null);
  assert.equal(buildRealtimeFilter("id", "a b"), null);
  assert.equal(buildRealtimeFilter("id", ""), null);
  assert.equal(buildRealtimeFilter("id", null), null);
  assert.equal(buildRealtimeFilter("id", undefined), null);
  assert.equal(buildRealtimeFilter("id; drop", "x"), null);
  assert.equal(buildRealtimeFilter("not a column", "x"), null);
});

test("realtimeChannelKey is stable for the same slice and distinct across slices", () => {
  const a = realtimeChannelKey({ table: "tic_tac_toe_matches", event: "UPDATE", filter: "id=eq.1" });
  const b = realtimeChannelKey({ table: "tic_tac_toe_matches", event: "UPDATE", filter: "id=eq.1" });
  const c = realtimeChannelKey({ table: "tic_tac_toe_matches", event: "UPDATE", filter: "id=eq.2" });
  assert.equal(a, b, "identical slices must share ONE channel key");
  assert.notEqual(a, c, "different rows must not collide");
  assert.match(a, /^public:tic_tac_toe_matches:UPDATE:id=eq\.1$/);
  // Defaults: schema public, event "*", filter "*".
  assert.equal(realtimeChannelKey({ table: "x" }), "public:x:*:*");
});

test("realtimeConfigFromEnv accepts every publishable-key alias and rejects partial config", () => {
  const url = "https://example.supabase.co/";
  assert.deepEqual(realtimeConfigFromEnv({ NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pk" }), {
    url: "https://example.supabase.co",
    key: "pk",
  });
  assert.deepEqual(realtimeConfigFromEnv({ NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" }), {
    url: "https://example.supabase.co",
    key: "anon",
  });
  assert.equal(realtimeConfigFromEnv({ NEXT_PUBLIC_SUPABASE_URL: url }), null);
  assert.equal(realtimeConfigFromEnv({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pk" }), null);
  assert.equal(realtimeConfigFromEnv({}), null);
});

test("subscribeToTableChanges never throws when Realtime is unavailable (no window/env)", () => {
  // In Node there is no `window`, so the shared client is not built: the call
  // must degrade to a no-op unsubscribe instead of throwing.
  const unsubscribe = subscribeToTableChanges({
    table: "tic_tac_toe_matches",
    event: "UPDATE",
    filter: "id=eq.1",
    handler: () => {},
  });
  assert.equal(typeof unsubscribe, "function");
  assert.doesNotThrow(() => unsubscribe());
});

// ── 2. realtime.ts invariants ───────────────────────────────────────────────

test("the Supabase client is a single browser-session singleton, never server-side", () => {
  assert.match(REALTIME, /let cachedClient: SupabaseClient \| null = null/);
  assert.match(REALTIME, /__gryndRealtimeClient/, "globalThis cache prevents duplicate clients across HMR");
  assert.match(REALTIME, /typeof window === "undefined"/, "no client during SSR");
  assert.match(REALTIME, /export function getRealtimeClient\(\): SupabaseClient \| null/);
  // A subscription must never build its own client.
  assert.match(REALTIME, /const supabase = getRealtimeClient\(\);/);
  // Next.js only inlines DIRECT `process.env.NEXT_PUBLIC_*` member access, so
  // the config must be assembled from those literals (not read via a variable),
  // or Realtime silently disables itself in the browser bundle.
  assert.match(REALTIME, /process\.env\.NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(REALTIME, /process\.env\.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  assert.match(REALTIME, /process\.env\.NEXT_PUBLIC_SUPABASE_ANON_KEY/);
});

test("realtime.ts exposes no privileged credentials", () => {
  // Comments are stripped first: the module's security warning necessarily
  // names the words "password hash" / "service-role key", which must not read
  // as if a credential were present.
  assert.doesNotMatch(REALTIME_CODE, /SERVICE_ROLE|service_role/i, "the service-role key must never reach the browser");
  assert.doesNotMatch(REALTIME_CODE, /DATABASE_URL/, "the DB connection string is server-only");
  assert.doesNotMatch(REALTIME_CODE, /password|secret|private_key/i, "no backend secrets in the client realtime layer");
});

test("realtime.ts keeps the original exports and adds the reusable helpers", () => {
  for (const name of [
    "subscribeToPostgresChanges",
    "subscribeToChatMessages",
    "subscribeToTableChanges",
    "subscribeToInserts",
    "subscribeToUpdates",
    "subscribeToDeletes",
    "subscribeToFilteredChanges",
    "subscribeToMatchChanges",
    "subscribeToGameChanges",
    "isRealtimeEnabled",
  ]) {
    assert.match(REALTIME, new RegExp(`export (function|const|interface|type) ${name}\\b`), `missing export ${name}`);
  }
});

test("subscriptions are deduplicated, cleanly torn down, and status-aware", () => {
  assert.match(REALTIME, /const registry = new Map<string, ChannelEntry>\(\)/);
  assert.match(REALTIME, /registry\.get\(key\)/, "reuse an existing channel for the same slice");
  assert.match(REALTIME, /registry\.set\(key, created\)/);
  assert.match(REALTIME, /handlers\.size === 0/, "channel is removed only when the last handler leaves");
  assert.match(REALTIME, /removeChannel\(live\.channel\)/);
  assert.match(REALTIME, /channel\.subscribe\(/, "status callback drives reconnect handling");
  assert.match(REALTIME, /catch \(error\)[\s\S]{0,120}return noop;/, "failures degrade to a no-op");
});

// ── 3. Hook lifecycle invariants ────────────────────────────────────────────

test("the hook file is client-only and provides the generic + match/game patterns", () => {
  assert.match(HOOK, /^"use client";/m);
  for (const name of ["useRealtimeSubscription", "useMatchRealtime", "useGameRealtime"]) {
    assert.match(HOOK, new RegExp(`export function ${name}\\b`), `missing ${name}`);
  }
  assert.match(HOOK, /subscribeToMatchChanges/);
  assert.match(HOOK, /subscribeToGameChanges/);
});

test("the hooks subscribe on mount, unsubscribe on unmount, and never restart on re-render", () => {
  assert.match(HOOK, /useLatest/);
  assert.match(HOOK, /disposed = true;\s*\n\s*unsubscribe\(\);/, "cleanup marks disposed and unsubscribes");
  assert.match(HOOK, /if \(!enabled \|\| !table\)/, "no subscription while disabled");
  // The subscription effect deps are primitives + hasId, never the callbacks.
  assert.match(HOOK, /\}, \[table, event, filter, enabled\]\);/);
  assert.match(HOOK, /\}, \[table, idColumn, event, enabled, hasId, matchId\]\);/);
  assert.match(HOOK, /\}, \[table, idColumn, event, enabled, hasId, gameId\]\);/);
});

// ── 4. Migration: allowlist + journal ───────────────────────────────────────

test("0204 is registered in the drizzle journal with an ordered timestamp", () => {
  const entry = JOURNAL.entries.find((e) => e.tag === "0204_realtime_publication_game_tables");
  assert.ok(entry, "0204 must be in _journal.json or db:migrate skips it");
  // Not required to be the tail: later migrations (e.g. 0205) append after it.
  assert.equal(
    entry.idx,
    JOURNAL.entries.findIndex((e) => e.tag === entry.tag),
    "idx must match the entry's position",
  );
  assert.equal(entry.version, JOURNAL.version);
  const prev = JOURNAL.entries[entry.idx - 1];
  assert.ok(prev, "0204 must not be the first journal entry");
  assert.ok(entry.when > prev.when, "journal timestamps must stay ordered");
  const next = JOURNAL.entries[entry.idx + 1];
  if (next) assert.ok(next.when > entry.when, "journal timestamps must stay ordered");
});

test("0204 publishes ONLY the vetted money-free match tables", () => {
  const arrays = [...MIGRATION.matchAll(/target_tables text\[\] := ARRAY\[([^\]]+)\]/g)].map((m) =>
    m[1]
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .filter(Boolean),
  );
  assert.ok(arrays.length >= 2, "publication + policy blocks must both declare the allowlist");
  for (const list of arrays) {
    assert.deepEqual([...list].sort(), ["mini_golf_matches", "tic_tac_toe_matches"].sort());
  }
});

test("0204 never publishes a staked, PII, or auth table", () => {
  const forbidden = [
    "users",
    "chess_games",
    "hex_duel_games",
    "odds_games",
    "four_in_a_row_games",
    "dots_and_boxes_games",
    "rps_pvp_games",
    "mines_pvp_matches",
    "keno_pvp_matches",
    "lane_runner_games",
    "memory_grid_matches",
    "tower_arena_matches",
    "precision_matches",
    "pool_matches",
    "dice_flush_rooms",
    "solitaire_duel_matches",
    "user_presence",
    "user_game_presence",
  ];
  for (const table of forbidden) {
    assert.doesNotMatch(
      MIGRATION,
      new RegExp(`ADD TABLE[^;]*${table}`),
      `${table} must not be added to the publication`,
    );
  }
});

test("0204 is idempotent and guarded", () => {
  assert.match(MIGRATION, /pg_publication WHERE pubname = 'supabase_realtime'/, "no-op when the publication is absent");
  assert.match(MIGRATION, /pg_publication_tables/, "skip a table already in the publication");
  assert.match(MIGRATION, /ADD TABLE public\.%I/);
  assert.match(MIGRATION, /DROP POLICY IF EXISTS realtime_public_read/, "policy creation is re-runnable");
  assert.match(MIGRATION, /CREATE POLICY realtime_public_read ON public\.%I FOR SELECT USING \(true\)/);
});

test("the new migration is number 0204 and the journal carries it as raw text", () => {
  assert.ok(fs.existsSync(path.join(process.cwd(), "src/db/migrations/0204_realtime_publication_game_tables.sql")));
  assert.match(JOURNAL_RAW, /"tag": "0204_realtime_publication_game_tables"/);
});
