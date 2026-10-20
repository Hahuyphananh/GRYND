// tests/odds-ai-leave.test.mjs
//
// Odds vs AI — connection logic.
//
// A vs-AI duel is only alive while the page is open. These tests pin the two
// halves of that rule:
//
//   1. The client (`src/app/casino/odds/game/[matchId]/PageClient.tsx`)
//        * leaves the active duel on `pagehide` / `beforeunload` via
//          `sendBeacon` (a logout, refresh or closed tab), and on unmount
//          (an in-app navigation);
//        * abandons any leftover duel on mount instead of resuming it, so a
//          returning player always lands on the create-game lobby.
//   2. The endpoint (`src/app/api/odds/ai/leave/route.ts`)
//        * scopes the write to the caller's OWN still-playing AI duel;
//        * flips it to `cancelled` (out of the active set AND out of bet
//          history), never settling tokens;
//        * is idempotent and reads no identity from the body.
//
// Run:  node --test tests/odds-ai-leave.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const CLIENT = "src/app/casino/odds/game/[matchId]/PageClient.tsx";
const ROUTE = "src/app/api/odds/ai/leave/route.ts";

const source = (relPath) =>
  fs.readFileSync(path.join(process.cwd(), relPath), "utf8").replace(/\r\n/g, "\n");

// Drop `//` comment lines so assertions are about what the CODE references.
const code = (relPath) =>
  source(relPath)
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

// ── 1. Endpoint ──────────────────────────────────────────────────────────

test("leave route exists and is a POST endpoint", () => {
  assert.ok(fs.existsSync(ROUTE), `${ROUTE} must exist`);
  const route = code(ROUTE);
  assert.match(route, /export async function POST\s*\(/);
});

test("leave route takes identity from the Clerk session, never the body", () => {
  const route = code(ROUTE);
  assert.match(route, /from "@clerk\/nextjs\/server"/);
  assert.match(route, /auth\(\)/);
  assert.match(route, /eq\(oddsGames\.player1Id, userId\)/);
  // No request-supplied player/user id may ever be read.
  assert.doesNotMatch(route, /body\??\.(playerId|userId|clerkId)\b/);
});

test("leave route only abandons the caller's own AI duels", () => {
  const route = code(ROUTE);
  assert.match(route, /isAi, true/);
  assert.match(route, /status, "playing"/);
  assert.match(route, /eq\(oddsGames\.id, requestedId\)/);
});

test("leave route cancels the duel (out of active set + history) with an end stamp", () => {
  const route = code(ROUTE);
  assert.match(route, /status: "cancelled"/);
  assert.match(route, /endedAt: new Date\(\)/);
  // Free play: no settlement, no stats/leaderboard writes.
  assert.doesNotMatch(route, /balance/i);
  assert.doesNotMatch(route, /normalizeStake/);
  assert.doesNotMatch(route, /applyRatingResult|recordTrophies|leaderboard/i);
});

test("leave route is idempotent and tolerates an empty beacon body", () => {
  const route = code(ROUTE);
  // A missing / unparsable body means "leave everything", not a 400.
  assert.match(route, /req\.json\(\)\.catch\(\(\) => \(\{\}\)\)/);
  // An already-gone game is filtered out by the WHERE clause, so a retry is
  // a harmless 0-row update — success either way.
  assert.match(route, /success: true/);
});

// ── 2. Client connection logic ───────────────────────────────────────────

test("client leaves the duel on pagehide / beforeunload via sendBeacon", () => {
  const client = code(CLIENT);
  assert.match(client, /window\.addEventListener\("pagehide", onLeave\)/);
  assert.match(client, /window\.addEventListener\("beforeunload", onLeave\)/);
  assert.match(client, /navigator\.sendBeacon\(/);
  assert.match(client, /"\/api\/odds\/ai\/leave"/);
});

test("client leaves on unmount (in-app navigation) as well", () => {
  const client = code(CLIENT);
  // The cleanup of the unload effect also fires the leave.
  assert.match(
    client,
    /removeEventListener\("beforeunload", onLeave\);[\s\S]*?leaveActiveGame\(false\)/,
  );
});

test("client abandons a leftover duel on mount instead of resuming it", () => {
  const client = code(CLIENT);
  // The mount check reads status and, when a duel is still active, calls
  // leave — it never restores the old board, so the lobby shows.
  assert.match(client, /\/api\/odds\/ai\/status/);
  assert.match(
    client,
    /data\.data\.active[\s\S]{0,500}?\/api\/odds\/ai\/leave/,
  );
});

test("client does not leave a duel that already finished", () => {
  const client = code(CLIENT);
  assert.match(client, /gameOverRef\.current/);
  assert.match(client, /leftActiveGameRef\.current/);
});
