// tests/battleship-timeouts.test.mjs
//
// PHASE 5 — server-authoritative timers, timeout attacks, repeated timeouts,
// disconnect recovery and durable scheduling.
//
// The policy is tested as pure code (random selection, counters, placement
// verdicts) and the mechanism as source contracts, because a real scheduler and
// a real Postgres are not available in this environment:
//
//   * the automatic cell is chosen by `crypto.randomInt` over the UNTRIED cells,
//     never by the client and never by Math.random;
//   * a manual attack resets the consecutive counter; two automatic attacks in a
//     row forfeit; both seats at the threshold is a draw;
//   * a missed placement clock forfeits to the seat present, and two missing
//     fleets CANCEL the match (no invented fleet, no invented winner);
//   * recovery is deadline-driven and idempotent: the job sweep and the lazy
//     read path call the same `resolveDueTimeouts`, which locks the row and
//     re-checks the deadline inside it;
//   * a disconnect is settlement-only — the round, both fleets and the resolved
//     attack log are never rewritten.
//
// Run:  node --import tsx --test tests/battleship-timeouts.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DISCONNECT_GRACE_SECONDS,
  TIMEOUT_FORFEIT_THRESHOLD,
  allCoordinates,
  bothTimedOutResult,
  nextConsecutiveTimeouts,
  pickTimeoutCoordinate,
  placementTimeoutVerdict,
  timeoutForfeitSeats,
  untriedCoordinates,
} from "../src/lib/battleship/timeouts.ts";

const read = (relative) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const STORE = read("src/lib/battleship/serverStore.ts");
const TIMEOUTS = read("src/lib/battleship/timeouts.ts");
const JOB = read("src/app/api/jobs/battleship-timeouts/route.ts");
const DISCONNECT = read("src/app/api/battleship/disconnect-forfeit/route.ts");
const SERVER = read("realtime-server/server.js");
const PAGE = read("src/app/casino/battleship/PageClient.tsx");
const BATTLE = read("src/components/games/battleship/BattlePreview.tsx");
const JOURNAL = JSON.parse(read("src/db/migrations/meta/_journal.json"));
const MIGRATION = read("src/db/migrations/0237_battleship_timeouts.sql");
const RUN_JOB = read("deploy/jobs/run-job.sh");
const VERCEL = JSON.parse(read("vercel.json"));

// ── Automatic coordinate selection ────────────────────────────────────────

test("the board has 140 addresses and untried cells exclude every fired shot", () => {
  assert.equal(allCoordinates().length, 140);
  assert.equal(allCoordinates()[0], "A1");
  assert.equal(allCoordinates()[139], "N10");

  const attacked = ["A1", "b2", "J10"];
  const untried = untriedCoordinates(attacked);
  assert.equal(untried.length, 137);
  for (const cell of ["A1", "B2", "J10"]) assert.equal(untried.includes(cell), false);
  assert.equal(untried.includes("C3"), true);
});

test("an automatic attack is ALWAYS a legal, untried coordinate", () => {
  const attacked = ["A1", "B2", "C3", "D4"];
  const first = pickTimeoutCoordinate(attacked, () => 0);
  const last = pickTimeoutCoordinate(attacked, (max) => max - 1);
  const untried = untriedCoordinates(attacked);
  assert.equal(first, untried[0], "index 0 of the untried list");
  assert.equal(last, untried[untried.length - 1], "last index of the untried list");
  assert.equal(attacked.includes(first), false);
  assert.equal(attacked.includes(last), false);

  // A deterministic pseudo-random walk over many draws never repeats an attacked
  // cell and never leaves the board.
  let seed = 42;
  const random = (max) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % max;
  };
  for (let draw = 0; draw < 200; draw += 1) {
    const cell = pickTimeoutCoordinate(attacked, random);
    assert.equal(typeof cell, "string");
    assert.equal(attacked.includes(cell), false);
    assert.equal(allCoordinates().includes(cell), true);
  }
});

test("an exhausted board yields no automatic attack instead of a repeat", () => {
  assert.equal(pickTimeoutCoordinate(allCoordinates(), () => 0), null);
  assert.equal(untriedCoordinates(allCoordinates()).length, 0);
});

test("production randomness is crypto (server-side), not Math.random", () => {
  assert.match(TIMEOUTS, /import \{ randomInt \} from "node:crypto"/);
  assert.match(TIMEOUTS, /export const serverRandomInt: RandomInt = \(maxExclusive\) => randomInt\(0, maxExclusive\)/);
  assert.doesNotMatch(stripComments(TIMEOUTS), /Math\.random/);
  assert.doesNotMatch(stripComments(PAGE), /Math\.random/, "the browser never picks a cell");
  assert.doesNotMatch(stripComments(BATTLE), /Math\.random/);
});

// ── Consecutive timeouts ──────────────────────────────────────────────────

test("the forfeit threshold is two consecutive timeouts", () => {
  assert.equal(TIMEOUT_FORFEIT_THRESHOLD, 2);
  assert.equal(nextConsecutiveTimeouts(0, true), 1);
  assert.equal(nextConsecutiveTimeouts(1, true), 2);
  assert.equal(nextConsecutiveTimeouts(2, true), 3);
});

test("a manual attack resets the consecutive counter", () => {
  assert.equal(nextConsecutiveTimeouts(1, false), 0);
  assert.equal(nextConsecutiveTimeouts(5, false), 0);
});

test("the threshold forfeits the seat that reached it", () => {
  assert.deepEqual(timeoutForfeitSeats({ player1: 0, player2: 0 }), []);
  assert.deepEqual(timeoutForfeitSeats({ player1: 1, player2: 1 }), []);
  assert.deepEqual(timeoutForfeitSeats({ player1: 2, player2: 0 }), ["player1"]);
  assert.deepEqual(timeoutForfeitSeats({ player1: 0, player2: 2 }), ["player2"]);
  assert.deepEqual(timeoutForfeitSeats({ player1: 2, player2: 2 }), ["player1", "player2"]);
});

test("both seats timing out resolves deterministically — a draw, not a winner", () => {
  assert.equal(bothTimedOutResult(), "draw");
  assert.match(STORE, /if \(forfeiting\.length === 2\) \{/);
  assert.match(STORE, /await drawMatchTx\(tx, row, "timeout_forfeit", now\)/);
});

// ── Placement timeout policy ──────────────────────────────────────────────

test("a missed placement clock forfeits only the missing seat", () => {
  assert.deepEqual(placementTimeoutVerdict({ player1: true, player2: true }), { action: "none" });
  assert.deepEqual(placementTimeoutVerdict({ player1: false, player2: true }), {
    action: "forfeit",
    seat: "player1",
  });
  assert.deepEqual(placementTimeoutVerdict({ player1: true, player2: false }), {
    action: "forfeit",
    seat: "player2",
  });
});

test("both fleets missing CANCELS the match — no fleet is ever invented", () => {
  assert.deepEqual(placementTimeoutVerdict({ player1: false, player2: false }), {
    action: "cancel",
  });
  assert.match(STORE, /await cancelLobbyTx\(tx, row, "timeout", now\)/);
  // Practice mode deals the BOT's fleet; the timeout paths may never deal one
  // for either seat (inventing a fleet for an absent player is forbidden).
  const timeoutPaths = STORE.slice(0, STORE.indexOf("export async function createAiMatch"));
  assert.doesNotMatch(
    timeoutPaths,
    // Calls only: the module IMPORTS the practice dealer, which is fine.
    /generateRandomFleet\(|autoPlace\(|Math\.random\(/,
    "the timeout paths never deal a fleet for a player",
  );
  const practice = STORE.slice(STORE.indexOf("export async function createAiMatch"));
  assert.match(practice, /generateRandomFleet\(random\)/, "only the bot's fleet is dealt");
  assert.match(practice, /seat: "player2"/);
});

// ── Server mechanisms ─────────────────────────────────────────────────────

test("the sweeper is deadline-driven, row-locked and restart-safe", () => {
  assert.match(STORE, /export async function sweepBattleshipTimeouts/);
  assert.match(STORE, /where\(\s*\n\s*and\(\s*\n\s*inArray\(battleshipMatches\.phase, \[MATCH_PHASE\.PLACEMENT, MATCH_PHASE\.COMBAT\]\)/);
  assert.match(STORE, /isNotNull\(battleshipMatches\.placementDeadline\)/);
  assert.match(STORE, /lte\(battleshipMatches\.roundDeadline, now\)/);
  // The deadline is RE-CHECKED inside the lock, so a sweep and a live request
  // cannot both apply the same timeout.
  assert.match(STORE, /if \(!row\.roundDeadline \|\| row\.roundDeadline > now\) return \{ events \}/);
  assert.match(STORE, /if \(!row\.placementDeadline \|\| row\.placementDeadline > now\) return \{ events \}/);
  const locks = [...STORE.matchAll(/\.for\("update"\)/g)].length;
  assert.ok(locks >= 7, `every settlement path must lock the row, found ${locks}`);
});

test("automatic attacks are recorded, unique and counted", () => {
  assert.match(STORE, /values\(\{ matchId: row\.id, round: row\.round, seat, coordinate, automatic: true \}\)/);
  assert.match(STORE, /\.onConflictDoNothing\(\)/);
  assert.match(STORE, /player1Timeouts|player1Timeouts/);
  assert.match(STORE, /player1ConsecutiveTimeouts: 0/);
  assert.match(STORE, /player2ConsecutiveTimeouts: 0/);
  assert.match(MIGRATION, /"automatic" boolean DEFAULT false NOT NULL/);
  assert.match(MIGRATION, /"player1_consecutive_timeouts"/);
  assert.match(MIGRATION, /"player2_consecutive_timeouts"/);
  assert.match(MIGRATION, /UNIQUE|unique/);
});

test("the round resolves through the same engine path as a manual round", () => {
  assert.match(STORE, /const resolved = await resolveLockedRoundTx\(tx, row, new Date\(\)\)/);
  assert.match(STORE, /async function resolveLockedRoundTx/);
  assert.match(STORE, /const resolution = resolveRound\(state, submissions\)/);
  assert.match(STORE, /if \(!locked\.player1 \|\| !locked\.player2\)/);
  assert.match(STORE, /eq\(battleshipMatches\.round, row\.round\),\s*\n\s*eq\(battleshipMatches\.phase, MATCH_PHASE\.COMBAT\)/);
});

test("recovery happens on a read too, so a restart cannot strand a match", () => {
  assert.match(STORE, /const events = await settleIfOverdue\(row\)/);
  assert.match(STORE, /async function settleIfOverdue/);
  assert.match(STORE, /resolveDueTimeouts\(\{ matchId: row\.id, now \}\)/);
  assert.match(STORE, /row\.roundDeadline <= now/);
  assert.match(STORE, /row\.placementDeadline <= now/);
});

test("a late manual submission materialises the absent seat's shot, not its own", () => {
  assert.match(STORE, /row\.roundDeadline <= new Date\(\)/);
  assert.match(
    STORE,
    /applyAutoAttacksTx\(\s*\n\s*tx,\s*\n\s*row,\s*\n\s*attacks,\s*\n\s*new Date\(\),\s*\n\s*serverRandomInt,\s*\n\s*otherSeat\(seat\),/,
  );
});

test("first and second timeout settlements complete the canonical lifecycle", () => {
  assert.match(STORE, /metadata: \{ reason, result: winnerSeat \}/);
  assert.match(STORE, /metadata: \{ reason, result: "draw" \}/);
  assert.match(STORE, /to: "cancelled", cancelReason, at: now, tx/);
  assert.match(STORE, /"player_disconnected"/);
});

// ── Durable scheduling ────────────────────────────────────────────────────

test("the timeout job is CRON_SECRET-gated and reports its own success", () => {
  assert.match(JOB, /verifyCronRequest\(request\)/);
  assert.match(JOB, /sweepBattleshipTimeouts\(\)/);
  assert.match(JOB, /ok: result\.ok/);
  assert.match(JOB, /publishRoundResult/);
  assert.match(JOB, /publishTimeoutNotice/);
  assert.match(JOB, /publishForfeit/);
});

test("the scheduler is installed on both platforms, every minute", () => {
  const timer = read("deploy/jobs/grynd-job-battleship-timeouts.timer");
  assert.match(timer, /OnCalendar=\*-\*-\* \*:\*:00/);
  assert.match(timer, /Persistent=true/, "a missed run is caught up after a restart");
  assert.match(timer, /Unit=grynd-job@battleship-timeouts\.service/);
  assert.match(RUN_JOB, /battleship-timeouts/);
  assert.equal(
    VERCEL.crons.some((cron) => cron.path === "/api/jobs/battleship-timeouts"),
    true,
  );
});

// ── Disconnect / reconnection ────────────────────────────────────────────

test("the reconnect grace is 30 seconds and a rejoin cancels the timer", () => {
  assert.equal(DISCONNECT_GRACE_SECONDS, 30);
  assert.match(SERVER, /const BATTLESHIP_DISCONNECT_GRACE_MS = 30_000/);
  assert.match(SERVER, /cancelDisconnectGraceTimer\(`battleship:/);
  assert.match(SERVER, /delay: BATTLESHIP_DISCONNECT_GRACE_MS/);
});

test("an abandoned match is settled only on the token owner's own match", () => {
  assert.match(DISCONNECT, /verifyToken\(token, \{ secretKey \}\)/);
  assert.match(DISCONNECT, /isMatchId\(matchId\)/);
  assert.match(DISCONNECT, /forfeitMatchOnDisconnect\(\{ userId: clerkUserId, matchId \}\)/);
  assert.doesNotMatch(DISCONNECT, /body\??\.\s*(userId|seat|player1Id|player2Id)/);
  assert.match(SERVER, /\/api\/battleship\/disconnect-forfeit/);
});

test("a disconnect only settles the match — it never rewrites the round", () => {
  const forfeit = STORE.slice(
    STORE.indexOf("export async function forfeitMatchOnDisconnect"),
    // Stop at the practice section: the bot's pre-commit writes a round number,
    // which is not part of the disconnect settlement path.
    STORE.indexOf("export async function createAiMatch"),
  );
  assert.match(forfeit, /finishMatchTx\(tx, row, winner, "abandoned", now\)/);
  assert.doesNotMatch(forfeit, /round:/, "the round is preserved");
  assert.doesNotMatch(forfeit, /battleshipAttacks/, "no attack is duplicated");
  assert.match(forfeit, /requireSeat\(row, userId\)/);

  const settle = STORE.slice(
    STORE.indexOf("async function finishMatchTx"),
    STORE.indexOf("async function drawMatchTx"),
  );
  assert.match(settle, /phase: MATCH_PHASE\.FINISHED/);
  assert.match(settle, /endedAt: now/);
});

test("a reconnect re-reads the same authoritative snapshot", () => {
  assert.match(PAGE, /socket\.on\("connect", join\)/);
  assert.match(PAGE, /socket\.emit\("leave_room", \{ roomId \}\)/);
  assert.match(PAGE, /\/api\/battleship\/match\/\$\{matchId\}/);
  assert.match(PAGE, /setSnapshot\(data\.data as MatchSnapshot\)/);
});

// ── Client is display-only ────────────────────────────────────────────────

test("the browser countdown never resolves anything", () => {
  assert.match(BATTLE, /roundDeadline/);
  assert.match(BATTLE, /secondsRemaining\(roundDeadline\)/);
  assert.doesNotMatch(PAGE, /resolveRound|pickTimeoutCoordinate|setRound|expire/i);
  assert.doesNotMatch(BATTLE, /resolveRound|pickTimeoutCoordinate/);
  assert.match(BATTLE, /ROUND_SECONDS/);
});

// ── Migration / journal ───────────────────────────────────────────────────

test("0237 is journaled and adds only timeout state", () => {
  const entry = JOURNAL.entries.find((candidate) => candidate.tag === "0237_battleship_timeouts");
  assert.ok(entry, "0237_battleship_timeouts must be in the Drizzle journal");
  assert.equal(entry.idx, 218);
  const alters = [...MIGRATION.matchAll(/ALTER TABLE "(\w+)"/g)].map((match) => match[1]);
  assert.deepEqual(alters.sort(), [
    "battleship_attacks",
    "battleship_matches",
    "battleship_matches",
  ]);
  assert.doesNotMatch(MIGRATION, /CREATE TABLE/, "no new table is needed");
});
