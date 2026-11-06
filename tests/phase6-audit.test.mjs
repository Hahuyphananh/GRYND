// tests/phase6-audit.test.mjs
//
// PHASE 6 — full-system regression audit.
//
// These are source/migration contract tests for the invariants that must hold
// across Phases 1-5. They complement the behavioural suites (guest-progress,
// guest-pvp, guest-claim, guest-session, guest-realtime, platform-integration),
// which are run separately and reported with actual counts.
//
// What is pinned here:
//   · the Phase 1-5 tables are default-deny under RLS (no anon/PostgREST read);
//   · the migration journal is ordered and additive;
//   · a Guest-involved match refuses official progression at EVERY settlement
//     writer, including Tic-Tac-Toe's ranked path;
//   · claim is transactional, row-locked and idempotent by constraint;
//   · platform sessions are hashed, scoped and unrelated to accounts;
//   · embed responses cannot leak the URL token through caches/Referer;
//   · guest Socket.IO identity is restricted to its own game rooms;
//   · guest PvP stays on the free Dominoes allowlist and never enters
//     matchmaking for another game.
//
// Run: npm run test:phase6

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const strip = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const stripSql = (src) => src.replace(/^\s*--.*$/gm, "");

// ── 1. RLS / database exposure ─────────────────────────────────────────────

test("every Phase 1-5 table is default-deny under RLS", () => {
  const sqlText = read("src/db/migrations/0243_guest_and_platform_rls.sql");
  const sql = stripSql(sqlText);

  for (const table of [
    "guest_profiles",
    "guest_practice_results",
    "guest_claims",
    "platform_sessions",
  ]) {
    assert.match(
      sql,
      new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`),
      `${table} must enable RLS`,
    );
    assert.match(
      sql,
      new RegExp(`CREATE POLICY "${table}_no_client_access" ON "${table}"[\\s\\S]*?USING \\(false\\)[\\s\\S]*?WITH CHECK \\(false\\);`),
      `${table} must have an explicit deny policy`,
    );
    assert.match(
      sql,
      new RegExp(`REVOKE ALL ON "${table}"\\s+FROM PUBLIC;`),
      `${table} must revoke PUBLIC grants`,
    );
  }

  // The serial sequence is a separate relation.
  assert.match(sql, /REVOKE ALL ON SEQUENCE "guest_practice_results_id_seq" FROM PUBLIC;/);

  // Never disable or force RLS, never drop/rewrite anything.
  assert.doesNotMatch(sql, /DISABLE ROW LEVEL SECURITY/i);
  assert.doesNotMatch(sql, /FORCE ROW LEVEL SECURITY/i);
  assert.doesNotMatch(sql, /DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)/i);
  assert.doesNotMatch(sql, /\bDELETE\b|\bTRUNCATE\b|\bUPDATE\b/i);
});

test("the audit migration is registered last in a contiguous journal", () => {
  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
  const entries = journal.entries;
  const entry = entries.find((candidate) => candidate.tag === "0243_guest_and_platform_rls");

  assert.ok(entry);
  assert.equal(entry.idx, entries.length - 1);
  assert.equal(entry.idx, entries.indexOf(entry));
  assert.equal(entry.version, "7");
  assert.equal(entry.breakpoints, true);
  for (let i = 1; i < entries.length; i += 1) assert.equal(entries[i].idx, i);
  assert.ok(entry.when > entries[entries.length - 2].when);
  assert.ok(fs.existsSync(path.join(ROOT, "src/db/migrations/0243_guest_and_platform_rls.sql")));
});

// ── 2. Unrated settlement invariants ───────────────────────────────────────

test("Tic-Tac-Toe refuses a guest seat before any official progression", () => {
  const src = strip(read("src/lib/tic-tac-toe/serverStore.ts"));
  const guard = src.indexOf(
    "if (isGuestId(match.player1Id) || isGuestId(match.player2Id)) return;",
  );
  assert.ok(guard > 0, "the guest guard must exist");
  assert.ok(guard < src.indexOf("gamesWon: sql"), "guard before W/L counters");
  assert.ok(
    guard < src.indexOf('gameKey: "tic-tac-toe"', guard),
    "guard before the rated writers",
  );
  assert.ok(guard < src.indexOf("settlePayout(", guard), "guard before any payout");
});

test("Dominoes refuses a guest seat before counters, ratings or trophies", () => {
  const src = strip(read("src/lib/dominoes/serverStore.ts"));
  const guard = src.indexOf("if (isGuestId(player1) || isGuestId(player2)) return;");
  assert.ok(guard > 0);
  assert.ok(guard < src.indexOf("gamesWon: sql"));
  assert.ok(guard < src.indexOf('gameKey: "dominoes"'));
});

test("the shared rated writers independently refuse a guest seat", () => {
  for (const file of ["src/lib/rating.js", "src/lib/trophyStore.js"]) {
    const src = read(file);
    assert.match(src, /isGuestPvpMatch\(\[winnerClerkId, loserClerkId\]\)/);
    assert.match(src, /reason: "guest-unrated"/);
  }
  assert.match(read("src/lib/pvp/guestMatch.ts"), /GUEST_MATCH_UNRATED_REASON = "guest-unrated"/);
});

test("guest practice results are unrated, cosmetic and idempotent by constraint", () => {
  const writer = read("src/lib/guest/practiceProgress.ts");
  assert.match(writer, /isGuestId\(input\.guestId\)/);
  assert.match(writer, /GUEST_PRACTICE_GAME_KEYS/);
  assert.match(writer, /onConflictDoNothing/);
  // No official progression module may be imported by the guest writer.
  assert.doesNotMatch(
    writer,
    /from "\.\.\/(rating|trophyStore|tokens|quests|leaderboard)/,
  );

  const migration = read("src/db/migrations/0240_guest_practice_results.sql");
  assert.match(migration, /UNIQUE \("game_key", "match_id"\)/);
  assert.match(migration, /CHECK \("result" IN \('win', 'loss', 'draw'\)\)/);
  assert.match(migration, /ON DELETE CASCADE/);
});

// ── 3. Guest conversion ────────────────────────────────────────────────────

test("guest conversion is transactional, locked and one-guest-one-account", () => {
  const claim = strip(read("src/lib/guest/claim.ts"));
  assert.match(claim, /db\.transaction\(/);
  assert.match(claim, /\.for\("update"\)/);
  assert.match(claim, /isUniqueViolation/);
  assert.match(claim, /isClerkUserId\(input\.userId\)/);
  assert.match(claim, /isGuestId\(input\.guestId\)/);
  // The claim never writes or rewrites account progression.
  assert.doesNotMatch(claim, /users|userStats|playerRatings|playerTrophies|tokens/);

  const migration = read("src/db/migrations/0241_guest_claims.sql");
  assert.match(migration, /"guest_id" varchar\(64\) PRIMARY KEY/);
  assert.match(migration, /UNIQUE \("claimed_by_user_id"\)/);
  assert.match(migration, /REFERENCES "users" \("clerk_id"\) ON DELETE CASCADE/);
  assert.match(migration, /win_count" \+ "loss_count" \+ "draw_count" = "match_count"/);
});

test("the claim routes take the guest id from the signed cookie only", () => {
  const route = strip(read("src/app/api/guest/claim/route.ts"));
  assert.match(route, /readGuestId\(\)/);
  assert.match(route, /const \{ userId \} = await auth\(\)/);
  assert.doesNotMatch(route, /req\.json|searchParams|params\.|headers\(\)\.get\(["']x-/);
  assert.match(route, /Cache-Control": "no-store"/);
});

// ── 4. Platform sessions and embedded support ──────────────────────────────

test("platform sessions are hashed, scoped and account-free", () => {
  const session = strip(read("src/lib/platform/session.ts"));
  assert.match(session, /createHash\("sha256"\)/);
  assert.match(session, /tokenHash: hashPlatformToken\(sessionToken\)/);
  assert.match(session, /options\.platform && row\.platform !== options\.platform/);
  assert.match(session, /options\.gameKey && row\.gameKey !== options\.gameKey/);
  assert.match(session, /row\.endedAt/);
  assert.match(session, /expiresAt\.getTime\(\) <= now\.getTime\(\)/);
  assert.doesNotMatch(session, /userId|clerkId|@clerk/);

  const migration = read("src/db/migrations/0242_platform_sessions.sql");
  assert.doesNotMatch(stripSql(migration), /user_id|clerk_id/i);
  assert.match(migration, /"token_hash" varchar\(64\) PRIMARY KEY/);
  assert.match(migration, /"platform_origin" varchar\(255\) NOT NULL/);
});

test("embed responses keep the URL token out of caches and Referer", async () => {
  const { applyEmbedFramePolicy } = await import("../src/lib/platform/framing.ts");
  const embed = new Headers({
    "Content-Security-Policy": "default-src 'self'; frame-ancestors 'self';",
    "Cache-Control": "public, max-age=3600",
  });
  applyEmbedFramePolicy({ headers: embed }, "/embed/testportal/tic-tac-toe", {
    GRYND_PLATFORM_ALLOWLIST: "testportal=https://portal.example",
  });
  assert.equal(embed.get("Cache-Control"), "no-store");
  assert.equal(embed.get("Referrer-Policy"), "no-referrer");

  // Standalone responses keep their cache policy untouched.
  const standalone = new Headers({ "Cache-Control": "public, s-maxage=5" });
  applyEmbedFramePolicy({ headers: standalone }, "/games/tic-tac-toe", {});
  assert.equal(standalone.get("Cache-Control"), "public, s-maxage=5");
  assert.equal(standalone.get("Referrer-Policy"), null);
});

test("only opted-in Tic-Tac-Toe practice routes accept a platform token", () => {
  for (const file of [
    "src/app/api/tic-tac-toe/create-ai/route.ts",
    "src/app/api/tic-tac-toe/match/[matchId]/route.ts",
    "src/app/api/tic-tac-toe/match/[matchId]/move/route.ts",
    "src/app/api/tic-tac-toe/match/[matchId]/cancel/route.ts",
    "src/app/api/tic-tac-toe/match/[matchId]/forfeit/route.ts",
  ]) {
    assert.match(read(file), /requirePracticePlayer\(\{[\s\S]*?platformGame: "tic-tac-toe"/);
  }
  assert.doesNotMatch(read("src/app/api/tic-tac-toe/create-or-join/route.ts"), /platformGame/);
  assert.match(read("src/app/api/guest/progress/route.ts"), /requirePracticePlayer\(\)/);
});

// ── 5. Realtime and guest PvP ──────────────────────────────────────────────

test("guest sockets are limited to Dominoes match rooms and a join budget", () => {
  const server = read("realtime-server/server.js");
  assert.match(server, /socket\.data\.isGuest = true/);
  assert.match(server, /if \(socket\.data\.isGuest\) \{/);
  assert.match(server, /allowGuestRoomJoin\(socket\)/);
  assert.match(server, /startsWith\("dominoes:match:"\)/);
  assert.match(server, /win\.count <= 60/);
  // Per-user and admin rooms cannot be named by a client.
  assert.match(server, /startsWith\(USER_ROOM_PREFIX\)\) return;/);
  assert.match(server, /=== ADMIN_NOTIFICATIONS_ROOM\) return;/);
  // Clerk verification is not weakened.
  assert.match(server, /verifyToken\(token/);
});

test("guest Socket.IO identity comes only from the HMAC cookie", () => {
  const auth = strip(read("realtime-server/guestAuth.js"));
  assert.match(auth, /timingSafeEqual/);
  assert.match(auth, /GUEST_ID_PATTERN = \/\^guest_\[0-9a-f\]\{32\}\$\//);
  assert.match(auth, /if \(!secret\) return null/);
  assert.doesNotMatch(auth, /handshake|query|body/);
});

test("guest PvP stays on the free Dominoes allowlist", () => {
  const queue = read("src/lib/quickQueue.ts");
  assert.match(queue, /GUEST_PVP_GAME_KEYS = \["dominoes"\]/);
  assert.match(queue, /rated: !isGuest/);
  assert.match(queue, /Guests can only queue for supported guest PvP games/);

  const rooms = read("src/lib/rooms/rules.ts");
  assert.match(rooms, /guest_free_only/);
  assert.match(rooms, /guest_game_unsupported/);
  assert.match(rooms, /guest_challenge_unsupported/);

  // Guest queue traffic is rate limited; guest room joins are rate limited.
  assert.match(read("src/app/api/quick-queue/route.ts"), /PVP_GUEST_RATE_LIMITS/);
  assert.match(read("src/lib/rooms/api.ts"), /ROOM_LIMITS/);
});
