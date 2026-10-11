// tests/countdown-start-liveness.test.mjs
//
// Regression tests for the reported bug and the class it turned out to be:
//
//   "Precision timer, Tower Arena — when the cooldown finishes, the game
//    doesn't start (in play vs AI). Also look into the PvP mode."
//
// Every clocked game here stores its pacing as an absolute instant and turns
// that instant into a transition ONLY inside a read of its match route
// (`advanceMatchOnPoll`, `advanceReadyIfNeeded`, `fetchMatchWithAutoResolve`,
// `resolveRaceIfDue`, `resolveDueRace`). The match pages then stopped polling —
// `useMatchSync`: one read on socket reconnect, one on tab focus, never a timer —
// so any instant nobody read past simply ran out:
//
//   * "when the cooldown finishes, the game doesn't start" — the pre-game
//     countdown, in Tower Arena, Mines Duel, Four in a Row, Keno Duel and Lane
//     Rush Duel: both seats sat on a finished countdown and the first move never
//     came. In Tower Arena it hit vs-AI and PvP alike.
//   * a stalling opponent was never timed out (Tower Arena, Four in a Row,
//     Mines Duel) and an expired race was never graded (Speed Typing).
//   * Precision — a round decided by a player's own STOP packet is the one
//     resolution that does not come back through the realtime server's due
//     scheduler, and the scheduler only re-arms from a resolution IT performed.
//     The freshly armed cooldown had no timer, so the next round never opened.
//
// The fix is ONE bounded, deadline-driven read per pending instant — never a
// recurring poll: the shared `useDeadlineRead` hook, fed by a selector from
// `lib/deadlineRead.ts`. These tests pin the timing rule, the per-game
// selectors, the hook's boundedness, and the wiring of each page.
//
// Run:  node --import tsx --test tests/countdown-start-liveness.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEADLINE_READ_MAX_ATTEMPTS,
  DEADLINE_READ_RETRY_MS,
  DEADLINE_READ_SLACK_MS,
  deadlineReadDelayMs,
  fourInARowDueRead,
  kenoPvpDueRead,
  laneRushDueRead,
  minesPvpDueRead,
  speedTypingDueRead,
  towerArenaDueRead,
} from "../src/lib/deadlineRead.ts";

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
/** Strip // and block comments so prose about timers is never mistaken for code. */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const HOOK = "src/hooks/useDeadlineRead.ts";
const SHARED = "src/lib/deadlineRead.ts";
const REALTIME = "realtime-server/server.js";
const MINES_VIEW = "src/lib/mines-pvp/matchView.js";

/** Every page that brings a read forward for its own stored deadline. */
const WIRED_PAGES = [
  ["Tower Arena", "src/app/casino/tower-arena/game/[matchId]/PageClient.tsx"],
  ["Four in a Row", "src/app/casino/four-in-a-row/game/[gameId]/PageClient.tsx"],
  ["Mines Duel", "src/app/casino/mines-pvp/[matchId]/PageClient.tsx"],
  ["Lane Rush Duel", "src/app/casino/lane-runner/[matchId]/PageClient.jsx"],
  ["Keno Duel", "src/app/casino/keno-pvp/[matchId]/PageClient.jsx"],
  ["Speed Typing", "src/app/casino/speed-typing/[matchId]/PageClient.tsx"],
];

const DEADLINE = "2026-10-11T12:00:10.000Z";

// ── 1. The timing rule the read is armed with ────────────────────────────

test("the first deadline read can never land before the stamped deadline", () => {
  const deadline = 1_700_000_010_000;

  // A countdown still running: the read waits out the remainder, then the slack
  // — strictly past the instant the stores will accept the advance at.
  const delay = deadlineReadDelayMs(deadline, deadline - 10_000);
  assert.equal(delay, 10_000 + DEADLINE_READ_SLACK_MS);
  assert.ok(delay > 10_000, "the read must land after the deadline, not on it");
  assert.ok(
    deadline - 10_000 + delay > deadline,
    "the read instant is strictly past the deadline — the stores advance only then",
  );

  // A deadline that is already past (a late mount, or a read after a throttled
  // timer): still a full slack, so a `deadline > now` guard can never refuse it.
  assert.equal(deadlineReadDelayMs(deadline, deadline + 5_000), DEADLINE_READ_SLACK_MS);
  assert.ok(DEADLINE_READ_SLACK_MS > 0, "a zero delay is exactly the early read that strands the match");

  // Defensive: an unparseable deadline still yields a usable delay.
  assert.equal(deadlineReadDelayMs(NaN, 0), DEADLINE_READ_SLACK_MS);

  // The retries are bounded, so this can never become a poll loop.
  assert.ok(DEADLINE_READ_RETRY_MS >= 250, "a retry must not spin");
  assert.ok(DEADLINE_READ_MAX_ATTEMPTS <= 10, "a deadline costs at most a handful of reads");
  assert.ok(
    DEADLINE_READ_MAX_ATTEMPTS * DEADLINE_READ_RETRY_MS < 15_000,
    "the whole retry window stays inside the shortest deadline's own length",
  );
});

// ── 2. The shared hook: one bounded timer, never an interval ─────────────

test("useDeadlineRead arms ONE bounded timer and never an interval", () => {
  const hook = read(HOOK);
  const code = stripComments(hook);

  assert.match(hook, /^"use client";/m, "it is a client hook");
  assert.ok(!code.includes("setInterval"), "a deadline is never watched with an interval");
  assert.match(code, /window\.setTimeout\(run, deadlineReadDelayMs\(at, Date\.now\(\)\)\)/,
    "the first read is offset by the shared, unit-tested timing rule");
  assert.match(code, /if \(reads < DEADLINE_READ_MAX_ATTEMPTS\)/, "the retries are bounded");
  assert.match(code, /window\.clearTimeout\(timer\)/, "the timer is cleared when the instant changes");
  assert.match(code, /if \(!deadline\) return undefined;/, "no pending instant arms nothing");
  assert.match(code, /if \(!Number\.isFinite\(at\)\) return undefined;/, "an unparseable instant arms nothing");
  // The read is held in a ref, so an inline arrow (new identity every render)
  // cannot tear the timer down and re-arm it on each paint.
  assert.match(code, /const readRef = useRef\(read\);/, "the callback must be ref-held");
  assert.match(code, /\}, \[deadline\]\);/, "only a change of instant re-arms");
});

// ── 3. Which instant each game is waiting on ─────────────────────────────
//
// The selectors are pure, so every mode is pinned here rather than only grepped
// out of a page.

test("Tower Arena reads its start countdown in every mode, and a HUMAN turn window", () => {
  // The reported bug: a lobby sitting on its start countdown.
  for (const isAi of [true, false]) {
    assert.equal(
      towerArenaDueRead({ status: "waiting", phase: "countdown", isAi, turnDeadline: DEADLINE }),
      DEADLINE,
      "the start countdown must be read vs-AI and in PvP alike",
    );
  }
  assert.equal(towerArenaDueRead({ status: "waiting", phase: "countdown", turnDeadline: null }), null);

  // An ONLINE placement turn — the expiry fallback only runs on a read.
  assert.equal(
    towerArenaDueRead({ status: "active", phase: "placement", isAi: false, turnDeadline: DEADLINE }),
    DEADLINE,
  );
  // vs-AI is untimed for the human, its bot turns are driven by `/ai-turn`, and a
  // paused free-play match has nothing to advance.
  assert.equal(
    towerArenaDueRead({ status: "active", phase: "placement", isAi: true, paused: false, turnDeadline: DEADLINE }),
    null,
  );
  assert.equal(
    towerArenaDueRead({ status: "active", phase: "placement", isAi: true, paused: true, turnDeadline: DEADLINE }),
    null,
  );
});

test("Four in a Row reads the ready countdown, and a human's move window", () => {
  // The ready countdown in any mode — `advanceReadyIfNeeded` is what starts the
  // match, and the route's own comment calls it "Poll-driven".
  assert.equal(
    fourInARowDueRead({ status: "ready", isAiGame: false, readyDeadlineAt: DEADLINE }),
    DEADLINE,
  );
  assert.equal(
    fourInARowDueRead({ status: "ready", isAiGame: true, readyDeadlineAt: DEADLINE }),
    DEADLINE,
  );
  assert.equal(fourInARowDueRead({ status: "ready", readyDeadlineAt: null }), null);

  // A human's move window — `settleTimeoutIfNeeded` awards the game to the
  // opponent, so a stalling player must actually lose on time.
  assert.equal(
    fourInARowDueRead({ status: "in_progress", isAiGame: false, moveDeadlineAt: DEADLINE }),
    DEADLINE,
  );
  // Practice is exempt: a player who stepped away must not lose a free game.
  assert.equal(
    fourInARowDueRead({ status: "in_progress", isAiGame: true, moveDeadlineAt: DEADLINE }),
    null,
  );
});

test("Mines Duel reads the ready banner, and a human match's own timer", () => {
  for (const isAi of [false, true]) {
    assert.equal(
      minesPvpDueRead({ status: "ready", isAi, readyDeadline: DEADLINE }),
      DEADLINE,
      "the ready banner → live step must be read in both modes",
    );
  }
  assert.equal(minesPvpDueRead({ status: "ready", readyDeadline: null }), null);
  assert.equal(
    minesPvpDueRead({ status: "active", isAi: false, matchDeadline: DEADLINE }),
    DEADLINE,
    "an expired 180s match must resolve for two humans",
  );
  assert.equal(minesPvpDueRead({ status: "active", isAi: true, matchDeadline: DEADLINE }), null);
});

test("Lane Rush and Keno read their READY window only — the live one is nudged elsewhere", () => {
  assert.equal(laneRushDueRead({ status: "ready", roundDeadline: DEADLINE }), DEADLINE);
  assert.equal(laneRushDueRead({ status: "active", roundDeadline: DEADLINE }), null);
  assert.equal(laneRushDueRead({ status: "p1_turn", roundDeadline: DEADLINE }), null);
  assert.equal(laneRushDueRead({ status: "ready", roundDeadline: null }), null);

  assert.equal(kenoPvpDueRead({ status: "ready", readyDeadline: DEADLINE }), DEADLINE);
  assert.equal(kenoPvpDueRead({ status: "live", readyDeadline: DEADLINE }), null);
  assert.equal(kenoPvpDueRead({ status: "ready", readyDeadline: null }), null);
});

test("Speed Typing reads the race limit, including a practice race whose bot already finished", () => {
  const live = { deadlineMs: 1_700_000_010_000, goAtMs: 1_700_000_000_000 };
  assert.equal(speedTypingDueRead(live), live.deadlineMs, "a live unresolved race must be graded at its limit");
  // Practice is NOT exempt: the bot heartbeat stops once the bot has finished,
  // which is exactly the race that would otherwise sit ungraded.
  assert.equal(speedTypingDueRead({ ...live, opponentFinished: true }), live.deadlineMs);
  // Nothing to grade.
  assert.equal(speedTypingDueRead(null), null);
  assert.equal(speedTypingDueRead({ ...live, finished: true }), null);
  assert.equal(speedTypingDueRead({ ...live, resolved: true }), null);
  assert.equal(speedTypingDueRead({ deadlineMs: live.deadlineMs, goAtMs: null }), null, "no GO instant → no limit yet");
  assert.equal(speedTypingDueRead({ deadlineMs: 0, goAtMs: 1 }), null);
  assert.equal(speedTypingDueRead({ deadlineMs: NaN, goAtMs: 1 }), null);
});

test("a match waiting on nothing arms nothing", () => {
  for (const selector of [towerArenaDueRead, fourInARowDueRead, minesPvpDueRead, laneRushDueRead, kenoPvpDueRead]) {
    assert.equal(selector(null), null);
    assert.equal(selector(undefined), null);
    assert.equal(selector({ status: "finished" }), null);
  }
  assert.equal(fourInARowDueRead({ status: "finished", readyDeadlineAt: DEADLINE }), null);
  assert.equal(minesPvpDueRead({ status: "cancelled", readyDeadline: DEADLINE }), null);
});

// ── 4. Every page brings the read forward, and none polls again ──────────

for (const [name, file] of WIRED_PAGES) {
  test(`${name} reads at its stored deadline without a recurring poll`, () => {
    const page = read(file);
    const code = stripComments(page);

    assert.match(code, /useDeadlineRead\(/, "must arm the shared bounded read");
    assert.match(
      code,
      /import \{ useDeadlineRead \} from "\S*hooks\/useDeadlineRead"/,
      "must use the shared hook, not a hand-rolled setTimeout",
    );
    assert.match(code, /from "\S*lib\/deadlineRead"/, "must use the shared selectors");
    // The deadline read is the only new timer — the sync hook is still the sync
    // hook, and no poll cadence may come back.
    assert.match(page, /useMatchSync\(/, "the event-driven sync must survive");
    assert.ok(!page.includes("useVisiblePoll"), "no recurring match poll may come back");
    assert.ok(!page.includes("SOCKET_HEALTHY_POLL_MS"), "no poll cadence may come back");
    // The authoritative fetch and the socket room must survive.
    assert.match(page, /fetch\(/, "the snapshot must still be fetchable");
    assert.match(page, /join_room/, "the per-match socket room must still be joined");

    // The read must be armed from the game's OWN selector, and its effect must
    // not re-introduce an interval.
    const selector = {
      "Tower Arena": "towerArenaDueRead",
      "Four in a Row": "fourInARowDueRead",
      "Mines Duel": "minesPvpDueRead",
      "Lane Rush Duel": "laneRushDueRead",
      "Keno Duel": "kenoPvpDueRead",
      "Speed Typing": "speedTypingDueRead",
    }[name];
    assert.match(code, new RegExp(`${selector}\\(`), `${name} must arm from ${selector}`);
    assert.ok(
      !/useDeadlineRead\([\s\S]{0,200}?setInterval/.test(code),
      "the deadline read must never become an interval",
    );
  });
}

test("the obsolete per-game countdown module is gone, not left dead beside the shared one", () => {
  const shared = read(SHARED);
  assert.match(shared, /export function deadlineReadDelayMs\(/);
  assert.match(shared, /export const DEADLINE_READ_MAX_ATTEMPTS/);
  // Every selector lives in the one shared module.
  for (const name of [
    "towerArenaDueRead",
    "fourInARowDueRead",
    "minesPvpDueRead",
    "laneRushDueRead",
    "kenoPvpDueRead",
    "speedTypingDueRead",
  ]) {
    assert.match(shared, new RegExp(`export function ${name}\\(`), `${name} must be exported`);
  }
  assert.ok(
    !read("src/app/casino/tower-arena/game/[matchId]/PageClient.tsx").includes("lib/tower-arena/deadlineRead"),
    "the page must import the shared module",
  );
});

test("Mines Duel exposes the ready instant its board must read", () => {
  const view = stripComments(read(MINES_VIEW));
  assert.match(
    view,
    /readyDeadline: match\.roundDeadline \?\? null/,
    "the view must expose the stamped ready instant, or the client cannot arm a read for it",
  );
});

// ── 5. The read is still the thing that advances each match ──────────────

test("Tower Arena's read still starts the match and resolves a turn window", () => {
  const route = stripComments(read("src/app/api/tower-arena/get-match/route.ts"));
  const store = stripComments(read("src/lib/tower-arena/serverStore.ts"));

  assert.match(route, /await advanceMatchOnPoll\(/, "get-match must keep advancing the match on a read");
  assert.match(store, /export async function advanceMatchOnPoll\(matchId: string, userId\?: string\)/);
  assert.match(
    store,
    /if \(match\.turnDeadline && new Date\(match\.turnDeadline\)\.getTime\(\) > now\) return \{ match \};[\s\S]{0,400}?const started = await startMatchTx\(tx, match\.id\);/,
    "an elapsed countdown must start the match on the read",
  );
  assert.match(
    store,
    /const expired = \(deadlineMs > 0 && deadlineMs <= now\) \|\| \(botTurn && deadlineMs <= 0\);/,
    "an elapsed turn window must be resolvable by that read",
  );
  assert.match(
    store,
    /if \(!botTurn && Boolean\(match\.isAi\)\) return \{ match \};/,
    "a vs-AI human turn stays untimed, so the page must not arm a read for it",
  );
});

test("Four in a Row's read still advances the ready gate and the timeout", () => {
  const route = stripComments(read("src/app/api/four-in-a-row/game-state/route.js"));
  const store = stripComments(read("src/lib/fourInARowServer.js"));
  assert.match(route, /game = await advanceReadyIfNeeded\(game\);/, "the route must keep advancing on a read");
  assert.match(route, /game = await settleTimeoutIfNeeded\(game\);/, "the route must keep settling on a read");
  assert.match(
    store,
    /export async function advanceReadyIfNeeded\(game\)[\s\S]{0,600}?if \(new Date\(game\.readyDeadlineAt\)\.getTime\(\) > Date\.now\(\)\) return game;/,
    "the ready countdown must advance to in_progress once it has passed",
  );
  assert.match(store, /export async function settleTimeoutIfNeeded\(game\)/);
});

test("Mines Duel's read still goes live at the ready banner and settles the timer", () => {
  const route = stripComments(read("src/app/api/mines-pvp/match/[matchId]/route.js"));
  const store = stripComments(read("src/lib/mines-pvp/serverStore.js"));
  assert.match(route, /await fetchMatchWithAutoResolve\(userId, matchId\);/, "the route must keep auto-resolving");
  assert.match(
    store,
    /match\.status === MATCH_STATUS\.READY &&[\s\S]{0,200}?const advanceFromReady|match = await advanceFromReady\(tx, match\);/,
    "the ready banner must go live on the read",
  );
  assert.match(store, /if \(isMatchExpired\(match\)\) \{/, "an expired match timer must settle on the read");
});

// ── 6. Precision: a round decided by a STOP re-arms the scheduler ────────

test("the precision stop proxy re-arms the due scheduler for the round it armed", () => {
  const server = stripComments(read(REALTIME));

  const handler = server.slice(server.indexOf('socket.on("precision:stop"'));
  assert.ok(handler.length > 0, "the stop handler must still exist");

  // The decision branch that keeps the match alive must broadcast the armed
  // round AND immediately ask the scheduler what is due — the kick that turns
  // `nextDueAtMs` (the countdown end, then the bot's stop) back into a timer.
  assert.match(
    handler,
    /if \(payload\.matchFinished\)[\s\S]{0,400}?emit\("precision:matchFinished"[\s\S]{0,400}?\} else \{[\s\S]{0,400}?emit\("precision:roundArmStart",\s*\{\s*matchId: matchIdStr,\s*match: payload\.match,\s*\}\);\s*schedulePrecisionDue\(matchIdStr, Date\.now\(\)\);/,
    "a decided round that continues must re-arm the due scheduler right after broadcasting the next round",
  );

  // The pre-existing kick sites must survive: the re-arm above is a THIRD kick,
  // not a replacement for the ones that already worked.
  assert.match(server, /if \(PRECISION_ARMING_EVENTS\.has\(String\(event\)\)\) \{[\s\S]{0,200}?schedulePrecisionDue\(/, "the ready/matchStart relay kick must stay");
  assert.match(server, /const PRECISION_ARMING_EVENTS = new Set\(\["precision:playerReady", "precision:matchStart"\]\);/);
  assert.match(server, /if \(precisionMatchRoomIsEmpty\(matchId\)\) \{\s*cancelPrecisionDue\(matchId\);\s*return;\s*\}/, "an empty room must still stop the scheduler");
  assert.match(server, /if \(report\.nextDueAtMs !== null && report\.nextDueAtMs !== undefined\) \{\s*schedulePrecisionDue\(matchId, report\.nextDueAtMs\);/, "the scheduler must still re-arm from the instant the store reports");
});

test("the stop route still reports both stops, so the proxy knows a round was decided", () => {
  const route = stripComments(read("src/app/api/precision/round-stop/route.ts"));
  assert.match(route, /bothStopped: result\.bothStopped/);
  assert.match(route, /matchFinished: result\.matchFinished/);

  // And the store's stop path is where a round decided by a packet gets its
  // next round armed — the instant the proxy now schedules.
  const store = stripComments(read("src/lib/precision/serverStore.ts"));
  assert.match(store, /export async function recordRoundStop\(/, "the canonical stop writer must exist");
  assert.match(store, /ROUND_RESULT_REVEAL_MS/, "the cooldown gate stays part of arming the next round");
});
