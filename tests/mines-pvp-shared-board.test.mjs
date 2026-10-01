/**
 * Mines PvP — shared-board preparation contract.
 *
 * The shared-board competitive rules need two things the original schema
 * could not express:
 *   * FLAGS as per-player CLAIMS (not terminal picks) — the
 *     `mines_pvp_matches.p1_flags` / `p2_flags` columns
 *   * a WIN REASON so the client can tell a mine hit from an
 *     all-mines-flagged win — the `win_reason` columns
 *
 * The behaviour that USES them lands in later steps; this file pins the
 * scaffolding (schema + migration + journal + the constants vocabulary)
 * so it cannot silently drift out from under that work.
 *
 * Run:  node --test tests/mines-pvp-shared-board.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, "..", rel), "utf8");

const SCHEMA = read("src/db/schema.ts");
const MIGRATION_PATH = "src/db/migrations/0180_mines_pvp_shared_board_flags.sql";
const JOURNAL = JSON.parse(
  read("src/db/migrations/meta/_journal.json").replace(/^\uFEFF/, ""),
);

// ════════════════════════════════════════════════════════════════════════
// Schema — the mines_pvp_matches / mines_pvp_rounds tables
// ════════════════════════════════════════════════════════════════════════

test("mines_pvp_matches declares per-player flag columns", () => {
  const block = SCHEMA.slice(
    SCHEMA.indexOf('export const minesPvpMatches = pgTable('),
    SCHEMA.indexOf('export const minesPvpRounds = pgTable('),
  );
  assert.match(block, /p1Flags: jsonb\("p1_flags"\)/);
  assert.match(block, /p2Flags: jsonb\("p2_flags"\)/);
  // Flags must be a stable JSONB array default so reads never see null.
  assert.match(block, /p1Flags:[\s\S]*?\.default\(sql`'\[\]'::jsonb`\)/);
  assert.match(block, /p2Flags:[\s\S]*?\.default\(sql`'\[\]'::jsonb`\)/);
});

test("mines_pvp_matches declares a win_reason column", () => {
  const block = SCHEMA.slice(
    SCHEMA.indexOf('export const minesPvpMatches = pgTable('),
    SCHEMA.indexOf('export const minesPvpRounds = pgTable('),
  );
  assert.match(block, /winReason: varchar\("win_reason", \{ length: 32 \}\)/);
});

test("mines_pvp_rounds mirrors win_reason for the replay read path", () => {
  const block = SCHEMA.slice(SCHEMA.indexOf('export const minesPvpRounds = pgTable('));
  assert.match(block, /winReason: varchar\("win_reason", \{ length: 32 \}\)/);
});

// ════════════════════════════════════════════════════════════════════════
// Migration — additive, idempotent, registered in the journal
// ════════════════════════════════════════════════════════════════════════

test("the shared-board migration exists and adds every new column idempotently", () => {
  assert.ok(existsSync(join(here, "..", MIGRATION_PATH)), `${MIGRATION_PATH} missing`);
  const sql = read(MIGRATION_PATH);
  // Additive only — never drop / rewrite existing columns.
  assert.doesNotMatch(sql, /DROP COLUMN/i);
  for (const column of ["p1_flags", "p2_flags", "win_reason"]) {
    assert.match(
      sql,
      new RegExp(`ADD COLUMN IF NOT EXISTS "${column}"`),
      `migration must add ${column} with IF NOT EXISTS`,
    );
  }
  // Both tables are covered.
  assert.match(sql, /ALTER TABLE "mines_pvp_matches"/);
  assert.match(sql, /ALTER TABLE "mines_pvp_rounds"/);
});

test("the shared-board migration is registered in _journal.json", () => {
  const tags = JOURNAL.entries.map((e) => e.tag);
  assert.ok(
    tags.includes("0180_mines_pvp_shared_board_flags"),
    "0180_mines_pvp_shared_board_flags must be in _journal.json",
  );
  // Journal indices must stay unique and ordered (drizzle reads idx).
  const idxs = JOURNAL.entries.map((e) => e.idx);
  assert.equal(new Set(idxs).size, idxs.length, "journal idx values must be unique");
});

// ════════════════════════════════════════════════════════════════════════
// Constants — the vocabulary the later steps consume
// ════════════════════════════════════════════════════════════════════════

test("the constants module exports the win-reason vocabulary and flag helpers", () => {
  const src = read("src/lib/mines-pvp/constants.js");
  assert.match(src, /export const WIN_REASON = Object\.freeze\(/);
  assert.match(src, /export function normalizeFlags\(/);
  assert.match(src, /export function correctFlagCount\(/);
  assert.match(src, /export function hasFlaggedAllMines\(/);
  assert.match(src, /export function flagsForSeat\(/);
});

// ════════════════════════════════════════════════════════════════════════
// Serialization — the persistent state reaches the client
// ════════════════════════════════════════════════════════════════════════

const MATCH_ROUTE = read("src/app/api/mines-pvp/match/[matchId]/route.js");
const MATCH_VIEW = read("src/lib/mines-pvp/matchView.js");
const STORE = read("src/lib/mines-pvp/serverStore.js");
const SERVER_STORE = STORE;
const MATCH_CLIENT = read("src/app/casino/mines-pvp/[matchId]/PageClient.tsx");

test("the match route delegates serialisation to the shared matchView module", () => {
  // One serializer for every read path, so a client can never receive two
  // divergent descriptions of the same row.
  assert.match(MATCH_ROUTE, /import \{ normaliseMatchForViewer \}/);
  assert.match(MATCH_ROUTE, /match: normaliseMatchForViewer\(enrichedMatch, userId\)/);
  // The AI-turn route consumes the SAME serializer (never the raw row).
  const AI_ROUTE = read("src/app/api/mines-pvp/match/[matchId]/ai-turn/route.js");
  assert.match(AI_ROUTE, /normaliseMatchForViewer\(result\.match, userId\)/);
});

test("the viewer serializer exposes the private flag set + public mine counts", () => {
  for (const field of ["myFlags", "myMinesFound", "opponentMinesFound", "winReason", "winnerId"]) {
    assert.match(MATCH_VIEW, new RegExp(`${field}:`), `payload must expose ${field}`);
  }
  // The viewer's OWN flag set is read per seat; the opponent's locations are
  // never serialised — only their confirmed COUNT.
  assert.match(MATCH_VIEW, /myFlags: flagsForSeat\(match, viewerSeat\)/);
  assert.match(MATCH_VIEW, /myMinesFound: minesFoundForSeat\(match, viewerSeat\)/);
  assert.match(MATCH_VIEW, /opponentMinesFound: minesFoundForSeat\(match, opponentSeat\)/);
  // The opponent's flag locations are scrubbed from the pick history.
  assert.match(MATCH_VIEW, /cell:\s*\n?\s*isFlag && !isViewerPick/);
  // Win reason is preserved verbatim (null while the match is active).
  assert.match(MATCH_VIEW, /winReason: match\.winReason \?\? null/);
});

test("the server store canonicalises both flag sets onto the scrubbed row", () => {
  // flagsForSeat() returns a normalised (unique, sorted, in-range) array.
  assert.match(STORE, /p1Flags: flagsForSeat\(match, "player1"\)/);
  assert.match(STORE, /p2Flags: flagsForSeat\(match, "player2"\)/);
});

test("scrubMatchForViewer stamps the board-derived counts before hiding the board", () => {
  // The board is nulled by the scrub, and the viewer serializer runs after
  // it — so the per-seat confirmed-mine counts must be captured from the
  // REAL board here. Skipping this left the side-by-side counter stuck at
  // "10 | 10" even after a correct flag.
  assert.match(STORE, /p1MinesFound: minesFoundForSeat\(match, "player1"\)/);
  assert.match(STORE, /p2MinesFound: minesFoundForSeat\(match, "player2"\)/);
});

test("the scrub helper hides the opponent's flag cell and verdict", () => {
  // Only the claimant (or a settled replay) sees the flag's cell/verdict.
  const scrub = MATCH_VIEW.slice(
    MATCH_VIEW.indexOf("export function scrubPicksForViewer"),
    MATCH_VIEW.indexOf("export function normaliseMatchForViewer"),
  );
  assert.match(scrub, /const reveal = !isFlag \|\| isViewerPick \|\| finished;/);
  assert.match(scrub, /isFlag && !isViewerPick/);
});

test("the client match type declares the private-flag + counter fields", () => {
  assert.match(MATCH_CLIENT, /winReason: string \| null;/);
  assert.match(MATCH_CLIENT, /myFlags: number\[\];/);
  assert.match(MATCH_CLIENT, /myMinesFound: number;/);
  assert.match(MATCH_CLIENT, /opponentMinesFound: number;/);
});

// ════════════════════════════════════════════════════════════════════════
// Backwards compatibility — legacy state stays intact
// ════════════════════════════════════════════════════════════════════════

test("legacy match state is preserved (nothing removed)", () => {
  // The odds-turn history + the legacy scalars + the result/status
  // contract all still ship — the new columns are additive.
  assert.match(MATCH_VIEW, /^\s*picks,$/m, "payload must still expose the picks history");
  for (const field of ["p1Pick", "p2Pick", "result", "status", "winnerId", "currentTurnUserId"]) {
    assert.match(MATCH_VIEW, new RegExp(`${field}:`), `payload must still expose ${field}`);
  }
  // The hidden board/mines stay hidden mid-match and only reveal at finish.
  assert.match(MATCH_VIEW, /board: finished \? match\.board : null/);
  assert.match(STORE, /board: null/);
});

test("create endpoints expose the new state with empty defaults", () => {
  for (const rel of [
    "src/app/api/mines-pvp/create-or-join/route.js",
    "src/app/api/mines-pvp/create-ai/route.js",
  ]) {
    const src = read(rel);
    assert.match(src, /myFlags: \[\]/);
    assert.match(src, /myMinesFound: 0/);
    assert.match(src, /opponentMinesFound: 0/);
    assert.match(src, /winReason: match\.winReason \?\? null/);
  }
});

// ════════════════════════════════════════════════════════════════════════
// Shared-board SERVER RULES — the behaviour that now uses the scaffolding
// ════════════════════════════════════════════════════════════════════════

const FLAG_ROUTE = read("src/app/api/mines-pvp/match/[matchId]/flag/route.js");
const CONSTANTS = read("src/lib/mines-pvp/constants.js");

test("the SHARED CLUE is published to both seats (no per-viewer hint stripping)", () => {
  // The clue is server-computed and belongs to the shared board, so the
  // serializer must NOT gate it on "is this the viewer's own pick".
  assert.match(
    MATCH_VIEW,
    /hint:[\s\S]{0,40}raw\.hint != null \? Number\(raw\.hint\) : null/,
  );
  assert.doesNotMatch(
    MATCH_VIEW,
    /hint:[\s\S]{0,160}finished \|\| isViewerPick/,
    "the shared clue must not be stripped from the opponent",
  );
  // Flag claims are not reveals and must not count as discovered safe cells.
  assert.match(MATCH_VIEW, /!Boolean\(p\.isMine\) && !Boolean\(p\.flag\)/);
  // The hidden board stays hidden while the match is live.
  assert.match(MATCH_VIEW, /board: finished \? match\.board : null/);
});

test("the store resolves winner-shaped and stamps the end reason", () => {
  assert.match(SERVER_STORE, /async function resolveMatch\(tx, match, \{ winnerId, reason \} = \{\}\)/);
  assert.match(SERVER_STORE, /const result = resultForWinner\(\{/);
  // Both player-driven endings are wired.
  assert.match(SERVER_STORE, /reason: WIN_REASON\.MINE_HIT/);
  assert.match(SERVER_STORE, /reason: WIN_REASON\.ALL_MINES_FLAGGED/);
  assert.match(SERVER_STORE, /reason: WIN_REASON\.RESIGN/);
  // `winReason` reaches BOTH the match row and the replay snapshot.
  assert.match(SERVER_STORE, /winReason: reason \?\? null/);
  // A terminal row is never re-settled (one winner only).
  assert.match(SERVER_STORE, /if \(TERMINAL_STATES\.has\(match\.status\)\)/);
});

test("the mine-hit winner is the OPPONENT of the picker", () => {
  assert.match(SERVER_STORE, /winnerId: otherSeatId\(/);
  assert.match(SERVER_STORE, /function otherSeatId\(match, userId\)/);
});

test("flagTile keeps only CORRECT flags and reports the outcome to the caller", () => {
  assert.match(SERVER_STORE, /withFlagForSeat\(match, seat, idx\)/);
  assert.match(SERVER_STORE, /hasFlaggedAllMines\(claimedFlags, match\.board\)/);
  assert.match(
    SERVER_STORE,
    /winnerId: userId,[\s\S]{0,40}?reason: WIN_REASON\.ALL_MINES_FLAGGED/,
  );
  // The verdict is computed server-side and only a CORRECT flag is kept in
  // the seat's own set; a wrong flag still consumes the turn.
  const flagBody = SERVER_STORE.slice(
    SERVER_STORE.indexOf("export async function flagTile"),
    SERVER_STORE.indexOf("async function advanceTurn"),
  );
  assert.match(flagBody, /const flagIsMine = isMine\(match\.board, idx\);/);
  assert.match(flagBody, /flagIsMine \? withFlagForSeat\(match, seat, idx\) : \{\}/);
  assert.match(flagBody, /wrongFlag: !flagIsMine/);
  assert.doesNotMatch(flagBody, /loserId/);
});

test("reveal blocking ignores flag claims, and legacy mirrors skip flags", () => {
  // A flagged (not revealed) cell is still revealable.
  assert.match(SERVER_STORE, /return revealedCells\(match\);/);
  assert.match(SERVER_STORE, /const reveals = allPicks\.filter\(\(p\) => !isFlagEntry\(p\)\);/);
  assert.match(CONSTANTS, /export function revealedCells\(match\)/);
  assert.match(CONSTANTS, /export function isFlagEntry\(entry\)/);
});

test("the flag route reports the caller's own set, the counters and the verdict", () => {
  assert.match(FLAG_ROUTE, /justResolved: Boolean\(result\.justResolved\)/);
  assert.match(FLAG_ROUTE, /myFlags: flagsForSeat\(match, viewerSeat\)/);
  assert.match(FLAG_ROUTE, /opponentMinesFound: minesFoundForSeat\(match, opponentSeat\)/);
  assert.match(FLAG_ROUTE, /winReason: match\.winReason \?\? null/);
  // The response tells the CALLER whether their read was right.
  assert.match(FLAG_ROUTE, /wrongFlag: Boolean\(result\.wrongFlag\)/);
});

// ════════════════════════════════════════════════════════════════════════
// AI — reveal-only bot that obeys the SAME server authority + shared clues
// ════════════════════════════════════════════════════════════════════════

test("AI turn: the bot follows the server turn rules and stamps the SAME public clue", () => {
  // Turn ownership: the bot only acts when the closed-form formula puts it up.
  assert.match(STORE, /expectedPicker === match\.player2Id/);
  // Its reveal is stamped exactly like a human's — hint null on a mine, and
  // the server-computed PUBLIC clue on a safe cell.
  assert.match(
    STORE,
    /hint: pickIsMine\s*\?\s*null\s*:\s*nearestMineDistance\(board, idx\)/,
  );
});

test("AI play is REVEAL-ONLY: the bot never writes a flag claim", () => {
  // "All mines flagged" is a HUMAN claim strategy; the bot has none, so no AI
  // path may touch the flag sets (adding that would be an unrequested feature).
  const aiTurnBody = STORE.slice(
    STORE.indexOf("export async function playAiTurn"),
    STORE.indexOf("// ── Create / Join matchmaking"),
  );
  assert.ok(aiTurnBody.length > 0, "playAiTurn body located");
  assert.doesNotMatch(aiTurnBody, /flagTile|withFlagForSeat|hasFlaggedAllMines/);
  assert.doesNotMatch(aiTurnBody, /p1Flags|p2Flags/);
  // The cell-selection policy returns only a cell index — it has no flag path.
  const chooseBody = CONSTANTS.slice(
    CONSTANTS.indexOf("export function chooseAiCell"),
    CONSTANTS.indexOf("// ── Re-exports"),
  );
  assert.ok(chooseBody.length > 0, "chooseAiCell body located");
  assert.doesNotMatch(chooseBody, /withFlagForSeat|hasFlaggedAllMines|flagTile/);
  assert.match(chooseBody, /return \{\s*cellIndex:/);
});
