/**
 * Mines Duel — API layer + server-authority contract.
 *
 * The pure rules live in `tests/mines-pvp-engine.test.mjs` and the mirrored
 * state machine in `tests/mines-pvp-flow.test.mjs`. This file pins the
 * SECURITY-critical parts of the real source:
 *   • the routes accept ONLY a cellIndex — never a score / points / winner /
 *     mine value / mine position / completion / timer;
 *   • the store mints every score change and every mine value server-side;
 *   • there is no client-trusted winner, and no turn formula any more;
 *   • the reader serialises per-viewer state so hidden boards/values never
 *     leave the server while the match is live;
 *   • settlement wiring is preserved.
 *
 * Run:  node --import tsx --test tests/mines-pvp-api-contract.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const PICK_ROUTE = read("src/app/api/mines-pvp/match/[matchId]/pick/route.js");
const FLAG_ROUTE = read("src/app/api/mines-pvp/match/[matchId]/flag/route.js");
const UNFLAG_ROUTE = read("src/app/api/mines-pvp/match/[matchId]/unflag/route.js");
const MATCH_ROUTE = read("src/app/api/mines-pvp/match/[matchId]/route.js");
const FORFEIT_ROUTE = read("src/app/api/mines-pvp/disconnect-forfeit/route.js");
const AI_ROUTE = read("src/app/api/mines-pvp/match/[matchId]/ai-turn/route.js");
const STORE = read("src/lib/mines-pvp/serverStore.js");
const MATCH_VIEW = read("src/lib/mines-pvp/matchView.js");
const SCHEMA = read("src/db/schema.ts");

// ── Routes accept only a cellIndex ────────────────────────────────────

test("the pick route accepts ONLY { cellIndex }", () => {
  assert.match(PICK_ROUTE, /const cellIndex = Number\(body\?\.cellIndex\)/);
  for (const forbidden of [
    /body\?\.score/,
    /body\?\.points/,
    /body\?\.winner/,
    /body\?\.mineValue/,
    /body\?\.cellValues/,
    /body\?\.completed/,
    /body\?\.elapsed/,
  ]) {
    assert.doesNotMatch(PICK_ROUTE, forbidden, `pick route must not read ${forbidden}`);
  }
});

test("the flag route accepts ONLY { cellIndex }", () => {
  assert.match(FLAG_ROUTE, /const cellIndex = Number\(body\?\.cellIndex\)/);
  for (const forbidden of [
    /body\?\.score/,
    /body\?\.points/,
    /body\?\.winner/,
    /body\?\.mineValue/,
    /body\?\.completed/,
  ]) {
    assert.doesNotMatch(FLAG_ROUTE, forbidden, `flag route must not read ${forbidden}`);
  }
});

test("the unflag route accepts ONLY { cellIndex } and forwards to the store", () => {
  assert.match(UNFLAG_ROUTE, /const cellIndex = Number\(body\?\.cellIndex\)/);
  assert.match(UNFLAG_ROUTE, /unflagTile\(\{ userId, matchId, cellIndex \}\)/);
  assert.match(UNFLAG_ROUTE, /broadcastMatchUpdate\(/);
  for (const forbidden of [
    /body\?\.score/,
    /body\?\.points/,
    /body\?\.winner/,
    /body\?\.mineValue/,
    /body\?\.board/,
  ]) {
    assert.doesNotMatch(UNFLAG_ROUTE, forbidden, `unflag route must not read ${forbidden}`);
  }
});

test("the disconnect-forfeit route verifies the token and never trusts game data", () => {
  assert.match(FORFEIT_ROUTE, /verifyToken\(token, \{ secretKey: CLERK_SECRET_KEY \}\)/);
  assert.match(FORFEIT_ROUTE, /forfeitMatchOnDisconnect\(\{/);
  assert.match(FORFEIT_ROUTE, /loserClerkId: clerkUserId/);
  assert.match(FORFEIT_ROUTE, /broadcastMatchUpdate\(/);
  assert.doesNotMatch(FORFEIT_ROUTE, /body\?\.(score|board|winner|points)/);
});

test("the unflag store path cannot farm a confirmed mine and does not refund the penalty", () => {
  assert.match(STORE, /export async function unflagTile\(/);
  assert.match(STORE, /Cannot unflag a confirmed mine/);
  assert.match(STORE, /Cell is not flagged/);
  // No score change on an unflag (the −10 stays).
  assert.match(STORE, /unflagged: true,[\s\S]{0,80}scoreDelta: 0/);
});

test("the match GET takes no body and serialises through the shared viewer", () => {
  assert.doesNotMatch(MATCH_ROUTE, /req\.json\(\)/);
  assert.match(MATCH_ROUTE, /normaliseMatchForViewer\(/);
  assert.match(MATCH_ROUTE, /fetchMatchWithAutoResolve\(/);
});

// ── The store is the sole authority ───────────────────────────────────

test("every score change is minted server-side", () => {
  assert.match(STORE, /applyScoreDelta\(/);
  assert.match(STORE, /SCORE\.MINE_HIT/);
  assert.match(STORE, /SCORE\.SAFE_TILE/);
  assert.match(STORE, /SCORE\.WRONG_FLAG/);
  assert.match(STORE, /SCORE\.BOARD_COMPLETE/);
});

test("mine VALUES are read from the server board, never from a request", () => {
  assert.match(STORE, /mineValueAt\(board, cellIndex\)/);
  assert.doesNotMatch(STORE, /body\.mineValue/);
  assert.doesNotMatch(STORE, /cellValues/);
});

test("the winner is derived server-side from the tiebreak ladder", () => {
  assert.match(STORE, /resolveScoredMatch\(match\)/);
  assert.match(STORE, /import \{[\s\S]*resolveScoredMatch[\s\S]*\} from "\.\/constants"/);
  // No client-supplied winner anywhere in the settle path.
  assert.doesNotMatch(STORE, /winnerId\s*=\s*.*body/);
});

test("the old alternating-turn machinery is gone", () => {
  assert.doesNotMatch(STORE, /activePickerForMatch|seatForPickNumber|activeSeatForMatch/);
  assert.doesNotMatch(STORE, /ROUND_PICK_DEADLINE_MS/);
  assert.match(STORE, /MATCH_STATUS\.ACTIVE/);
  assert.match(STORE, /isMatchExpired\(/);
});

test("the single match timer is server-authoritative", () => {
  assert.match(STORE, /matchDeadline: deadline/);
  assert.match(STORE, /matchTimerSeconds/);
  assert.doesNotMatch(STORE, /body\.(elapsed|timeLeft|remainingMs)/);
});

test("actions after lock / completion / terminal state are rejected", () => {
  assert.match(STORE, /if \(isSeatLocked\(match, seat\)\)/);
  assert.match(STORE, /if \(!PICKABLE_STATES\.has\(match\.status\)\)/);
  assert.match(STORE, /Match timer has expired/);
});

test("the acting seat is derived from the authenticated user, never the body", () => {
  assert.match(STORE, /const seat = seatForUser\(match, userId\)/);
  assert.doesNotMatch(STORE, /body\.seat/);
});

// ── Per-viewer visibility ─────────────────────────────────────────────

test("the reader hides the boards until the match is finished", () => {
  assert.match(MATCH_VIEW, /board: finished \? viewerBoard : null/);
  assert.match(MATCH_VIEW, /opponentBoard: finished \? opponentBoard : null/);
  assert.match(MATCH_VIEW, /boards: finished/);
});

test("the reader exposes the opponent only as public progress", () => {
  assert.match(MATCH_VIEW, /opponentScore:/);
  assert.match(MATCH_VIEW, /opponentSafeRevealed:/);
  assert.match(MATCH_VIEW, /opponentMinesHit:/);
  assert.match(MATCH_VIEW, /opponentCompleted:/);
  // No opponent board field on the active payload.
  assert.doesNotMatch(MATCH_VIEW, /opponentBoard: finished \? opponentBoard : null,[\s\S]*opponentBoard(?!:)/);
});

test("the reader exposes both boards ONLY on the finished branch", () => {
  // The `boards` object is gated on `finished`; there is no other place that
  // emits a raw board object onto the payload.
  assert.match(MATCH_VIEW, /boards: finished\s*\n?\s*\? \{ p1: match\.p1Board \?\? null, p2: match\.p2Board \?\? null \}/);
});

// ── Schema + migration ────────────────────────────────────────────────

test("the schema declares the per-seat boards, scores, completion and timer", () => {
  const mine = SCHEMA.slice(
    SCHEMA.indexOf("export const minesPvpMatches = pgTable("),
    SCHEMA.indexOf("export const minesPvpRounds = pgTable("),
  );
  for (const token of [
    "p1Board",
    "p2Board",
    "p1Revealed",
    "p2Revealed",
    "p1CorrectFlags",
    "p2CorrectFlags",
    "p1Score",
    "p2Score",
    "p1Completed",
    "p2Completed",
    "p1Locked",
    "p2Locked",
    "matchDeadline",
    "matchTimerSeconds",
  ]) {
    assert.ok(mine.includes(token), `schema must declare ${token}`);
  }
  assert.match(SCHEMA, /"active"/, "the status enum must include the active state");
});

test("the finished-match API exposes each seat's replay final state", () => {
  assert.match(MATCH_ROUTE, /p1FinalState: r\.p1FinalState \?\? null/);
  assert.match(MATCH_ROUTE, /p2FinalState: r\.p2FinalState \?\? null/);
  assert.match(MATCH_ROUTE, /p2BoardSnapshot: r\.p2BoardSnapshot \?\? null/);
});

test("the rounds schema declares the replay final-state columns", () => {
  const rounds = SCHEMA.slice(
    SCHEMA.indexOf("export const minesPvpRounds = pgTable("),
  );
  assert.match(rounds, /p1FinalState: jsonb\("p1_final_state"\)/);
  assert.match(rounds, /p2FinalState: jsonb\("p2_final_state"\)/);
});

test("the store guards board completion so +100 can never apply twice", () => {
  assert.match(
    STORE,
    /const already = Boolean\(seat === "player2" \? match\.p2Completed : match\.p1Completed\)/,
  );
  assert.match(STORE, /applyScoreDelta\(score, SCORE\.BOARD_COMPLETE\)/);
  // Once complete, the seat is locked and every further action is refused.
  assert.match(STORE, /isSeatLocked\(match, seat\)/);
  assert.match(STORE, /Your board is already locked/);
});

// ── Realtime broadcast + settlement ───────────────────────────────────

test("every mutation route broadcasts the existing match-updated event", () => {
  for (const src of [PICK_ROUTE, FLAG_ROUTE, UNFLAG_ROUTE, AI_ROUTE, MATCH_ROUTE]) {
    assert.match(src, /broadcastMatchUpdate\(/);
  }
});

test("every score-changing route also emits the server-only score hint", () => {
  for (const src of [PICK_ROUTE, FLAG_ROUTE]) {
    assert.match(src, /broadcastScoreEvent\(/);
    assert.match(src, /reason: result\.scoreReason/);
    assert.match(src, /seat: result\.seat/);
  }
});

test("no route enforces a turn or a per-turn deadline", () => {
  for (const src of [PICK_ROUTE, FLAG_ROUTE, UNFLAG_ROUTE, MATCH_ROUTE, AI_ROUTE]) {
    assert.doesNotMatch(src, /activePickerForMatch|seatForPickNumber/);
    assert.doesNotMatch(src, /ROUND_PICK_DEADLINE_MS/);
    // No route compares the caller against a turn holder to gate the action.
    assert.doesNotMatch(src, /currentTurnUserId\s*!==/);
  }
});

test("Lane-style settlement wiring is preserved", () => {
  assert.match(STORE, /import \{[\s\S]*applyRatingResult[\s\S]*\} from "\.\.\/rating"/);
  assert.match(STORE, /gameKey: "mines-pvp"/);
  assert.match(STORE, /applyTrophyResult\(/);
  assert.match(STORE, /applyLeaderboardCounters\(/);
  assert.match(STORE, /!isAi[\s\S]*recordPvPResult\(tx/);
});
