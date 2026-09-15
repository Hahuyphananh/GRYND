// tests/game-presence.test.mjs
//
// Per-game ACTIVE PLAYER presence (the casino lobby's "N playing" badge).
//
// Covers the whole backend foundation:
//   1. The game identity contract (canonical ids, label map, drift guard)
//   2. The activity window / heartbeat cadence (expiration semantics)
//   3. The migration + Drizzle schema parity
//   4. The store (idempotent upsert, session-scoped clear, aggregate)
//   5. The heartbeat endpoint (auth, validation, rate limit, no leakage)
//   6. The leave endpoint (optional, session-scoped)
//   7. The aggregate endpoint (counts only, cached, fail-closed)
//   8. Storage hygiene (retention prune)
//   9. Compatibility (existing presence systems untouched, no game page edits)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  ACTIVE_PLAYER_WINDOW_SECONDS,
  GAME_LABEL_TO_GAME_ID,
  PRESENCE_GAME_IDS,
  PRESENCE_GAME_LABELS,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_SESSION_MAX_LENGTH,
  isCanonicalGameId,
  isPresenceActive,
  isPresenceGame,
  normalizeSessionId,
  presenceCutoff,
  resolveGameId,
  toActivePlayerCounts,
} from "../src/lib/gamePresence.js";
import { GAME_CATALOG } from "../src/lib/gameTags.js";

const STORE = "src/lib/gamePresenceStore.ts";
const HEARTBEAT = "src/app/api/presence/active-game/route.ts";
const LEAVE = "src/app/api/presence/active-game/leave/route.ts";
const AGGREGATE = "src/app/api/casino/active-players/route.ts";
const RETENTION = "src/app/api/jobs/retention/route.ts";
const MIGRATION = "src/db/migrations/0159_game_presence.sql";
const SCHEMA = "src/db/schema.ts";
const KEYS = "src/lib/redis/keys.ts";
const LOBBY = "src/app/casino/PageClient.jsx";
const SESSION_HOST = "src/components/creator-mode/CreatorModeHost.jsx";

const source = (relPath) =>
  fs.readFileSync(path.join(process.cwd(), relPath), "utf8").replace(/\r\n/g, "\n");

/** Source with `//` comment lines removed — for assertions about what the CODE
 *  references (a comment may legitimately name the things we forbid, e.g. the
 *  "never returns user ids, emails, usernames" rule). */
const code = (relPath) =>
  source(relPath)
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

/** Every file under the given dirs (game pages + hooks live in both). */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx|jsx|ts|js)$/.test(entry.name)) out.push(full.split(path.sep).join("/"));
  }
  return out;
}

// ── 1. Game identity contract ────────────────────────────────────────────

test("canonical ids are the existing catalog ids — no new identifier space", () => {
  // Presence keys ARE the lobby's leaderboardKey (what gameTags.js exports),
  // so the lobby can render a count with counts[game.leaderboardKey].
  assert.deepEqual(
    PRESENCE_GAME_IDS,
    GAME_CATALOG.map((game) => game.id)
  );
  assert.equal(new Set(PRESENCE_GAME_IDS).size, PRESENCE_GAME_IDS.length);
  assert.equal(isCanonicalGameId("mines-pvp"), true);
  assert.equal(isCanonicalGameId("mines-duel"), false, "a label is not a canonical id");
  assert.equal(isCanonicalGameId("not-a-game"), false);

  // And they all exist in the lobby, so a count can always be rendered.
  const lobby = source(LOBBY);
  const lobbyKeys = [...lobby.matchAll(/leaderboardKey: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(lobbyKeys.length >= 20);
  for (const id of PRESENCE_GAME_IDS) {
    assert.ok(lobbyKeys.includes(id), `${id} is not a lobby leaderboardKey`);
  }
});

test("every label the repo actually reports maps to a game (drift guard)", () => {
  const files = [...walk("src/app"), ...walk("src/hooks"), ...walk("src/components")];
  const labels = new Set();
  // Only real label shapes (lowercase slug). Prose in comments mentions
  // `gameLabel="…"` as a placeholder, which is not a label.
  const isLabelShaped = (value) => /^[a-z0-9-]+$/.test(value);
  for (const file of files) {
    const src = source(file);
    for (const m of src.matchAll(/gameLabel="([^"]+)"/g)) {
      if (isLabelShaped(m[1])) labels.add(m[1]);
    }
    for (const m of src.matchAll(/useRecordPlayedGame\(\s*"([^"]+)"/g)) {
      if (isLabelShaped(m[1])) labels.add(m[1]);
    }
  }

  // Sanity: the inventory is the real thing (23 game pages + 4 hook callers).
  assert.ok(labels.size >= 24, `expected >= 24 labels, found ${labels.size}`);

  for (const label of labels) {
    if (label === "precision-test") continue; // deliberately excluded below
    const id = resolveGameId(label);
    assert.ok(id, `gameLabel "${label}" does not resolve to a canonical game id`);
    assert.ok(PRESENCE_GAME_IDS.includes(id));
  }

  // The one intentional exclusion: a developer harness route, not a shipped
  // game surface. Counting it would fake traffic.
  assert.equal(GAME_LABEL_TO_GAME_ID["precision-test"], undefined);
  assert.equal(isPresenceGame("precision-test"), false);

  // Alternate play surfaces collapse onto their lobby card.
  assert.equal(resolveGameId("chess-ai"), "chess");
  assert.equal(resolveGameId("four-in-a-row-ai"), "four-in-a-row");
  assert.equal(resolveGameId("rock-paper-scissors-ai"), "rps");
  assert.equal(resolveGameId("neon-flush"), "uno");
  assert.equal(resolveGameId("uno-multiplayer"), "uno");
  assert.equal(resolveGameId("dice-flush"), "yahtzee");

  // No label maps to a game that isn't in the catalog.
  for (const [label, id] of Object.entries(GAME_LABEL_TO_GAME_ID)) {
    assert.ok(PRESENCE_GAME_IDS.includes(id), `${label} → ${id} is not a canonical id`);
  }
  assert.equal(Object.keys(GAME_LABEL_TO_GAME_ID).length, PRESENCE_GAME_LABELS.length);
});

test("resolveGameId accepts labels and ids, normalizes, rejects the rest", () => {
  assert.equal(resolveGameId("mines-duel"), "mines-pvp");
  assert.equal(resolveGameId("mines-pvp"), "mines-pvp");
  assert.equal(resolveGameId("  ROCK-PAPER-SCISSORS  "), "rps");
  assert.equal(resolveGameId("Crash-Arena"), "crash");
  assert.equal(resolveGameId("nope"), null);
  assert.equal(resolveGameId(""), null);
  assert.equal(resolveGameId("   "), null);
  assert.equal(resolveGameId(null), null);
  assert.equal(resolveGameId(undefined), null);
  assert.equal(resolveGameId(42), null);
  assert.equal(resolveGameId({}), null);
  // Prototype keys must not resolve through the lookup object.
  assert.equal(resolveGameId("constructor"), null);
  assert.equal(resolveGameId("__proto__"), null);
});

// ── 2. Expiration semantics ──────────────────────────────────────────────

test("the activity window is derived, explained, and longer than the beat", () => {
  // Window must exceed the heartbeat so a single dropped beat doesn't blink a
  // player out of the count, and must stay short enough that a closed tab
  // disappears "eventually" (a few minutes).
  assert.ok(PRESENCE_HEARTBEAT_MS < ACTIVE_PLAYER_WINDOW_SECONDS * 1000);
  // Three beats per window → two dropped heartbeats still leave the player
  // counted. This is the invariant that keeps the badge from flapping.
  assert.ok(
    ACTIVE_PLAYER_WINDOW_SECONDS * 1000 >= PRESENCE_HEARTBEAT_MS * 3,
    "the window must tolerate at least two missed beats"
  );
  assert.ok(ACTIVE_PLAYER_WINDOW_SECONDS <= 300, "a lobby badge means playing now");
  assert.equal(PRESENCE_HEARTBEAT_MS, 60000);

  const now = Date.parse("2026-01-01T12:00:00.000Z");
  assert.equal(presenceCutoff(now).toISOString(), "2026-01-01T11:57:00.000Z");
});

test("a row stops counting exactly when it leaves the window (no leave needed)", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  const windowMs = ACTIVE_PLAYER_WINDOW_SECONDS * 1000;

  assert.equal(isPresenceActive(new Date(now - 1000), now), true, "just beat");
  assert.equal(isPresenceActive(new Date(now - windowMs + 1000), now), true, "inside");
  assert.equal(isPresenceActive(new Date(now - windowMs), now), false, "boundary is stale");
  assert.equal(isPresenceActive(new Date(now - windowMs - 1000), now), false, "outside");
  assert.equal(isPresenceActive(new Date(now - 60 * 60 * 1000), now), false, "an hour old");
  // Tolerates an ISO string (what a JSON payload would carry).
  assert.equal(isPresenceActive(new Date(now - 1000).toISOString(), now), true);
  // Missing/garbage timestamps are never treated as active.
  assert.equal(isPresenceActive(null, now), false);
  assert.equal(isPresenceActive(undefined, now), false);
  assert.equal(isPresenceActive("not a date", now), false);
});

test("counts are grouped by game, drop zeroes, and only surface real games", () => {
  const counts = toActivePlayerCounts([
    { gameId: "roulette", players: 12 },
    { gameId: "crash", players: 8 },
    { gameId: "rps", players: 5 },
    { gameId: "poker", players: 0 }, // nobody playing → absent, not 0
    { gameId: "not-a-game", players: 99 }, // legacy/manual row → never surfaced
    { gameId: null, players: 4 },
    { gameId: "chess", players: "3" }, // driver may hand back a numeric string
    { gameId: "keno", players: 2 },
    { gameId: "keno", players: 1 }, // defensive: duplicate rows sum
    { gameId: "odds", players: NaN },
    { gameId: "odds" },
    null,
  ]);

  assert.deepEqual(counts, { roulette: 12, crash: 8, rps: 5, chess: 3, keno: 3 });
  assert.equal("poker" in counts, false);
  assert.equal("not-a-game" in counts, false);
  // Every key is a game the lobby can actually render.
  for (const id of Object.keys(counts)) assert.ok(PRESENCE_GAME_IDS.includes(id));
  // Total garbage in, empty (never a throw) out.
  assert.deepEqual(toActivePlayerCounts(null), {});
  assert.deepEqual(toActivePlayerCounts(undefined), {});
  assert.deepEqual(toActivePlayerCounts([]), {});
});

test("session ids are optional, bounded, and never required", () => {
  assert.equal(normalizeSessionId("  tab-1  "), "tab-1");
  assert.equal(normalizeSessionId(""), null);
  assert.equal(normalizeSessionId("   "), null);
  assert.equal(normalizeSessionId(null), null);
  assert.equal(normalizeSessionId(7), null);
  assert.equal(normalizeSessionId("x".repeat(500)).length, PRESENCE_SESSION_MAX_LENGTH);
  assert.equal(PRESENCE_SESSION_MAX_LENGTH, 128);
});

// ── 3. Migration + schema ────────────────────────────────────────────────

test("the migration extends the existing table idempotently", () => {
  const sql = source(MIGRATION);
  // Statement text only — the header comment is prose and names things the
  // statements must not do ("a second presence table", "drop-off", …).
  const statements = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  // Reuses the dormant table instead of adding a parallel one.
  assert.match(sql, /CREATE TABLE IF NOT EXISTS user_game_presence/);
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS (?!user_game_presence)\w*presence/);
  assert.match(sql, /user_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /game_key VARCHAR\(80\) NOT NULL/);
  assert.match(sql, /last_seen_at TIMESTAMP NOT NULL DEFAULT NOW\(\)/);

  // The requested shape, on top of what 0012 already created.
  for (const column of ["game_id", "session_id", "created_at", "updated_at"]) {
    assert.match(
      sql,
      new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`),
      `${column} should be added idempotently`
    );
  }
  assert.match(sql, /ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW\(\)/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW\(\)/);

  // One active row per (user, game) — the upsert target and the anti-double-count.
  assert.match(sql, /CONSTRAINT user_game_presence_user_game_unique UNIQUE \(user_id, game_key\)/);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX IF NOT EXISTS user_game_presence_user_game_unique\n  ON user_game_presence \(user_id, game_key\)/
  );

  // The aggregate's access path.
  assert.match(
    sql,
    /CREATE INDEX IF NOT EXISTS user_game_presence_game_idx\n  ON user_game_presence \(game_key, last_seen_at DESC\)/
  );

  // Nothing destructive, and no backfill pretending old rows were playing.
  assert.doesNotMatch(statements, /\bDROP\b/i);
  assert.doesNotMatch(statements, /\bTRUNCATE\b/i);
  assert.doesNotMatch(statements, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(statements, /UPDATE user_game_presence/i);
});

test("the migration is journaled, and the Drizzle schema mirrors it", () => {
  const journal = JSON.parse(source("src/db/migrations/meta/_journal.json").replace(/^\uFEFF/, ""));
  const entry = journal.entries.find((e) => e.tag === "0159_game_presence");
  assert.ok(entry, "0159_game_presence must be journaled or db:migrate skips it");
  assert.equal(entry.idx, 141);
  assert.ok(entry.when > 1800000003000, "timestamps must move forward");

  const schema = source(SCHEMA);
  assert.match(schema, /gameKey: varchar\("game_key", \{ length: 80 \}\)\.notNull\(\)/);
  assert.match(schema, /gameId: integer\("game_id"\)/);
  assert.match(schema, /sessionId: varchar\("session_id", \{ length: 128 \}\)/);
  assert.match(schema, /lastSeenAt: timestamp\("last_seen_at"\)\.notNull\(\)\.defaultNow\(\)/);
  assert.match(schema, /createdAt: timestamp\("created_at"\)\.notNull\(\)\.defaultNow\(\)/);
  assert.match(schema, /updatedAt: timestamp\("updated_at"\)\.notNull\(\)\.defaultNow\(\)/);
  assert.match(
    schema,
    /unique\("user_game_presence_user_game_unique"\)\.on\(\s*\n?\s*table\.userId,\s*\n?\s*table\.gameKey\s*\n?\s*\)/
  );
  assert.match(
    schema,
    /index\("user_game_presence_game_idx"\)\.on\(table\.gameKey, table\.lastSeenAt\)/
  );
  assert.match(schema, /references\(\(\) => users\.id, \{ onDelete: "cascade" \}\)/);
});

// ── 4. Store ─────────────────────────────────────────────────────────────

test("the heartbeat upsert is idempotent and owned by the session's user", () => {
  const store = source(STORE);
  const storeCode = code(STORE);

  assert.match(store, /export async function markPlaying\(/);
  assert.match(store, /\.insert\(userGamePresence\)/);
  // Conflict on the unique pair → repeated beats update one row, never add one.
  assert.match(store, /onConflictDoUpdate\(\{/);
  assert.match(
    store,
    /target: \[userGamePresence\.userId, userGamePresence\.gameKey\]/,
    "the upsert must conflict on (user_id, game_key)"
  );
  assert.match(store, /lastSeenAt: now/);
  assert.match(store, /updatedAt: now/);
  // created_at is written on INSERT only — "first seen in this game" stays true.
  assert.doesNotMatch(store, /set: \{[^}]*createdAt/s);
  // The caller's internal id is a parameter; nothing reaches for an HTTP
  // request, body or query string (word-bounded, so "nobody" can't trip it).
  assert.doesNotMatch(storeCode, /\bbody\b|\brequest\b|searchParams/);
  assert.match(storeCode, /\n\s*userId: number;/);
  assert.doesNotMatch(storeCode, /clerkId/);
});

test("leave is optional, scoped, and can't wipe another tab's presence", () => {
  const store = source(STORE);

  assert.match(store, /export async function clearPlaying\(/);
  assert.match(store, /eq\(userGamePresence\.userId, userId\)/);
  // Only the tab that wrote the row may clear it.
  assert.match(
    store,
    /if \(sessionId\) filters\.push\(eq\(userGamePresence\.sessionId, sessionId\)\);/
  );
  // Optional game scope: no game id means "all of my rows".
  assert.match(store, /if \(gameId\) filters\.push\(eq\(userGamePresence\.gameKey, gameId\)\);/);
  // Never filtered by another user's identity.
  assert.doesNotMatch(store, /clerkId/);
});

test("the aggregate groups by game, is windowed, and returns counts only", () => {
  const store = source(STORE);
  const aggregate = store.slice(store.indexOf("export function activePlayersQuery("));

  assert.match(aggregate, /\.from\(userGamePresence\)/);
  assert.match(aggregate, /sql<number>`COUNT\(\*\)::int`/);
  assert.match(aggregate, /\.groupBy\(userGamePresence\.gameKey\)/);
  // The window is a parameterized cutoff (index-friendly) — never NOW() math
  // buried in SQL, so the expiration rule stays a tested pure function.
  assert.match(aggregate, /\.where\(gt\(userGamePresence\.lastSeenAt, presenceCutoff\(now\)\)\)/);
  // Only the game id and a number leave the store — the shaping rule itself
  // lives in the pure, unit-tested toActivePlayerCounts().
  assert.doesNotMatch(aggregate, /userId|sessionId|clerkId|name|email/i);
  assert.match(aggregate, /return toActivePlayerCounts\(rows\);/);
});

test("the generated SQL is an idempotent upsert, a scoped clear, and a windowed GROUP BY", async () => {
  // The query builders are inspectable without a database (the pg pool is
  // lazy), so the ACTUAL SQL is asserted — not just the source that builds it.
  const { markPlayingQuery, clearPlayingQuery, activePlayersQuery } =
    await import("../src/lib/gamePresenceStore.ts");

  const now = Date.parse("2026-01-01T12:00:00.000Z");

  // ── heartbeat: one row per (user, game), ever ──
  const upsert = markPlayingQuery({ userId: 7, gameId: "chess", sessionId: "tab-1" }).toSQL();
  assert.match(upsert.sql, /insert into "user_game_presence"/);
  assert.match(upsert.sql, /on conflict \("user_id","game_key"\) do update set/);
  const updateSet = upsert.sql.slice(upsert.sql.indexOf("do update set"));
  assert.match(updateSet, /"last_seen_at" = \$\d+/);
  assert.match(updateSet, /"updated_at" = \$\d+/);
  assert.match(updateSet, /"session_id" = \$\d+/);
  // created_at is INSERT-only: "first seen in this game" stays truthful no
  // matter how many times the client beats.
  assert.doesNotMatch(updateSet, /created_at/);
  assert.match(upsert.sql, /"created_at"/);
  assert.equal(upsert.params[0], 7);
  assert.equal(upsert.params[1], "chess");
  assert.equal(upsert.params[2], "tab-1");

  // ── leave: scoped to the caller, and to their own tab ──
  const scoped = clearPlayingQuery({ userId: 7, gameId: "chess", sessionId: "tab-1" }).toSQL();
  assert.match(scoped.sql, /delete from "user_game_presence"/);
  assert.match(scoped.sql, /"user_game_presence"\."user_id" = \$1/);
  assert.match(scoped.sql, /"user_game_presence"\."game_key" = \$2/);
  assert.match(scoped.sql, /"user_game_presence"\."session_id" = \$3/);
  assert.deepEqual(scoped.params, [7, "chess", "tab-1"]);

  // No session id → still only the caller's rows; no game → all of them.
  const everything = clearPlayingQuery({ userId: 7 }).toSQL();
  assert.match(everything.sql, /where \(?"user_game_presence"\."user_id" = \$1\)?/);
  assert.deepEqual(everything.params, [7]);
  assert.doesNotMatch(everything.sql, /session_id/);

  // ── aggregate: windowed, grouped, counts only ──
  const aggregate = activePlayersQuery(now).toSQL();
  assert.match(aggregate.sql, /select "game_key", COUNT\(\*\)::int from "user_game_presence"/);
  assert.match(aggregate.sql, /where "user_game_presence"\."last_seen_at" > \$1/);
  assert.match(aggregate.sql, /group by "user_game_presence"\."game_key"/);
  // The window is a bound parameter, not NOW() math — exactly the cutoff the
  // pure expiration tests cover.
  assert.deepEqual(aggregate.params, [presenceCutoff(now).toISOString()]);
  // Nothing that could identify a player is selected.
  assert.doesNotMatch(aggregate.sql, /user_id|"id"|session_id|clerk/i);
});

// ── 5. Heartbeat endpoint ────────────────────────────────────────────────

test("the heartbeat requires a session, an allowlisted game and a known user", () => {
  const route = source(HEARTBEAT);

  assert.match(route, /export async function POST\(request: Request\)/);
  assert.match(route, /const \{ userId \} = await auth\(\);/);
  assert.match(route, /if \(!userId\) return unauthorized\(\);/);
  assert.match(route, /status: 401/);

  // Unknown games are rejected before anything is written.
  assert.match(route, /const gameId = resolveGameId\(parsed\.data\.gameLabel\);/);
  assert.match(route, /error: "Unknown game"/);
  assert.match(route, /status: 400/);

  // Body is allowlisted by the shared validator (unknown fields → 400).
  assert.match(route, /parseAndValidateJson\(request, \{/);
  assert.match(
    route,
    /gameLabel: \{ type: "string", required: true, minLength: 2, maxLength: 80 \}/
  );

  // The row is always the caller's own users.id — never a body value.
  assert.match(route, /where\(eq\(users\.clerkId, userId\)\)/);
  assert.match(route, /await markPlaying\(\{/);
  assert.doesNotMatch(route, /body\??\.(userId|user_id|user)\b/);
  assert.doesNotMatch(route, /searchParams/);

  // Abuse control, and no response data beyond success.
  assert.match(route, /consumeRateLimit\(/);
  assert.match(route, /status: 429/);
  assert.match(route, /NextResponse\.json\(\{ success: true \}\)/);
});

// ── 6. Leave endpoint ────────────────────────────────────────────────────

test("leave handles an empty body and still validates what it gets", () => {
  const route = source(LEAVE);

  assert.match(route, /const \{ userId \} = await auth\(\);/);
  assert.match(route, /status: 401/);
  // An empty POST is valid ("I left everything").
  assert.match(route, /let body: unknown = \{\};/);
  assert.match(route, /body = text \? JSON\.parse\(text\) : \{\};/);
  assert.match(route, /validateObject\(body, \{/);
  // Same allowlist rule as the heartbeat.
  assert.match(route, /if \(!gameId\) \{[\s\S]{0,160}error: "Unknown game"/);
  assert.match(route, /await clearPlaying\(\{/);
  // Reports only the caller's own cleared count.
  assert.match(route, /NextResponse\.json\(\{ success: true, cleared \}\)/);
  assert.doesNotMatch(route, /body\??\.(userId|user_id|user)\b/);
});

// ── 7. Aggregate endpoint ────────────────────────────────────────────────

test("the read endpoint returns aggregate counts and nothing else", () => {
  const route = source(AGGREGATE);
  const routeCode = code(AGGREGATE);

  assert.match(route, /export async function GET\(\)/);
  assert.match(route, /cacheOrFetch\(\s*CacheKeys\.activePlayers\(\), CacheTTL\.activePlayers,/);
  assert.match(route, /countActivePlayers\(\)/);
  assert.match(route, /counts: counts \?\? \{\},/);
  // Public chrome: cacheable, but short.
  assert.match(route, /"Cache-Control": "public, s-maxage=10, stale-while-revalidate=5"/);
  // Fail closed — no counts, still a 200, never a broken lobby.
  assert.match(route, /success: false, counts: \{\}/);

  // No personal data can be in this response, by construction: not one
  // identifier-shaped field is referenced anywhere in the code.
  assert.doesNotMatch(routeCode, /userId|clerkId|user_id|sessionId|email|username|\bname\b/);
  // It must not take a game/user selector either.
  assert.doesNotMatch(routeCode, /searchParams|request\.url|\bparams\b/);

  // Cache key + TTL exist and are namespaced + short.
  const keys = source(KEYS);
  assert.match(keys, /activePlayers: \(\) => `\$\{PREFIX\}:presence:active-players`/);
  assert.match(keys, /activePlayers: 10,/);
});

// ── 8. Storage hygiene ───────────────────────────────────────────────────

test("stale rows are pruned by the existing daily retention sweep", () => {
  const retention = source(RETENTION);
  const store = source(STORE);

  // ONE implementation: the sweep delegates to the presence store (the module
  // that owns every access to user_game_presence) instead of repeating its
  // DELETE as raw SQL.
  assert.match(retention, /await pruneStalePresence\(\)/);
  assert.doesNotMatch(retention, /DELETE FROM user_game_presence/);
  assert.match(
    retention,
    /deletedByTable\["user_game_presence"\] = await pruneStalePresence\(\);/,
  );
  // Failure of the cosmetic purge must not fail the sweep.
  assert.match(retention, /\[retention\] purge failed for user_game_presence/);

  // The helper itself: a day-old cutoff, so nothing active can ever be removed.
  assert.match(store, /export async function pruneStalePresence\(maxAgeSeconds = 86400\)/);
  assert.match(store, /userGamePresence\.lastSeenAt\} < \$\{cutoff\}/);
});

// ── 9. Compatibility ─────────────────────────────────────────────────────

test("the existing presence systems and game behavior are untouched", () => {
  const store = source(STORE);
  const route = source(HEARTBEAT);

  // The new write path never touches the online/friends presence row.
  assert.doesNotMatch(store, /userPresence\b/);
  assert.doesNotMatch(route, /api\/presence\/game\b/);

  // The pre-existing endpoints and tables are still there, unchanged in shape.
  assert.match(source("src/app/api/presence/game/route.js"), /INSERT INTO user_presence/);
  assert.match(source("src/app/api/presence/leave-game/route.js"), /status = 'online'/);
  assert.match(source("src/app/api/presence/heartbeat/route.js"), /DO UPDATE SET/);
  assert.match(source("src/app/api/spectators/count/route.js"), /spectator_presence/);
  assert.match(source("src/app/api/stats/live/route.js"), /playersOnline/);

  // No game page, matchmaking module or game rule was modified by this phase:
  // the heartbeat is wired through the SHARED host (phase 3), not per game.
  const host = source(SESSION_HOST);
  assert.match(host, /useActiveGamePresence\(gameLabel, autoStart && !autoStop/);
  assert.match(host, /recordPlayedGame\(gameLabel\)/);
});

// ── 10. Client wiring (phase 3): every game through the shared edges ─────
//
// The backend is exercised above; this section covers the client half that
// makes a lobby badge possible without touching a single game rule:
//
//   • src/lib/gamePresenceClient.js — beat/leave transport + per-tab id
//   • src/hooks/useActiveGamePresence.js — the ONE shared hook
//   • <CreatorModeHost> — one wiring point for 21 game mounts
//   • the 4 pages that never mounted the host — wired next to their play edge
//   • the spectator guard — watching is not playing

const HOOK = "src/hooks/useActiveGamePresence.js";
const CLIENT = "src/lib/gamePresenceClient.js";

/** Minimal sessionStorage stand-in (same contract as the browser's). */
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

/**
 * Install a fake browser for the transport test and collect every request.
 *
 * `sessionStorage` is a fresh store per install (i.e. per "tab"); `fetch`
 * records the exact wire format instead of reaching the network. The real
 * `crypto` is left alone — the id only has to be opaque, stable and per tab.
 */
function installFakeBrowser({ storage = {}, fetchImpl } = {}) {
  const calls = [];
  globalThis.window = { sessionStorage: makeStorage(storage) };
  globalThis.fetch = (url, opts) => {
    calls.push({ url, opts });
    if (fetchImpl) return fetchImpl(url, opts);
    return Promise.resolve({ ok: true });
  };
  return calls;
}

function removeFakeBrowser() {
  delete globalThis.window;
  delete globalThis.fetch;
}

test("the transport keeps one id per tab and calls the phase 2 endpoints", async () => {
  const { getPresenceSessionId, sendPresenceBeat, sendPresenceLeave, PRESENCE_SESSION_KEY } =
    await import("../src/lib/gamePresenceClient.js");

  const calls = installFakeBrowser();

  const tabId = getPresenceSessionId();
  assert.equal(typeof tabId, "string");
  assert.ok(tabId.length >= 8, "a real id, not an empty placeholder");
  // Stable for the life of the tab — this file is exported once per session
  // so reloading the page cannot mint a second identity for the same browser.
  assert.equal(getPresenceSessionId(), tabId);
  assert.equal(globalThis.window.sessionStorage.getItem(PRESENCE_SESSION_KEY), tabId);

  // A second tab is a DIFFERENT session id — and that is safe: the server
  // upserts on (user_id, game_key), so it still counts as one player.
  installFakeBrowser();
  assert.notEqual(getPresenceSessionId(), tabId);

  // ── the beat: exactly the request the route documents ──
  const beatCalls = installFakeBrowser();
  await sendPresenceBeat("mines-duel", tabId);
  assert.equal(beatCalls.length, 1);
  assert.equal(beatCalls[0].url, "/api/presence/active-game");
  assert.equal(beatCalls[0].opts.method, "POST");
  assert.equal(beatCalls[0].opts.credentials, "include");
  assert.equal(beatCalls[0].opts.keepalive, true);
  assert.equal(beatCalls[0].opts.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(beatCalls[0].opts.body), {
    gameLabel: "mines-duel",
    sessionId: tabId,
  });

  // ── the deliberate leave: same shape, session-scoped ──
  await sendPresenceLeave("mines-duel", tabId);
  assert.equal(beatCalls[1].url, "/api/presence/active-game/leave");
  assert.deepEqual(JSON.parse(beatCalls[1].opts.body), {
    gameLabel: "mines-duel",
    sessionId: tabId,
  });
  // Never an identity: the server takes the caller from the Clerk session, so
  // no client value could make someone else look active.
  for (const call of beatCalls) {
    assert.doesNotMatch(call.opts.body, /userId|user_id|clerk/i);
  }

  removeFakeBrowser();
});

test("presence failures are swallowed — offline, 401, rate limit, no storage", async () => {
  const { getPresenceSessionId, sendPresenceBeat, sendPresenceLeave } = await import(
    "../src/lib/gamePresenceClient.js"
  );

  // Rejecting fetch (offline / DNS / aborted) must resolve false, not throw.
  installFakeBrowser({ fetchImpl: () => Promise.reject(new Error("network down")) });
  assert.equal(await sendPresenceBeat("chess", "tab-1"), false);
  assert.equal(await sendPresenceLeave("chess", "tab-1"), false);

  // A signed-out visitor (401) or a rate-limited client (429) is an expected
  // answer, not an error the game has to handle.
  installFakeBrowser({ fetchImpl: () => Promise.resolve({ ok: false, status: 401 }) });
  assert.equal(await sendPresenceBeat("chess", "tab-1"), false);

  // fetch missing entirely (exotic runtime) must not throw either.
  installFakeBrowser();
  delete globalThis.fetch;
  assert.equal(await sendPresenceBeat("chess", "tab-1"), false);

  // No session id is fine: it is optional in the API and never part of the
  // (user, game) uniqueness rule.
  const calls = installFakeBrowser();
  await sendPresenceBeat("chess", null);
  assert.deepEqual(JSON.parse(calls[0].opts.body), { gameLabel: "chess", sessionId: null });

  // Storage unavailable (SSR, private mode, quota): a null id, never a throw.
  removeFakeBrowser();
  assert.equal(getPresenceSessionId(), null);
  globalThis.window = {
    get sessionStorage() {
      throw new Error("SecurityError");
    },
  };
  assert.equal(getPresenceSessionId(), null);

  // A missing/empty label is refused client-side too.
  assert.equal(await sendPresenceBeat("", "tab-1"), false);
  assert.equal(await sendPresenceLeave(null, "tab-1"), false);

  removeFakeBrowser();
});

test("one shared hook reuses the phase 2 window and gates unknown games", () => {
  const hook = source(HOOK);

  // Reused constants, not a second copy of the cadence.
  assert.match(
    hook,
    /import \{ PRESENCE_HEARTBEAT_MS, isPresenceGame \} from "\.\.\/lib\/gamePresence"/
  );
  assert.match(hook, /setInterval\(beat, PRESENCE_HEARTBEAT_MS\)/);
  assert.match(hook, /clearInterval\(intervalId\)/);

  // A game the server would reject (or a page that opted out) sends NOTHING.
  assert.match(hook, /const tracking = enabled !== false && isPresenceGame\(gameLabel\);/);
  assert.match(hook, /const shouldBeat = tracking && Boolean\(active\);/);
  assert.match(hook, /if \(!shouldBeat\) return undefined;/);

  // Two exits: a finished session clears at once, navigating away clears on
  // unmount, and both stop beating first.
  assert.match(hook, /if \(!tracking \|\| !terminal\) return undefined;/);
  assert.match(hook, /sendPresenceLeave\(gameLabel, sessionIdRef\.current\)/);
  // The unmount leave is gated on "this mount beat", not on the CURRENT
  // opt-in flag: a mount that wrote a row owns it, even if it was later opted
  // out (an eliminated Tower Arena player navigating away mid-match).
  assert.match(hook, /if \(!didBeatRef\.current\) return;/);
  assert.match(hook, /sendPresenceLeave\(latestRef\.current\.gameLabel, sessionIdRef\.current\)/);

  // This hook must never grow a say in the game itself: no UI, no state that
  // gameplay reads, no other endpoint.
  assert.doesNotMatch(hook, /useState|useContext/);
  assert.doesNotMatch(hook, /return \(\s*</, "the hook renders nothing");
  assert.doesNotMatch(hook, /\/api\/(?!presence)/);
  assert.doesNotMatch(hook, /balance|wager|payout|winner|outcome/i);
});

test("no page sends a presence beat itself — one shared implementation", () => {
  const files = [
    ...walk("src/app"),
    ...walk("src/components"),
    ...walk("src/hooks"),
    ...walk("src/lib"),
  ];
  // code() drops `//` comments, so naming the route in prose (docs, headers)
  // does not count as a caller.
  const senders = files.filter((file) => code(file).includes("/api/presence/active-game"));

  assert.deepEqual(
    senders.map((f) => f.split(path.sep).join("/")).sort(),
    [CLIENT],
    "the endpoint is called from exactly one place"
  );
});

test("the shared host is the single wiring point, and every game feeds it", () => {
  const host = source(SESSION_HOST);

  assert.match(host, /presenceEnabled = true,/);
  assert.match(
    host,
    /useActiveGamePresence\(gameLabel, autoStart && !autoStop, \{\s*enabled: presenceEnabled,\s*terminal: autoStop,\s*\}\)/s
  );
  // The beat cadence lives in the hook; the host only forwards the game's
  // real lifecycle, so recording and presence can never disagree.
  assert.doesNotMatch(host, /setInterval/);
  assert.doesNotMatch(code(SESSION_HOST), /fetch\(/);

  // Every game surface that mounts the host passes BOTH lifecycle signals:
  // without autoStart a game could never be counted, without autoStop it could
  // be counted forever (finished matches). `precision-test` is the developer
  // harness route that resolveGameId deliberately rejects.
  // The tag must open a line (a prose mention in a comment is not a mount).
  const pages = walk("src/app").filter((file) => /^\s*<CreatorModeHost/m.test(source(file)));
  assert.ok(pages.length >= 21, `expected >= 21 game surfaces, found ${pages.length}`);
  for (const file of pages) {
    const src = source(file);
    assert.match(src, /autoStart=/, `${file} must pass autoStart`);
    assert.match(src, /autoStop=/, `${file} must pass autoStop`);
  }
});

test("the 4 pages without the host wire the same hook next to their play edge", () => {
  const callers = [...walk("src/app"), ...walk("src/hooks"), ...walk("src/components")].filter(
    (file) => /useRecordPlayedGame\(\s*"/.test(source(file))
  );

  assert.equal(callers.length, 4, "hex-duel, pool-masters, odds, crash-arena");

  for (const file of callers) {
    const src = source(file);
    const labels = [...src.matchAll(/useRecordPlayedGame\(\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(labels.length > 0, `${file} records a play`);
    for (const label of labels) {
      assert.match(
        src,
        new RegExp(`useActiveGamePresence\\(\\s*"${label}"`),
        `${file} must wire presence for "${label}"`
      );
    }
  }
});

test("a spectator on a live game is never counted as playing", () => {
  // Four host-mounted games expose a view-only spectator URL where the match
  // looks in_progress to the watcher too.
  const hostGuards = {
    "src/app/casino/chess-game/[gameId]/PageClient.jsx": "presenceEnabled={!isSpectator}",
    "src/app/casino/four-in-a-row/game/[gameId]/PageClient.tsx": "presenceEnabled={!isSpectator}",
    "src/app/casino/poker/multi/PageClient.tsx": "presenceEnabled={!isSpectator}",
  };
  for (const [file, needle] of Object.entries(hostGuards)) {
    assert.ok(source(file).includes(needle), `${file} must opt spectators out of presence`);
  }
  assert.match(
    source("src/app/casino/dots-and-boxes/game/[gameId]/PageClient.tsx"),
    /presenceEnabled=\{game\?\.role !== "spectator"\}/
  );

  // And the fifth spectator surface (hex-duel, which never mounted the host).
  assert.match(
    source("src/app/casino/hex-duel/PageClient.tsx"),
    /useActiveGamePresence\("hex-duel", showGame && !isSpectator/
  );

  // Tower Arena's version of the same state: a player eliminated mid-match
  // stays on the live page, and the page itself calls them out of the running.
  // Presence opts out (Creator Mode keeps recording the match as before).
  const towerArena = source("src/app/casino/tower-arena/game/[matchId]/PageClient.tsx");
  assert.match(towerArena, /presenceEnabled=\{!iAmEliminated\}/);
  assert.match(towerArena, /const iAmEliminated = Boolean\(isActive && me\?\.status === "eliminated"\);/);
});

test("each direct integration stops counting when its game reaches a final state", () => {
  // Games that can't reuse autoStop pass their own terminal signal, so a
  // finished match never stays in the badge for the whole activity window.
  assert.match(
    source("src/app/casino/pool-masters/game/[matchId]/PageClient.tsx"),
    /useActiveGamePresence\("pool-masters", started && balls\.length > 0, \{\s*terminal: Boolean\(winner\),/s
  );
  assert.match(
    source("src/app/casino/hex-duel/PageClient.tsx"),
    /terminal: isGameOverEffective,/
  );
  const odds = source("src/app/casino/odds/PageClient.tsx");
  assert.equal((odds.match(/terminal: gameOver/g) ?? []).length, 2, "AI duel + PvP duel");

  // Crash Arena deliberately has no `terminal`: a table runs endless rounds
  // and the wait between them is part of playing, so the gap is absorbed by
  // the server window rather than dropping the player between rounds.
  const crash = source("src/app/casino/crash-arena/table/[tableId]/PageClient.jsx");
  assert.match(
    crash,
    /useActiveGamePresence\("crash-arena", roundState\?\.phase === "running"\)/
  );
  assert.doesNotMatch(crash, /terminal:/);
});

// ── 11. Lobby badge (phase 4): counts on the existing game cards ─────────
//
// The count in the casino lobby: one poll for the whole grid, mapped onto the
// cards the lobby already had. What matters here is that the badge can never
// mislead (no invented numbers, no zero when the read failed), that it is
// localized through the app-text catalog, and that it stays out of the card's
// link so screen readers still get it as text.

const LOCALES = ["en", "fr", "es"];
const lobby = source(LOBBY);

/** The card region, so assertions can't be satisfied elsewhere in the file. */
const cardStart = lobby.indexOf("const GameCard = (");
const cardEnd = lobby.indexOf("const PlayerCountBadge = (");
const cardBlock = lobby.slice(cardStart);
const badgeBlock = lobby.slice(cardEnd, cardStart);
/** The grid pipeline (filters → sort), which the badge must not touch. */
const pipelineBlock = lobby.slice(
  lobby.indexOf("let displayedGames"),
  lobby.indexOf('// Real play counts for the "Most Played" sort')
);
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

test("the badge's three states are pure rules, not JSX guesswork", async () => {
  const { activePlayerTier, formatPlayerCount, HOT_PLAYER_THRESHOLD } = await import(
    "../src/lib/gamePresence.js"
  );

  // Nobody / playing / hot, with the boundary exactly where the constant says.
  assert.equal(HOT_PLAYER_THRESHOLD, 50);
  assert.equal(activePlayerTier(0), "none");
  assert.equal(activePlayerTier(1), "playing");
  assert.equal(activePlayerTier(HOT_PLAYER_THRESHOLD - 1), "playing");
  assert.equal(activePlayerTier(HOT_PLAYER_THRESHOLD), "hot");
  assert.equal(activePlayerTier(127), "hot");
  // A missing/garbage count is NEVER "playing": the badge cannot invent one.
  for (const value of [undefined, null, NaN, -1, "nope", {}]) {
    assert.equal(activePlayerTier(value), "none");
  }
  assert.equal(activePlayerTier("12"), "playing", "a numeric string from the API still counts");

  // Formatting: localized, whole, never negative, never a throw.
  assert.equal(formatPlayerCount(12, "en"), "12");
  assert.equal(formatPlayerCount(1234, "en"), "1,234");
  assert.equal(formatPlayerCount(undefined), "0");
  assert.equal(formatPlayerCount(7.8), "7");
  assert.equal(formatPlayerCount(-4), "0");
  assert.equal(formatPlayerCount(99, "not a locale"), "99");
});

test("the lobby polls one aggregate for every card, and cleans up", () => {
  // One endpoint, fetched once — never a request per card.
  assert.equal(countOf(code(LOBBY), "/api/casino/active-players"), 1);
  assert.doesNotMatch(cardBlock, /fetch\(/);
  assert.doesNotMatch(badgeBlock, /fetch\(/);

  const effect = lobby.slice(
    lobby.indexOf("// Active players per game (the lobby's \"N playing\" line). One request"),
    cardStart
  );
  assert.match(effect, /useEffect\(\(\) => \{/);
  assert.match(effect, /fetch\("\/api\/casino\/active-players", \{ cache: "no-store" \}\)/);
  assert.match(effect, /setInterval\(load, ACTIVE_PLAYERS_POLL_MS\)/);
  // In the requested 15–30s window, and never overlapping itself or the
  // endpoint's own 10s cache.
  const pollMs = Number(lobby.match(/const ACTIVE_PLAYERS_POLL_MS = (\d+);/)?.[1]);
  assert.ok(pollMs >= 15000 && pollMs <= 30000, `poll cadence ${pollMs}ms`);
  assert.match(effect, /if \(inFlight\) return;/);
  // Nothing reloads the page, and polling stops on unmount + hidden tabs.
  assert.doesNotMatch(lobby, /location\.reload/);
  assert.match(effect, /document\.visibilityState === "visible" \? start\(\) : stop\(\)/);
  assert.match(effect, /clearInterval\(id\)/);
  assert.match(effect, /document\.removeEventListener\("visibilitychange", onVisibility\)/);
  assert.match(effect, /cancelled = true;/);
});

test("counts map by the lobby's own game id, and never print a lie", () => {
  // The count is looked up with the id the card already carries — no parallel
  // game list, no hardcoded numbers.
  assert.match(badgeBlock, /activePlayers\.counts\?\.\[game\.leaderboardKey\] \?\? 0/);
  assert.doesNotMatch(lobby, /counts\s*=\s*\{\s*(roulette|chess|crash)/);

  // A failed read (the route answers 200 with success:false when its store is
  // down) becomes "error", and an error renders NOTHING — no "0 playing".
  assert.match(lobby, /if \(!res\.ok \|\| data\?\.success !== true\)/);
  assert.match(lobby, /setActivePlayers\(\{ status: "error", counts: \{\} \}\)/);
  assert.match(badgeBlock, /if \(activePlayers\.status !== "ready"\) return null;/);

  // Loading is a subtle placeholder (aria-hidden, no text, fixed height), so
  // the cards never look broken and never reflow when the answer lands.
  assert.match(badgeBlock, /if \(activePlayers\.status === "loading"\)/);
  assert.match(badgeBlock, /aria-hidden="true"/);
  assert.match(badgeBlock, /animate-pulse/);

  // The rows are derived state only: filters, sorting, search and the links are
  // exactly what they were.
  assert.doesNotMatch(pipelineBlock, /activePlayers/);
  assert.match(lobby, /const filteredGames = games\.filter\(/);
  assert.match(pipelineBlock, /displayedGames\.sort\(/);
  assert.match(lobby, /buildCreatorHref\(game\.href, creatorModeEnabled\)/);
});

test("the count is readable text, not a colour, and is not swallowed by the link", () => {
  // Every state spells itself out; the glyph is decoration and is hidden from
  // assistive tech, so nothing depends on the dot's colour.
  assert.match(badgeBlock, /aria-hidden="true"/);
  assert.match(badgeBlock, /tier === "hot" \? "🔥" : "●"/);
  assert.match(lobby, /t\("home\.casino_lobby\.players_none"\)/);
  assert.match(
    lobby,
    /t\("home\.casino_lobby\.players_playing", \{\s*count: formatPlayerCount\(players, language\),\s*\}\)/s
  );

  // The row is rendered AFTER the card's </Link>: that link carries its own
  // aria-label, which would otherwise replace the count for screen readers.
  const linkEnd = cardBlock.indexOf("</Link>");
  const badgeUse = cardBlock.indexOf("<PlayerCountBadge game={game} />");
  assert.ok(linkEnd > -1 && badgeUse > linkEnd, "the badge must sit outside the card link");
});

test("the new strings exist in every locale and interpolate the count", async () => {
  const { t } = await import("../src/lib/appTextTranslations.js");

  for (const lang of LOCALES) {
    for (const key of ["players_playing", "players_none"]) {
      const path = `home.casino_lobby.${key}`;
      const raw = t(lang, path);
      assert.notEqual(raw, path, `${lang}: ${key} is missing`);
      assert.ok(raw.trim().length > 0, `${lang}: ${key} is empty`);
    }
    // The count lands in the sentence, not in a placeholder graveyard.
    const withCount = t(lang, "home.casino_lobby.players_playing", { count: "7" });
    assert.ok(withCount.includes("7"), `${lang}: "${withCount}" lost the count`);
    assert.doesNotMatch(withCount, /\{count\}/, `${lang}: unsubstituted placeholder`);
  }
});

test("the browser harness exercises the longest shipped label", async () => {
  const { t } = await import("../src/lib/appTextTranslations.js");
  const harness = source("qa/lobby-for-you-check.mjs");

  // The layout harness is what proves a wide label still fits a card, so it
  // must render the WIDEST string we ship. Copying the current longest one
  // keeps the two in lockstep: growing a translation past the 200px budget
  // turns the harness red instead of silently clipping a real card.
  const longest = LOCALES.map((lang) => t(lang, "home.casino_lobby.players_none"))
    .sort((a, b) => b.length - a.length)[0];

  assert.ok(
    harness.includes(`const text = none ? "${longest}" :`),
    `the harness fixture must render the longest label ("${longest}")`,
  );
  assert.ok(
    harness.includes(`text.includes("${longest}")`),
    "the harness must assert that longest label survives the layout",
  );
});

test("the lobby file is the only place the badge renders, and it uses the card", () => {
  // The grid and the "For You" strip render the SAME GameCard, so one badge
  // covers both — no second card system was introduced.
  // GameCard is rendered by the grid AND the "For You" strip.
  assert.ok(
    countOf(lobby, "<GameCard game={game}") >= 2,
    "GameCard is reused by both the grid and the strip"
  );
  assert.equal(countOf(lobby, "<PlayerCountBadge game={game} />"), 1);
  assert.equal(countOf(lobby, "const GameCard = ("), 1);
  assert.equal(countOf(lobby, "const PlayerCountBadge = ("), 1);
});
