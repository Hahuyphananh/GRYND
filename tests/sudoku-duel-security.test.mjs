/**
 * sudoku-duel-security.test.mjs
 *
 * The STATIC invariants of the Sudoku Duel server: the properties that must hold
 * in the source itself, not just in one runtime path.
 *
 * These are deliberately source scans. They pin the trust boundary (a client may
 * only name a cell and a value), the projection (the opponent and the client DTO
 * can never carry the solution), the deployment wiring (the socket room literal
 * and the reserved server events match the realtime server), and the storage
 * invariants (the anti-replay index, the retention sweep, the shared settlement
 * writers with the canonical game key).
 *
 * Run:  npm run test:sudoku-duel
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

const CONSTANTS = "src/lib/sudoku-duel/constants.ts";
const RULES = "src/lib/sudoku-duel/rules.ts";
const STORE = "src/lib/sudoku-duel/serverStore.ts";
const ROOMS = "src/lib/sudoku-duel/rooms.ts";
const REALTIME = "src/lib/sudoku-duel/realtime.ts";
const SEEDS = "src/lib/sudoku-duel/seeds.js";
const MOVE_ROUTE = "src/app/api/sudoku-duel/match/[matchId]/move/route.ts";
const MATCH_ROUTE = "src/app/api/sudoku-duel/match/[matchId]/route.ts";
const CREATE_ROUTE = "src/app/api/sudoku-duel/create-or-join/route.ts";
const DISCONNECT_ROUTE = "src/app/api/sudoku-duel/disconnect-forfeit/route.ts";
const SERVER_JS = "realtime-server/server.js";
const SCHEMA = "src/db/schema.ts";
const MIGRATION = "src/db/migrations/0196_sudoku_duel.sql";
const RETENTION = "src/app/api/jobs/retention/route.ts";

test("constants: the game key, route, lock namespace and modes are declared once", () => {
  const source = read(CONSTANTS);
  assert.match(source, /GAME_KEY = "sudoku-duel"/);
  assert.match(source, /GAME_ROUTE = "\/casino\/sudoku-duel"/);
  assert.match(source, /SUDOKU_DUEL_LOCK_NAMESPACE/);
  assert.match(source, /READY_COUNTDOWN_MS = 3_000/);
  assert.match(source, /MATCH_LIMIT_MS = 600_000/);
  assert.match(source, /MISTAKE_PENALTY_MS = 1_000/);
  assert.match(source, /MATCH_STATUS/);
  assert.match(source, /RESOLUTION/);
});

test("seeds: the match is seeded server-side and committed before play", () => {
  const source = read(SEEDS);
  assert.match(source, /crypto\.randomBytes/);
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /export function derivePuzzleSeed/);
  assert.match(source, /export function getServerSeedHash/);
  assert.match(source, /export function verifyPuzzleSeed/);
  // The puzzle seed is the variant-versioned digest of the server seed.
  assert.match(source, /:variant:\$\{variantVersion\}/);
});

test("rules: judgment is the ONLY place the solution is compared, and it never returns it", () => {
  const source = read(RULES);
  assert.match(source, /export function judgeAction/);
  // The judge reads the solution ONLY for comparison.
  assert.match(source, /const answer = solution\[action\.index\]/);
  assert.match(source, /if \(action\.value !== answer\)/);
  // The completion instant and the achievement instant are passed in, not read
  // from a clock in the engine.
  assert.match(source, /export function resolveSudokuRace/);
  assert.match(source, /export function opponentProgressFor/);
  assert.match(source, /export function adjustedFinishAtMs/);
});

test("projection: OpponentProgress carries counts only, never a board or answer", () => {
  const types = read("src/lib/sudoku-duel/types.ts");
  const start = types.indexOf("export type OpponentProgress = {");
  const end = types.indexOf("};", start);
  const block = types.slice(start, end);
  assert.ok(block.length > 0, "OpponentProgress must exist");
  for (const forbidden of ["grid", "solution", "entries", "puzzle", "moves"]) {
    assert.equal(block.includes(forbidden), false, `OpponentProgress must not carry ${forbidden}`);
  }
  assert.match(block, /correctCells/);
  assert.match(block, /mistakes/);
  assert.match(block, /completed/);
});

test("store: matchToDto never projects the solution to a client", () => {
  const source = read(STORE);
  const start = source.indexOf("export function matchToDto");
  const end = source.indexOf("export function lobbyEntry");
  assert.ok(start > 0 && end > start, "matchToDto must exist and precede lobbyEntry");
  const dto = source.slice(start, end);
  // The projected object has no `solution` property at all (the server-side
  // reads of `puzzle.solution` feed the progress/opponent derivations, never the
  // returned literal).
  assert.equal(/\bsolution\s*:/.test(dto), false, "the DTO must not expose a solution field");
  assert.equal(dto.includes("match.solution"), false, "the DTO must not carry the stored solution");
  assert.match(dto, /serverSeed: terminal \? match\.serverSeed : null/);
  assert.match(
    dto,
    /puzzleSeed: terminal \? Number\(match\.puzzleSeed\) >>> 0 : null/,
    "the puzzle seed must be withheld until terminal",
  );
  assert.match(dto, /view:/);
  assert.match(dto, /opponent:/);
});

test("store: the action payload can never carry a result, and only the judge reads the answer", () => {
  const source = read(STORE);
  for (const forbidden of [
    "action.solution",
    "action.grid",
    "action.completed",
    "action.correctCells",
    "action.winner",
    "action.progress",
    "action.mistakes",
    "action.penaltyMs",
    "action.score",
    "action.elo",
  ]) {
    assert.equal(source.includes(forbidden), false, `the store must never read ${forbidden}`);
  }
});

test("store: settlement reuses the shared writers with the canonical game key", () => {
  const source = read(STORE);
  assert.match(source, /applyRatingResult/);
  assert.match(source, /applyTrophyResult/);
  assert.match(source, /gameKey: "sudoku-duel"/);
  assert.match(source, /mirrorQueueCreated/);
  assert.match(source, /mirrorQueueTransition/);
  // No hand-rolled rating maths or money path anywhere in the store.
  assert.equal(source.includes("eloDelta"), false);
  assert.equal(source.includes("stakeAmount"), false);
  assert.equal(source.includes("prizePaid"), false);
});

test("store: matchmaking takes one per-game advisory lock and never regenerates on join", () => {
  const source = read(STORE);
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /SUDOKU_DUEL_LOCK_NAMESPACE/);
  assert.match(source, /for\("update"\)/);
  // The puzzle is minted exactly once, in `createWaitingMatch`.
  assert.match(source, /generatePuzzle\(/);
  assert.match(source, /derivePuzzleSeed\(/);
  // Joining starts the clock and claims the seat — nothing else.
  assert.match(source, /goAt: new Date\(goAtMs\)/);
});

test("move route: it forwards the action and the cursor, and nothing else", () => {
  const source = read(MOVE_ROUTE);
  assert.match(source, /action: body\?\.action/);
  assert.match(source, /expectedPly: body\?\.expectedPly/);
  for (const forbidden of [
    "body.solution",
    "body.grid",
    "body.completed",
    "body.winner",
    "body.correctCells",
    "body.mistakes",
    "body.progress",
    "body.score",
    "body.result",
  ]) {
    assert.equal(source.includes(forbidden), false, `the route must never read ${forbidden}`);
  }
  // A signature poke so the opponent refreshes, and a backend projection.
  assert.match(source, /broadcastOpponentProgress/);
  assert.match(source, /broadcastMatchFinish/);
});

test("match route: the snapshot is authoritative and refuses a non-participant", () => {
  const source = read(MATCH_ROUTE);
  assert.match(source, /fetchMatch/);
  assert.match(source, /isMatchId/);
  assert.equal(/\bsolution\s*:/.test(source), false, "the read route must not expose a solution field");
  assert.equal(source.includes("match.solution"), false, "the read route must not touch the stored solution");
  assert.match(source, /force-dynamic/);
});

test("create route: it starts the synchronized countdown from server instants", () => {
  const source = read(CREATE_ROUTE);
  assert.match(source, /createOrJoin/);
  assert.match(source, /SUDOKU_DUEL_EVENTS\.COUNTDOWN/);
  assert.match(source, /goAtMs/);
  assert.match(source, /deadlineAtMs/);
});

test("disconnect route: it re-verifies the token before resolving anything", () => {
  const source = read(DISCONNECT_ROUTE);
  assert.match(source, /verifyToken/);
  assert.match(source, /forfeitMatchOnDisconnect/);
  assert.match(source, /isMatchId/);
});

test("rooms: one room per match, with the reserved server-only events", () => {
  const source = read(ROOMS);
  assert.match(source, /SUDOKU_DUEL_MATCH_ROOM_PREFIX = "sudoku-duel:match:"/);
  assert.match(source, /MATCH_UPDATED: "lobby:updated"/);
  assert.match(source, /READY: "sudoku-duel:ready"/);
  assert.match(source, /COUNTDOWN: "sudoku-duel:countdown"/);
  assert.match(source, /MATCH_STARTED: "sudoku-duel:match-started"/);
  assert.match(source, /OPPONENT_PROGRESS: "sudoku-duel:opponent-progress"/);
  assert.match(source, /MATCH_FINISHED: "sudoku-duel:match-finished"/);
  // The client-safe room module must import nothing.
  assert.equal(/^\s*import /m.test(source), false, "rooms.ts must not import anything");
});

test("realtime: the server-side projections are derived, never client-authored", () => {
  const source = read(REALTIME);
  assert.match(source, /export function broadcastOpponentProgress/);
  assert.match(source, /export function broadcastMatchFinished/);
  assert.match(source, /opponentProgressFor/);
  assert.match(source, /PROGRESS_BROADCAST_MIN_MS/);
});

test("realtime server: the room literal and the reserved events are pinned", () => {
  const source = read(SERVER_JS);
  assert.match(source, /SUDOKU_DUEL_MATCH_ROOM_PREFIX = "sudoku-duel:match:"/);
  // The forged-event filter reserves every server-only event name.
  for (const event of [
    "sudoku-duel:opponent-progress",
    "sudoku-duel:countdown",
    "sudoku-duel:match-started",
    "sudoku-duel:match-finished",
  ]) {
    assert.match(source, new RegExp(`"${event}"`), `${event} must be reserved`);
  }
  // A ready poke from a non-participant is rejected, and the disconnect path
  // reuses the shared grace-timer helper.
  assert.match(source, /trackSudokuDuelJoin/);
  assert.match(source, /trackSudokuDuelLeave/);
  assert.match(source, /sudoku-duel:ready/);
  assert.match(source, /scheduleDisconnectGraceTimer\(`sudoku-duel:/);
});

test("storage: the schema mirrors the migration and the anti-replay index", () => {
  const schema = read(SCHEMA);
  assert.match(schema, /"sudoku_duel_matches"/);
  assert.match(schema, /"sudoku_duel_moves"/);
  assert.match(
    schema,
    /unique\("sudoku_duel_moves_ply_unique"\)\.on\(table\.matchId, table\.seat, table\.ply\)/,
  );
  assert.match(schema, /dueIdx: index\("sudoku_duel_matches_due_idx"\)\.on\(table\.status, table\.deadlineAt\)/);
  // The solution column exists (server-only) and is NOT NULL.
  assert.match(schema, /solution: jsonb\("solution"\)\.notNull\(\)/);

  const migration = read(MIGRATION);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS sudoku_duel_matches/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS sudoku_duel_moves/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS sudoku_duel_moves_ply_unique/);
  assert.match(migration, /solution JSONB NOT NULL/);
});

test("retention: the sweep knows the new table", () => {
  const source = read(RETENTION);
  assert.match(source, /await purge\("sudoku_duel_matches", FINISHED\)/);
});

// ── Audit additions: the client trust boundary and the single-mint puzzle ──
//
// The suite above pins the SERVER. These pin the two properties a server-side
// scan cannot see: (1) the browser bundle never reaches a server-only module and
// the race view never sends anything but `{ action, expectedPly }`, and (2) there
// is exactly ONE place a puzzle is ever minted, so a reconnect/join cannot
// produce a different board.

const MATCH_PAGE = "src/app/casino/sudoku-duel/[matchId]/PageClient.tsx";
const LOBBY_PAGE = "src/app/casino/sudoku-duel/PageClient.tsx";

/** The substring between two markers, or "" when either is absent. */
function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) return "";
  const end = source.indexOf(endMarker, start);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

test("client: the race view never imports a server-only module", () => {
  const source = read(MATCH_PAGE);
  // serverStore holds the puzzle + solution, seeds.js imports node:crypto, and
  // generator.ts can rebuild the solution from the puzzle seed — none may reach
  // a browser bundle.
  for (const serverOnly of ["serverStore", "seeds", "generator", "realtime"]) {
    assert.equal(
      new RegExp(`from "[^"]*/sudoku-duel/${serverOnly}`).test(source),
      false,
      `the race view must not import ${serverOnly}`,
    );
  }
  // The only client-side sudoku imports are the vocabulary/formatting modules.
  for (const line of source.matchAll(/from "[^"]*lib\/sudoku-duel\/([a-zA-Z]+)/g)) {
    assert.ok(
      ["constants", "types", "rules", "rooms", "ui"].includes(line[1]),
      `unexpected client import of sudoku-duel/${line[1]}`,
    );
  }
});

test("client: the race view sends only an action and its own ply cursor", () => {
  const source = read(MATCH_PAGE);
  // The ONE request body the page ever composes for /move.
  assert.match(source, /body: JSON.stringify\(\{ action, expectedPly \}\)/);
  // No POST body may carry a board, a result, a winner, a completion or a clock.
  for (const forbidden of [
    "winner:",
    "solution:",
    "completedAtMs:",
    "progress:",
    "mistakes:",
    "penaltyMs:",
    "nowMs:",
  ]) {
    assert.equal(
      new RegExp(`JSON\\.stringify\\(\\{[^}]*${forbidden}`).test(source),
      false,
      `the race view must never POST ${forbidden}`,
    );
  }
});

test("client: matchmaking carries no payload, so difficulty cannot be chosen", () => {
  const source = read(LOBBY_PAGE);
  assert.match(source, /fetch\("\/api\/sudoku-duel\/create-or-join"/);
  // A bodyless POST — the server's own DEFAULT_DIFFICULTY decides the puzzle.
  assert.equal(
    source.includes("JSON.stringify"),
    false,
    "the lobby must not send a body",
  );
  // The fetch options block itself carries no body (the `body:` keys below it
  // belong to the static rules modal, not to a request).
  const post = sliceBetween(source, '"/api/sudoku-duel/create-or-join"', "});");
  assert.ok(post.length > 0, "the create-or-join call must exist");
  assert.equal(post.includes("body:"), false, "the lobby must not send a body");
  assert.match(post, /method: "POST"/);
});

test("store: a non-participant is refused before the deadline can be resolved", () => {
  const source = read(STORE);
  const fetchMatch = sliceBetween(source, "export async function fetchMatch", "export async function fetchSeatMoves");
  const refuseAt = fetchMatch.indexOf('Not a participant of this match');
  const resolveAt = fetchMatch.indexOf("isDeadlineDue");
  assert.ok(refuseAt > 0, "fetchMatch must refuse a non-participant");
  assert.ok(resolveAt > 0, "fetchMatch must resolve a due match on read");
  assert.ok(refuseAt < resolveAt, "the 403 must precede the deadline resolution");
});

test("store: the puzzle is minted exactly once, and a join never regenerates it", () => {
  const source = read(STORE);
  // One call site for the generator — inside createWaitingMatch.
  assert.equal(
    (source.match(/generatePuzzle\(/g) || []).length,
    1,
    "the puzzle must be minted in exactly one place",
  );
  const join = sliceBetween(source, "async function joinExistingMatch", "export async function fetchMatch");
  for (const forbidden of ["generatePuzzle", "derivePuzzleSeed", "randomHex", "puzzle:", "solution:", "puzzleSeed:"]) {
    assert.equal(join.includes(forbidden), false, `joinExistingMatch must not touch ${forbidden}`);
  }
  // The clock it writes is the ONLY thing a join decides.
  assert.match(join, /goAt: new Date\(goAtMs\)/);
});

test("store: timing is the server's, on every mutation entry point", () => {
  const source = read(STORE);
  const submit = sliceBetween(source, "export async function submitMove", "export async function resolveDueMatch");
  // Acting before GO and acting past the limit are both refused server-side.
  assert.match(submit, /nowMs < goAtMs/);
  assert.match(submit, /isDeadlineDue\(match, nowMs\)/);
  // `nowMs` is a parameter with a server default, never read from a request.
  assert.match(submit, /nowMs = Date.now\(\)/);
  for (const forbidden of ["action.now", "action.nowMs", "action.timestamp", "action.completedAtMs", "action.winner", "action.result"]) {
    assert.equal(source.includes(forbidden), false, `the store must never read ${forbidden}`);
  }
});

test("client: the lobby lists open lobbies from its own route and the shared lobby room", () => {
  const source = read(LOBBY_PAGE);
  // The Open Lobbies card must be fed by the authoritative /available route —
  // never a hard-coded empty list — and refreshed over the shared lobby room.
  assert.match(source, /fetch\("\/api\/sudoku-duel\/available"/);
  assert.match(source, /SUDOKU_DUEL_LOBBY_ROOM/);
  assert.match(source, /join_room/);
  assert.match(source, /lobbies=\{lobbies\}/);
  assert.equal(source.includes("lobbies={[]}"), false, "the lobby list must not be hard-coded empty");
  // The list row shape stays narrow: no host id is consumed anywhere but the
  // explanatory comment, so the route's no-player-id decision is preserved.
  assert.equal(
    /row\.player1Id|\bl\.player1Id\b|\.player1Id &&/.test(source),
    false,
    "the lobby never depends on another player's id",
  );
});

test("store: finalisation settles exactly once, and disconnect is a no-op once terminal", () => {
  const source = read(STORE);
  const finalize = sliceBetween(source, "async function finalizeMatch", "async function settleSudokuDuelMatch");
  // The terminal guard is the first thing finalisation does.
  assert.match(finalize, /if \(TERMINAL_STATUSES.includes\(match\.status\)\) return match;/);
  // The shared writers are reached from this one seam only.
  assert.match(finalize, /settleSudokuDuelMatch\(tx, finalRow, outcome\)/);

  const disconnect = sliceBetween(source, "export async function forfeitMatchOnDisconnect", "async function finalizeMatch");
  assert.match(disconnect, /if \(TERMINAL_STATUSES.includes\(match\.status\)\) \{/);
  assert.match(disconnect, /forfeited: false, cancelled: false/);
});
