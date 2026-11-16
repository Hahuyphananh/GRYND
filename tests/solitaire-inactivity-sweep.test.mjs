/**
 * solitaire-inactivity-sweep.test.mjs
 *
 * The untimed Solitaire Duel's one clock: 20 minutes without an accepted move
 * forfeits the idle seat and awards the opponent the win. The store already
 * enforced that on READ, but a match nobody opened was never resolved, so a
 * list could show it as "in progress" indefinitely.
 *
 * This contract pins the fix:
 *   * the store exposes a bounded, per-seat sweep that reuses the locked
 *     resolveInactivityDue path (no second settlement implementation);
 *   * the lobby settles the caller's due matches BEFORE listing them;
 *   * a cron job runs the global sweep every five minutes, behind cron auth,
 *     with matching Vercel and systemd schedules.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (rel) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const STORE = read("src/lib/solitaire-duel/serverStore.ts");
const LOBBY = read("src/app/api/solitaire-duel/lobby/route.ts");
const JOB = read("src/app/api/jobs/solitaire-inactivity/route.ts");
const STORE_CODE = stripComments(STORE);

test("the store sweeps idle matches through the existing locked settlement", () => {
  assert.match(STORE_CODE, /export async function sweepInactiveMatches/);
  assert.match(STORE_CODE, /INACTIVITY_FORFEIT_MS/);
  assert.match(
    STORE_CODE,
    /resolveInactivityDue\(\{ matchId: String\(row\.id\), nowMs \}\)/,
  );
  // Per-seat baseline: a seat is due from its own last action, else GO/started.
  assert.match(
    STORE_CODE,
    /p1LastActionAt\}, \$\{solitaireDuelMatches\.goAt\}, \$\{solitaireDuelMatches\.startedAt\}/,
  );
  assert.match(
    STORE_CODE,
    /p2LastActionAt\}, \$\{solitaireDuelMatches\.goAt\}, \$\{solitaireDuelMatches\.startedAt\}/,
  );
  // Bounded: a single tick can never walk the whole table.
  assert.match(
    STORE_CODE,
    /\.limit\(Math\.max\(1, Math\.min\(500, Math\.floor\(limit\)\)\)\)/,
  );
});

test("the lobby settles the caller's due matches before listing them", () => {
  const code = stripComments(LOBBY);
  assert.match(code, /sweepInactiveMatches\(\{ userId \}\)/);
  const sweepAt = code.indexOf("sweepInactiveMatches({ userId })");
  const listAt = code.indexOf(".orderBy(desc(solitaireDuelMatches.createdAt))");
  assert.ok(sweepAt > 0 && listAt > sweepAt, "sweep runs before the recent-matches query");
});

test("a cron job runs the same sweep behind cron authentication", () => {
  assert.match(JOB, /verifyCronRequest\(request\)/);
  assert.match(JOB, /sweepInactiveMatches\(\{ limit \}\)/);
  assert.match(JOB, /export async function GET/);
});

test("the job is scheduled on both Vercel and the self-hosted timer", () => {
  const vercel = JSON.parse(read("vercel.json"));
  const cron = vercel.crons.find((c) => c.path === "/api/jobs/solitaire-inactivity");
  assert.ok(cron, "vercel.json schedules the inactivity sweep");
  assert.equal(cron.schedule, "*/5 * * * *");

  const timer = read("deploy/jobs/grynd-job-solitaire-inactivity.timer");
  assert.match(timer, /OnCalendar=\*:0\/5/);
  assert.match(timer, /Unit=grynd-job@solitaire-inactivity\.service/);
});

test("practice matches share the human's clock and paused ones are skipped", () => {
  assert.match(
    STORE_CODE,
    /player2Id === SOLITAIRE_DUEL_AI_PLAYER_ID \? SEAT\.PLAYER1 : SEAT\.PLAYER2/,
  );
  assert.match(STORE_CODE, /isPracticePaused\("solitaire-duel", String\(row\.id\)\)/);
});


const MATCH_VIEW = read("src/app/casino/solitaire-duel/[matchId]/PageClient.tsx");

test("the match view explains an inactivity forfeit", () => {
  assert.match(MATCH_VIEW, /data-testid="solitaire-forfeit-notice"/);
  assert.match(MATCH_VIEW, /settledByInactivity/);
  assert.match(MATCH_VIEW, /opponentInactivityForfeitAtMs/);
  assert.match(MATCH_VIEW, /20 minutes/);
});
