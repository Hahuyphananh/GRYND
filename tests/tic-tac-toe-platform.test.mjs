/**
 * tic-tac-toe-platform.test.mjs
 *
 * PLATFORM integration and the TRUST BOUNDARY, asserted against the real
 * sources and the real modules — no re-declared lists — so a future refactor
 * that drops Tic-Tac-Toe from any of these surfaces fails here rather than in
 * production.
 *
 * Two halves:
 *
 *   1. REGISTRATION. It is a rated game under a canonical key, its trophies
 *      come from the shared registry, the retention sweep knows its table, the
 *      migration + journal + schema agree, and the realtime server's restated
 *      room literal is byte-identical to the TypeScript vocabulary.
 *
 *   2. THE TRUST BOUNDARY. The move route forwards only `cellIndex` and
 *      `expectedVersion`; no mutator accepts a decision; the store owns no
 *      rating maths and never moves money; every writer spells the game key as
 *      a literal (because tests/trophy-system.test.mjs audits it that way); and
 *      the game contains no randomness.
 *
 * Run:  node --import tsx --test tests/tic-tac-toe-platform.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { RATED_GAMES, RATING_GAME_LABELS, isRatedGame, normalizeRatingGameKey, getRatingGameLabel } =
  await import("../src/lib/rating.js");
const { TROPHY_GAMES } = await import("../src/lib/trophies.js");
const { TIC_TAC_TOE_MATCH_ROOM_PREFIX, TIC_TAC_TOE_READY, TIC_TAC_TOE_MATCH_UPDATED, ticTacToeMatchRoom } =
  await import("../src/lib/tic-tac-toe/rooms.ts");

const KEY = "tic-tac-toe";

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
/** Normalise CRLF so a source assertion never depends on a checkout's EOL. */
const strip = (src) => src.replace(/\r\n/g, "\n");

const STORE = "src/lib/tic-tac-toe/serverStore.ts";
const RULES = "src/lib/tic-tac-toe/rules.ts";
const CONSTANTS = "src/lib/tic-tac-toe/constants.ts";
const ROOMS = "src/lib/tic-tac-toe/rooms.ts";
const MOVE_ROUTE = "src/app/api/tic-tac-toe/match/[matchId]/move/route.ts";
const REALTIME = "realtime-server/server.js";
const MIGRATION = "src/db/migrations/0192_tic_tac_toe.sql";

// ════════════════════════════════════════════════════════════════════════
// 1. Rated-game registry
// ════════════════════════════════════════════════════════════════════════

test("registry: tic-tac-toe is a rated game under the canonical key", () => {
  assert.ok(RATED_GAMES.includes(KEY));
  assert.equal(isRatedGame(KEY), true);
  // The fallback trap: an unregistered key silently resolves to RATED_GAMES[0]
  // and would rate Tic-Tac-Toe matches under chess.
  assert.equal(normalizeRatingGameKey(KEY), KEY);
});

test("registry: the display name is exactly \"Tic-Tac-Toe\"", () => {
  assert.equal(RATING_GAME_LABELS[KEY], "Tic-Tac-Toe");
  assert.equal(getRatingGameLabel(KEY), "Tic-Tac-Toe");
});

test("registry: trophies are derived from the same list, so there is one source", () => {
  assert.ok(TROPHY_GAMES.includes(KEY));
});

// ════════════════════════════════════════════════════════════════════════
// 2. Storage hygiene
// ════════════════════════════════════════════════════════════════════════

test("retention: the daily sweep purges the terminal Tic-Tac-Toe match table", () => {
  const src = strip(read("src/app/api/jobs/retention/route.ts"));
  assert.match(src, /purge\("tic_tac_toe_matches", FINISHED\)/);
});

test("migration + journal: 0192 is registered as the next entry", () => {
  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
  const last = journal.entries.at(-1);
  assert.equal(last.idx, 173);
  assert.equal(last.tag, "0192_tic_tac_toe");
  // Indices are contiguous — nothing was inserted out of order.
  assert.equal(journal.entries.length, 174);
  journal.entries.forEach((entry, index) => assert.equal(entry.idx, index, `entry ${index}`));
});

test("migration: declares both tables and both invariant indexes", () => {
  const sql = strip(read(MIGRATION));
  assert.match(sql, /CREATE TABLE IF NOT EXISTS tic_tac_toe_matches/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS tic_tac_toe_moves/);
  assert.match(sql, /REFERENCES tic_tac_toe_matches\(id\) ON DELETE CASCADE/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS tic_tac_toe_moves_ply_unique/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS tic_tac_toe_moves_cell_unique/);
  assert.match(sql, /CHECK \(cell_index BETWEEN 0 AND 8\)/);
  // A draw is representable.
  assert.match(sql, /CHECK \(result IN \('player1', 'player2', 'tie'\)\)/);
  // Unstaked: no money columns anywhere. Comments are stripped first — the
  // header deliberately NAMES the columns it refuses to declare.
  const ddl = sql.replace(/^--.*$/gm, "");
  for (const forbidden of ["stake_amount", "prize_paid", "house_fee", "wager", "payout"]) {
    assert.equal(ddl.includes(forbidden), false, `migration must not declare ${forbidden}`);
  }
});

test("schema: the tables, the unique indexes and the absent seed column", () => {
  const schema = strip(read("src/db/schema.ts"));
  assert.match(schema, /export const ticTacToeMatches = pgTable\(\s*\n\s*"tic_tac_toe_matches"/);
  assert.match(schema, /export const ticTacToeMoves = pgTable\(\s*\n\s*"tic_tac_toe_moves"/);
  assert.match(schema, /unique\("tic_tac_toe_moves_ply_unique"\)/);
  assert.match(schema, /unique\("tic_tac_toe_moves_cell_unique"\)/);

  const block = schema.slice(
    schema.indexOf('"tic_tac_toe_matches"'),
    schema.indexOf('"tic_tac_toe_moves"'),
  );
  // No randomness, so nothing to reproduce with a seed.
  assert.equal(/\bseed\b/.test(block), false, "tic-tac-toe must not carry a seed column");
  assert.equal(block.includes("stake"), false);
});

test("engine: the rules module contains no randomness and no I/O", () => {
  const src = strip(read(RULES));
  for (const forbidden of ["Math.random", "crypto", "randomInt", "fs.", "fetch(", "process.env"]) {
    assert.equal(src.includes(forbidden), false, `rules.ts must not use ${forbidden}`);
  }
  assert.match(src, /NO randomness/);
});

// ════════════════════════════════════════════════════════════════════════
// 3. Realtime
// ════════════════════════════════════════════════════════════════════════

test("realtime: the CommonJS server restates the room prefix exactly", () => {
  // server.js cannot import the TypeScript vocabulary, so the literal is
  // duplicated on purpose — and pinned here so the two can never drift.
  assert.equal(TIC_TAC_TOE_MATCH_ROOM_PREFIX, "tic-tac-toe:match:");
  assert.equal(ticTacToeMatchRoom("abc"), "tic-tac-toe:match:abc");

  const src = strip(read(REALTIME));
  assert.match(
    src,
    new RegExp(`const TIC_TAC_TOE_MATCH_ROOM_PREFIX = "${TIC_TAC_TOE_MATCH_ROOM_PREFIX}";`),
  );
  assert.equal(TIC_TAC_TOE_READY, "tic-tac-toe:ready");
  assert.match(src, /socket\.on\("tic-tac-toe:ready"/);
  // The generic event string every game's relay speaks.
  assert.equal(TIC_TAC_TOE_MATCH_UPDATED, "lobby:updated");
  // Disconnect handling routes to the game's own endpoint.
  assert.match(src, /\/api\/tic-tac-toe\/disconnect-forfeit/);
});

test("realtime: the ready poke is participant-gated and carries only an id", () => {
  const src = strip(read(REALTIME));
  const start = src.indexOf('socket.on("tic-tac-toe:ready"');
  assert.ok(start > -1);
  const handler = src.slice(start, start + 1400);
  // Only the match id is accepted from the client.
  assert.match(handler, /\(\{ matchId \} = \{\}\)/);
  assert.equal(/payload/.test(handler), false, "the poke must not accept a payload");
  // A uuid-shaped id only, then a tracked-participant check.
  assert.match(handler, /if \(!\/\^\[0-9a-fA-F-\]\{1,64\}\$\/\.test\(matchIdStr\)\) return;/);
  assert.match(handler, /ticTacToeRoomParticipants\.get\(matchIdStr\)/);
  assert.match(handler, /participants\.has\(socket\.data\.userId\)/);
  // The relayed event is a bare invalidation hint.
  assert.match(handler, /socket\.to\(roomId\)\.emit\("lobby:updated"/);
});

test("realtime: room join/leave and the disconnect grace timer are wired", () => {
  const src = strip(read(REALTIME));
  assert.match(src, /trackTicTacToeJoin\(String\(roomId\), socket\.data\.userId\)/);
  assert.match(src, /trackTicTacToeLeave\(String\(roomId\), socket\.data\.userId\)/);
  assert.match(src, /scheduleDisconnectGraceTimer\(`tic-tac-toe:\$\{mid\}:\$\{socket\.data\.userId\}`/);
  assert.match(src, /global\.__ticTacToeRoomParticipants/);
});

test("rooms: broadcastMatchUpdate no-ops safely without a live io handle", async () => {
  const { broadcastMatchUpdate } = await import("../src/lib/tic-tac-toe/rooms.ts");
  const previous = globalThis.io;
  try {
    delete globalThis.io;
    assert.equal(broadcastMatchUpdate("abc", { status: "playing" }), false);
  } finally {
    if (previous !== undefined) globalThis.io = previous;
  }
});

// ════════════════════════════════════════════════════════════════════════
// 4. The trust boundary
// ════════════════════════════════════════════════════════════════════════

test("move route: forwards ONLY cellIndex and expectedVersion to the store", () => {
  const src = strip(read(MOVE_ROUTE));
  const call = src.slice(src.indexOf("const result = await move({"), src.indexOf("if (\"error\" in result)"));
  assert.ok(call.length > 0);
  assert.match(call, /userId,/);
  assert.match(call, /matchId,/);
  assert.match(call, /cellIndex: body\?\.cellIndex,/);
  assert.match(call, /expectedVersion: body\?\.expectedVersion,/);
  // Nothing else may be threaded through from the request body.
  for (const forbidden of ["winner", "result", "board", "status", "ply", "mark", "elo", "troph", "completed"]) {
    assert.equal(
      new RegExp(`${forbidden}\\s*:\\s*body`).test(call),
      false,
      `the move route must not forward body.${forbidden}`,
    );
  }
});

test("store: the mutators accept no client-supplied decision", () => {
  const src = strip(read(STORE));
  // Each mutator's parameter block must not name a decision field.
  for (const fn of [
    "export async function move({",
    "export async function forfeitMatch({",
    "export async function cancelMatch({",
    "export async function forfeitMatchOnDisconnect({",
    "export async function createOrJoin({",
  ]) {
    const start = src.indexOf(fn);
    assert.ok(start > -1, `${fn} must exist`);
    const block = src.slice(start, src.indexOf("}: {", start) + 4);
    for (const forbidden of ["winner", "result", "board", "elo", "trophy", "status"]) {
      assert.equal(
        new RegExp(`\\b${forbidden}\\b`, "i").test(block),
        false,
        `${fn} must not accept ${forbidden}`,
      );
    }
  }
});

test("store: every mutator locks the match row before reading it", () => {
  const src = strip(read(STORE));
  const fenced = src.match(/\.for\("update"\)/g) ?? [];
  // createOrJoin's candidate, joinExistingMatch, move, forfeitMatch,
  // cancelMatch, forfeitMatchOnDisconnect.
  assert.ok(fenced.length >= 6, `expected >= 6 row locks, found ${fenced.length}`);
  assert.match(src, /pg_advisory_xact_lock\(\$\{TIC_TAC_TOE_LOCK_NAMESPACE\}, 0\)/);
});

test("store: settlement goes through the shared writers ONLY — no local Elo maths", () => {
  const src = strip(read(STORE));
  assert.match(src, /applyRatingResult\(\{/);
  assert.match(src, /applyTrophyResult\(\{/);

  // Imported from the platform, never reimplemented.
  assert.match(src, /import \{ applyRatingResult \} from "\.\.\/rating";/);
  assert.match(src, /import \{ applyTrophyResult \} from "\.\.\/trophyStore";/);

  // Wager-gated counters are deliberately not CALLED (see the settleMatch doc).
  // Asserted as a call rather than an identifier, because the docstring names
  // the helper on purpose to explain why it is skipped.
  assert.equal(/applyLeaderboardCounters\s*\(/.test(src), false);
  // No money may move: no balance/ledger/transaction-table writes at all.
  for (const forbidden of ["balance", "tokenTransactions", "tokensLedger", "tokenBalance"]) {
    assert.equal(src.includes(forbidden), false, `the store must not touch ${forbidden}`);
  }
});

test("store: the game key is a literal at every writer call site", () => {
  // tests/trophy-system.test.mjs audits the SOURCE for `gameKey: "<key>"`, so a
  // shared constant reference would be invisible to that check.
  const src = strip(read(STORE));
  const literals = src.match(/gameKey: "tic-tac-toe"/g) ?? [];
  assert.ok(literals.length >= 8, `expected the literal at each writer, found ${literals.length}`);
  // Every mirror/settle call site uses one.
  const callSites =
    (src.match(/applyRatingResult\(\{/g) ?? []).length +
    (src.match(/applyTrophyResult\(\{/g) ?? []).length +
    (src.match(/mirrorQueue(Created|Transition)\(\{/g) ?? []).length;
  assert.equal(callSites, literals.length);
});

test("store: an isAi match and an unjoined lobby are excluded from settlement", () => {
  const src = strip(read(STORE));
  const settle = src.slice(src.indexOf("async function settleMatch("));
  assert.match(settle, /if \(match\.isAi\) return;/);
  assert.match(settle, /if \(!match\.player2Id\) return;/);
  // A draw is journaled with result "draw" and moves no win counter.
  assert.match(settle, /result: "draw"/);
});

test("constants: an unstaked game declares no wager vocabulary", () => {
  const src = strip(read(CONSTANTS));
  for (const forbidden of ["stake", "wager", "balance", "payout", "token"]) {
    assert.equal(src.toLowerCase().includes(forbidden), false, `constants must not mention ${forbidden}`);
  }
  assert.match(src, /TIC_TAC_TOE_LOCK_NAMESPACE = 0x54494354/);
});

// ════════════════════════════════════════════════════════════════════════
// 5. History surface
// ════════════════════════════════════════════════════════════════════════

test("history: the match-history route reads the table and formats a 0-token record", () => {
  const src = strip(read("src/app/api/get-bet-history/route.ts"));
  assert.match(src, /ticTacToeMatches,/);
  assert.match(src, /ticTacToeRows/);
  assert.match(src, /const ticTacToeFormatted/);
  assert.match(src, /\.\.\.ticTacToeFormatted,/);
  const block = src.slice(src.indexOf("const ticTacToeFormatted"));
  const body = block.slice(0, block.indexOf(".filter(Boolean);"));
  // Unstaked: every entry is a decided record with no movement.
  assert.match(body, /amount: 0,/);
  assert.match(body, /payout: 0,/);
  assert.match(body, /tokenDiff: 0,/);
  assert.match(body, /"Tic-Tac-Toe"/);
  // A draw is a real outcome here, not an edge case.
  assert.match(body, /g\.result === "tie"/);
});

test("routes: the expected HTTP surface exists, and only /move mutates the board", () => {
  const routes = [
    "src/app/api/tic-tac-toe/create-or-join/route.ts",
    "src/app/api/tic-tac-toe/available/route.ts",
    "src/app/api/tic-tac-toe/disconnect-forfeit/route.ts",
    "src/app/api/tic-tac-toe/match/[matchId]/route.ts",
    "src/app/api/tic-tac-toe/match/[matchId]/move/route.ts",
    "src/app/api/tic-tac-toe/match/[matchId]/forfeit/route.ts",
    "src/app/api/tic-tac-toe/match/[matchId]/cancel/route.ts",
  ];
  for (const route of routes) {
    assert.ok(fs.existsSync(path.join(process.cwd(), route)), `${route} must exist`);
  }
  // Every route that changes anything is behind the 18+ / auth gate.
  for (const route of routes) {
    assert.match(strip(read(route)), /requireAgeVerifiedUser|verifyToken/, route);
  }
});
