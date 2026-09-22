/**
 * PvP Keno ("Keno Survival Duel") — flow + race-safety tests.
 *
 * `tests/keno-pvp-engine.test.mjs` proves the pure RULES. This file covers
 * what those rules mean for a live duel, on both sides of the wire:
 *
 *   • a full run, from the first lit tile to a 3-lives-claimed win;
 *   • duplicate / stale tile taps (the first tap wins the tile);
 *   • two simultaneous claims (row lock + the live-tile identity gate);
 *   • a tap that arrives after the window (not a claim — the both-miss is
 *     resolved instead, so the match never stalls);
 *   • a tap inside the hidden network grace tail;
 *   • a both-miss that eliminates both players → draw;
 *   • the window tightening with every claim (and NOT with a miss);
 *   • the board running out → settle on lives, then tiles;
 *   • reconnection (every piece of run state is on the row);
 *   • the removal of every old mechanic (points / banking-style rounds /
 *     first-to-10 / the 10-ball glow stream).
 *
 * There is no DB in this test run (the repo's PvP suites are structural +
 * pure-engine for the same reason), so the server-side assertions are exact
 * ORDER/guard contracts read from the real source files, paired with the
 * rule sequence that shows why each guard is required.
 *
 * Run:  node --import tsx --test tests/keno-pvp-survival.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  KENO_POOL_SIZE,
  MIN_WINDOW_MS,
  RESULT,
  STARTING_LIVES,
  START_WINDOW_MS,
  TAP_GRACE_MS,
  WINDOW_STEP_MS,
} from "../src/lib/keno-pvp/constants.js";
import {
  applyBothMissToLives,
  applyClaimToLives,
  decideSurvivalResult,
  isClaimInWindow,
  pickLiveTile,
  tileLogEntry,
  tileWindowMs,
} from "../src/lib/keno-pvp/engine.js";

// Normalise CRLF so multi-line structural assertions work on any OS.
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const store = read("src/lib/keno-pvp/serverStore.js");
const constants = read("src/lib/keno-pvp/constants.js");
const engine = read("src/lib/keno-pvp/engine.js");
const claimRoute = read("src/app/api/keno-pvp/match/[matchId]/catch/route.js");
const matchRoute = read("src/app/api/keno-pvp/match/[matchId]/route.js");
const page = read("src/app/casino/keno-pvp/[matchId]/PageClient.jsx");
const lobby = read("src/app/casino/keno/PageClient.jsx");

const SEED = "keno-pvp:99";

// ════════════════════════════════════════════════════════════════════
// A driver that plays the run exactly as `claimTile` / the both-miss path
// resolve it — the rules, not the DB.
// ════════════════════════════════════════════════════════════════════

function createRun({ seed = SEED } = {}) {
  const used = [];
  const liveTile = pickLiveTile({ seed, index: 0, used });
  return {
    seed,
    p1Lives: STARTING_LIVES,
    p2Lives: STARTING_LIVES,
    p1Tiles: 0,
    p2Tiles: 0,
    index: 0,
    used: [liveTile],
    liveTile,
    startedMs: 0,
    windowMs: tileWindowMs(0),
    deadlineMs: tileWindowMs(0),
    log: [],
    result: null,
  };
}

function lightNext(run, now) {
  const index = run.index + 1;
  const next = pickLiveTile({ seed: run.seed, index, used: run.used });
  if (next == null) return settle(run, { exhausted: true, now });
  const windowMs = tileWindowMs(run.p1Tiles + run.p2Tiles);
  return {
    ...run,
    index,
    used: [...run.used, next],
    liveTile: next,
    startedMs: now,
    windowMs,
    deadlineMs: now + windowMs,
  };
}

function settle(run, { exhausted = false, now = 0 } = {}) {
  const result = decideSurvivalResult({
    p1Lives: run.p1Lives,
    p2Lives: run.p2Lives,
    p1Tiles: run.p1Tiles,
    p2Tiles: run.p2Tiles,
    exhausted,
  });
  return { ...run, result: result || RESULT.DRAW, endedExhausted: exhausted, endedAt: now };
}

function resolveBothMiss(run, now) {
  const lives = applyBothMissToLives(run);
  const entry = tileLogEntry({
    tile: run.liveTile,
    index: run.index,
    outcome: "both_miss",
    at: now,
    ...lives,
    windowMs: run.windowMs,
  });
  const next = { ...run, ...lives, log: [...run.log, entry] };
  const result = decideSurvivalResult(next);
  if (result) return { ...next, result };
  return lightNext(next, now);
}

function playClaim(run, { seat, tile, atMs }) {
  if (run.result) return { accepted: false, reason: "Match is over", run };
  if (tile !== run.liveTile) {
    // Not the lit tile. If its window has already closed the miss resolves.
    if (atMs > run.deadlineMs + TAP_GRACE_MS) {
      return { accepted: false, reason: "That tile is no longer live", run: resolveBothMiss(run, atMs) };
    }
    return { accepted: false, reason: "That tile is not live", run };
  }
  if (atMs < run.startedMs) {
    return { accepted: false, reason: "Tile is not live yet", run };
  }
  if (!isClaimInWindow({ atMs, startedMs: run.startedMs, deadlineMs: run.deadlineMs })) {
    return { accepted: false, reason: "Too slow — the tile expired", run: resolveBothMiss(run, atMs) };
  }
  const lives = applyClaimToLives({ claimantSeat: seat, ...run });
  const entry = tileLogEntry({
    tile,
    index: run.index,
    outcome: seat,
    at: atMs,
    ...lives,
    windowMs: run.windowMs,
    reactionMs: atMs - run.startedMs,
  });
  const next = {
    ...run,
    ...lives,
    p1Tiles: run.p1Tiles + (seat === "player1" ? 1 : 0),
    p2Tiles: run.p2Tiles + (seat === "player2" ? 1 : 0),
    log: [...run.log, entry],
  };
  const result = decideSurvivalResult(next);
  if (result) return { accepted: true, run: { ...next, result } };
  return { accepted: true, run: lightNext(next, atMs) };
}

// ════════════════════════════════════════════════════════════════════
// The run
// ════════════════════════════════════════════════════════════════════

test("a run starts at 3 lives each with a 1.6s window and one lit tile", () => {
  const run = createRun();
  assert.equal(run.p1Lives, STARTING_LIVES);
  assert.equal(run.p2Lives, STARTING_LIVES);
  assert.equal(run.windowMs, START_WINDOW_MS);
  assert.ok(run.liveTile >= 1 && run.liveTile <= KENO_POOL_SIZE);
  assert.equal(run.used.length, 1);
  assert.equal(run.result, null);
});

test("claiming tiles costs the opponent a life and ends at 0 lives", () => {
  let run = createRun();
  const seats = ["player1", "player2", "player1", "player1"];
  for (let i = 0; i < seats.length; i += 1) {
    const out = playClaim(run, { seat: seats[i], tile: run.liveTile, atMs: run.startedMs + 250 });
    assert.equal(out.accepted, true, `claim ${i} was rejected: ${out.reason}`);
    run = out.run;
  }
  // p1 claimed 3, p2 claimed 1 → p2 is eliminated.
  assert.equal(run.p1Tiles, 3);
  assert.equal(run.p2Tiles, 1);
  assert.equal(run.p2Lives, 0);
  assert.equal(run.p1Lives, 2);
  assert.equal(run.result, RESULT.PLAYER1);
  assert.equal(run.log.length, 4);
  assert.equal(run.log[run.log.length - 1].p2Lives, 0);
});

test("the window tightens with every claim, never below the floor", () => {
  // A long life bar so the run cannot end before the floor is reached —
  // this test is about the window, not about elimination.
  let run = { ...createRun(), p1Lives: 99, p2Lives: 99 };
  const windows = [run.windowMs];
  for (let i = 0; i < 20; i += 1) {
    const out = playClaim(run, {
      seat: i % 2 === 0 ? "player1" : "player2",
      tile: run.liveTile,
      atMs: run.startedMs + 200,
    });
    assert.equal(out.accepted, true, `claim ${i} was rejected: ${out.reason}`);
    run = out.run;
    windows.push(run.windowMs);
  }
  for (let i = 1; i < windows.length; i += 1) {
    assert.equal(
      windows[i],
      Math.max(MIN_WINDOW_MS, windows[i - 1] - WINDOW_STEP_MS),
      `window ${i} did not tighten by ${WINDOW_STEP_MS}ms`,
    );
  }
  assert.ok(windows.includes(MIN_WINDOW_MS), "the window never reached its floor");
  assert.ok(
    windows.filter((w) => w === MIN_WINDOW_MS).length > 1,
    "the floor should hold once reached",
  );
});

test("a both-miss costs BOTH players a life and does NOT tighten the window", () => {
  let run = createRun();
  const before = run.windowMs;
  const after = resolveBothMiss(run, run.deadlineMs + TAP_GRACE_MS + 1);
  assert.equal(after.p1Lives, STARTING_LIVES - 1);
  assert.equal(after.p2Lives, STARTING_LIVES - 1);
  assert.equal(after.windowMs, before, "a miss must not speed the match up");
  assert.equal(after.log.length, 1);
  assert.equal(after.log[0].outcome, "both_miss");
  assert.equal(after.log[0].reactionMs, null);
  // …and a new tile is lit with the SAME window.
  assert.notEqual(after.liveTile, run.liveTile);
  assert.equal(after.used.length, 2);
});

test("both players on their last life + a both-miss → draw", () => {
  let run = createRun();
  run = { ...run, p1Lives: 1, p2Lives: 1 };
  const after = resolveBothMiss(run, run.deadlineMs + TAP_GRACE_MS + 1);
  assert.equal(after.p1Lives, 0);
  assert.equal(after.p2Lives, 0);
  assert.equal(after.result, RESULT.DRAW);
});

// ════════════════════════════════════════════════════════════════════
// Taps: duplicates, races, lateness
// ════════════════════════════════════════════════════════════════════

test("a duplicate tap on the tile that was just claimed is refused", () => {
  let run = createRun();
  const tile = run.liveTile;
  const first = playClaim(run, { seat: "player1", tile, atMs: run.startedMs + 150 });
  assert.equal(first.accepted, true);
  run = first.run;
  // The same tile number again (a double tap / a retried POST).
  const second = playClaim(run, { seat: "player1", tile, atMs: run.startedMs + 160 });
  assert.equal(second.accepted, false);
  assert.equal(second.reason, "That tile is not live");
  assert.equal(second.run.p1Tiles, 1, "the stale tap must not score");
  assert.equal(second.run.p2Lives, STARTING_LIVES - 1, "nor cost a second life");
  assert.equal(second.run.log.length, 1);
});

test("two simultaneous claims: only the first can score (the row lock serialises them)", () => {
  const run = createRun();
  const tile = run.liveTile;
  const at = run.startedMs + 300;
  // The store serves simultaneous taps one at a time behind SELECT … FOR
  // UPDATE, so the second request always sees the state the first wrote.
  const a = playClaim(run, { seat: "player1", tile, atMs: at });
  assert.equal(a.accepted, true);
  const b = playClaim(a.run, { seat: "player2", tile, atMs: at });
  assert.equal(b.accepted, false);
  // Exactly one life was lost and exactly one tile was credited.
  assert.equal(b.run.p2Lives, STARTING_LIVES - 1);
  assert.equal(b.run.p1Lives, STARTING_LIVES);
  assert.equal(b.run.p1Tiles + b.run.p2Tiles, 1);
  // And the next tile is different from the one that was just taken.
  assert.notEqual(b.run.liveTile, tile);
});

test("a tap while no tile is lit yet cannot score", () => {
  const run = createRun();
  const early = playClaim(run, { seat: "player1", tile: run.liveTile, atMs: -10 });
  assert.equal(early.accepted, false);
  assert.equal(early.reason, "Tile is not live yet");
  assert.equal(early.run.log.length, 0);
});

test("a tap inside the hidden grace tail still wins the tile", () => {
  const run = createRun();
  const at = run.deadlineMs + TAP_GRACE_MS; // exactly the grace edge
  const out = playClaim(run, { seat: "player1", tile: run.liveTile, atMs: at });
  assert.equal(out.accepted, true);
  assert.equal(out.run.p1Tiles, 1);
  assert.equal(out.run.p2Lives, STARTING_LIVES - 1);
});

test("a tap past the window is not a claim — the both-miss resolves instead", () => {
  const run = createRun();
  const out = playClaim(run, {
    seat: "player1",
    tile: run.liveTile,
    atMs: run.deadlineMs + TAP_GRACE_MS + 1,
  });
  assert.equal(out.accepted, false);
  assert.equal(out.reason, "Too slow — the tile expired");
  // Nobody scored, both lost a life, and the run moved on.
  assert.equal(out.run.p1Tiles, 0);
  assert.equal(out.run.p2Tiles, 0);
  assert.equal(out.run.p1Lives, STARTING_LIVES - 1);
  assert.equal(out.run.p2Lives, STARTING_LIVES - 1);
  assert.equal(out.run.log[0].outcome, "both_miss");
});

test("a both-miss resolves even when nobody ever taps (no stall)", () => {
  let run = createRun();
  const seen = new Set([run.liveTile]);
  for (let i = 0; i < 3; i += 1) {
    run = resolveBothMiss(run, run.deadlineMs + TAP_GRACE_MS + 1);
    if (run.result) break;
    seen.add(run.liveTile);
  }
  // Three consecutive misses cost each player their whole life bar.
  assert.equal(run.p1Lives, 0);
  assert.equal(run.p2Lives, 0);
  assert.equal(run.result, RESULT.DRAW);
  assert.equal(seen.size, 3, "each miss should have lit a fresh tile");
});

// ════════════════════════════════════════════════════════════════════
// Exhaustion + reconnection
// ════════════════════════════════════════════════════════════════════

test("an exhausted board settles on lives, then tiles", () => {
  const exhausted = {
    ...createRun(),
    p1Lives: 2,
    p2Lives: 1,
    p1Tiles: 1,
    p2Tiles: 2,
    used: Array.from({ length: KENO_POOL_SIZE }, (_, i) => i + 1),
  };
  const out = settle(exhausted, { exhausted: true, now: 10_000 });
  assert.equal(out.result, RESULT.PLAYER1);
  assert.equal(out.endedExhausted, true);
});

test("every piece of run state a reconnecting client needs is on the row", () => {
  for (const column of [
    "p1Lives",
    "p2Lives",
    "p1Tiles",
    "p2Tiles",
    "liveTile",
    "liveTileIndex",
    "liveStartedAt",
    "usedTiles",
    "tileLog",
  ]) {
    assert.ok(store.includes(column), `serverStore never touches ${column}`);
  }
  // …and the GET payload exposes the run without leaking the draw seed.
  for (const field of [
    "p1Lives",
    "p2Lives",
    "p1Tiles",
    "p2Tiles",
    "liveTile",
    "liveTileIndex",
    "liveStartedAt",
    "liveDeadline",
    "windowMs",
    "tapGraceMs",
    "tileLog",
    "viewerCanClaim",
  ]) {
    assert.ok(matchRoute.includes(field), `match payload is missing ${field}`);
  }
  assert.ok(!matchRoute.includes("usedTiles:") , "the raw draw list must not be sent");
  assert.ok(!matchRoute.includes("runSeed"), "the draw seed must never be sent");
});

// ════════════════════════════════════════════════════════════════════
// Server-side guard contracts (exact ordering)
// ════════════════════════════════════════════════════════════════════

const claimBody = store.slice(
  store.indexOf("export async function claimTile("),
  store.indexOf("// ── Server AI"),
);
const autoResolveBody = store.slice(
  store.indexOf("export async function fetchMatchWithAutoResolve("),
  store.indexOf("// The survival duel has no hidden per-player state"),
);
const aiBody = store.slice(
  store.indexOf("async function playAiTurnInTransaction("),
  store.indexOf("export async function playAiTurn("),
);

test("claimTile locks the row, then checks participation, liveness and the tile identity", () => {
  assert.ok(claimBody.includes("await fetchMatchForUpdate(tx, matchId)"));
  assert.ok(claimBody.includes('isParticipant(match, userId)'));
  assert.ok(claimBody.includes("LIVE_STATES.has(match.status)"));
  assert.ok(claimBody.includes("hasLiveTile(match)"));
  const identityAt = claimBody.indexOf("tileNumber !== Number(match.liveTile)");
  const windowAt = claimBody.indexOf("isClaimInWindow({");
  assert.ok(identityAt > 0, "claimTile never checks the live tile identity");
  assert.ok(windowAt > identityAt, "the window must be graded after the tile identity");
  // FOR UPDATE is what makes "first tap wins" atomic.
  assert.ok(
    store.indexOf('.for("update")') > 0 &&
      store.indexOf("async function fetchMatchForUpdate") < store.indexOf("export async function claimTile("),
    "claimTile must run behind the row lock",
  );
});

test("a rejected claim resolves the both-miss rather than leaving the run stuck", () => {
  assert.ok(
    claimBody.includes("resolveExpiredLiveTile(tx, match, { now })"),
    "a late/expired claim must resolve the miss",
  );
  // The late path is only taken once the grace has definitely passed.
  assert.ok(claimBody.includes("now > deadlineMs + TAP_GRACE_MS"));
  assert.ok(claimBody.includes("isClaimInWindow({ atMs: now, startedMs, deadlineMs })"));
});

test("one shared resolution path handles claims and misses", () => {
  assert.ok(store.includes("async function applyResolution("));
  const calls = store.match(/await applyResolution\(tx, match, \{/g) || [];
  assert.ok(calls.length >= 3, "claim / both-miss / bot must share applyResolution");
  assert.ok(
    store.includes("decideSurvivalResult({"),
    "the result must come from the shared survival decision",
  );
  assert.ok(store.includes("tileWindowMs(p1Tiles + p2Tiles)"));
});

test("auto-resolve lights the run, runs the bot, then expires the tile — in that order", () => {
  const lightAt = autoResolveBody.indexOf("lightNextTile(tx, current, { reset: true })");
  const aiAt = autoResolveBody.indexOf("playAiTurnInTransaction(tx, current)");
  const expireAt = autoResolveBody.indexOf("resolveExpiredLiveTile(tx, current");
  assert.ok(lightAt > 0 && aiAt > lightAt, "the bot must run after the run lights up");
  assert.ok(expireAt > aiAt, "a due bot tap must be graded before the both-miss");
});

test("the bot obeys the same clock and window as a human", () => {
  assert.ok(aiBody.includes("TAP_GRACE_MS"));
  assert.ok(aiBody.includes("chooseAiClaim({"));
  assert.ok(aiBody.includes("now < plan.dueAtMs"));
  assert.ok(aiBody.includes('claimantSeat: "player2"'));
  assert.ok(aiBody.includes("applyResolution(tx, match, {"));
});

test("settlement clears the live tile and pays the winner", () => {
  const settleBody = store.slice(
    store.indexOf("async function settleMatch("),
    store.indexOf("// Best-effort stat side-effect"),
  );
  assert.ok(settleBody.includes("status: MATCH_STATUS.FINISHED"));
  assert.ok(settleBody.includes("liveTile: null"));
  assert.ok(settleBody.includes("liveStartedAt: null"));
  assert.ok(settleBody.includes("roundDeadline: null"));
  assert.ok(settleBody.includes("computePayout({ stakeAmount: match.stakeAmount, result: finalResult })"));
  assert.ok(settleBody.includes("recordPvPResult("));
});

test("the forfeit path hands the match to the opponent without touching the rules", () => {
  const forfeitBody = store.slice(
    store.indexOf("export async function forfeitMatch("),
    store.indexOf("// ── Raw read (no auto-resolve)"),
  );
  assert.ok(forfeitBody.includes("RESULT.PLAYER2"));
  assert.ok(forfeitBody.includes("RESULT.PLAYER1"));
  assert.ok(forfeitBody.includes("computePayout({ stakeAmount: match.stakeAmount, result })"));
  const forfeitSection = store.slice(
    store.indexOf("export async function forfeitMatch("),
    store.indexOf("// ── Raw read (no auto-resolve)"),
  );
  assert.ok(!forfeitSection.includes("POINTS_TO_WIN"));
});

test("the claim route keeps the action idempotent-friendly shape", () => {
  assert.ok(claimRoute.includes("claimTile({ userId, matchId, tile })"));
  assert.ok(claimRoute.includes("body?.tile ?? body?.ball"), "the old field must still be tolerated");
  assert.ok(claimRoute.includes("broadcastMatchUpdate(matchId"));
  assert.ok(claimRoute.includes("status: result.status || 400"));
});

// ════════════════════════════════════════════════════════════════════
// Client contracts
// ════════════════════════════════════════════════════════════════════

test("the client only ever posts a tap on the tile the SERVER says is live", () => {
  assert.ok(page.includes("if (tileNumber !== Number(match?.liveTile)) return;"));
  assert.ok(page.includes("body: JSON.stringify({ tile: tileNumber })"));
  // A tap past the window (plus the grace) is never even sent.
  assert.ok(page.includes("Date.now() + clockOffset > deadline + grace"));
  // One in-flight claim at a time.
  assert.ok(page.includes("claimingRef.current"));
});

test("the client never invents game state — lives/tiles/board all come from the payload", () => {
  assert.ok(page.includes("myClaimedSet") && page.includes("oppClaimedSet"));
  assert.ok(page.includes("match.tileLog"));
  // No local life arithmetic anywhere.
  assert.ok(!/p1Lives\s*-\s*1/.test(page), "the client must not decrement lives itself");
  assert.ok(!/p2Lives\s*-\s*1/.test(page), "the client must not decrement lives itself");
  assert.ok(!page.includes("setLives"), "the client must not hold a local life counter");
  // The window is derived from the server deadline + the server clock.
  assert.ok(page.includes("windowRemainingMs({ deadlineMs: liveDeadlineMs, atMs: serverNow })"));
  assert.ok(page.includes("clockOffset"));
});

test("the client shows both seats' lives, the window and the claimed tiles", () => {
  assert.ok(page.includes("LivesPips"));
  assert.ok(page.includes("{tiles} claimed"));
  assert.ok(page.includes("window") && page.includes("liveTile"));
  assert.ok(page.includes("feedLineFor"));
  assert.ok(page.includes("Nobody claimed tile"));
});

test("the client renders untouched tiles identically (no information leak)", () => {
  // One class chain per state, and the fallback state is a single shared
  // style for every tile that is not live / claimed / missed.
  assert.ok(page.includes('let cls = "bg-[#0b224f] border border-[#00e5ff]/20 text-white/40 cursor-default";'));
  assert.ok(/Tile \$\{num\}/.test(page), "an untouched tile must only be labelled by its number");
  // Tiles are disabled unless they are the live tile.
  assert.ok(page.includes("const disabled = frozen || !isLive;"));
});

// ════════════════════════════════════════════════════════════════════
// The old mechanics are gone
// ════════════════════════════════════════════════════════════════════

test("no first-to-10 / points / multiplier / multi-round code survives", () => {
  const sources = {
    "serverStore.js": store,
    "engine.js": engine,
    "catch/route.js": claimRoute,
    "match/route.js": matchRoute,
    "keno-pvp client": page,
    "keno lobby": lobby,
  };
  const banned = [
    "POINTS_TO_WIN",
    "MAX_ROUNDS",
    "ROUND_MS",
    "ballSchedule",
    "gradeCatch",
    "computeRoundStats",
    "decideRoundWinner",
    "decideMatchResult",
    "CATCH_QUALITY",
    "GLOW_MS",
    "OVERTIME_MS",
    "MATCH_TIME_LIMIT_MS",
  ];
  for (const [name, source] of Object.entries(sources)) {
    for (const token of banned) {
      assert.ok(!source.includes(token), `${name} still references ${token}`);
    }
  }
  for (const phrase of ["First to 10 points", "first to 10 points", "overtime"]) {
    assert.ok(!page.includes(phrase), `keno-pvp client still mentions "${phrase}"`);
    assert.ok(!lobby.includes(phrase), `keno lobby still mentions "${phrase}"`);
  }
});

test("the live run is one phase — nothing advances a round number", () => {
  assert.ok(!/status:\s*statusForRoundNumber/.test(store));
  assert.ok(!store.includes("currentRound: roundNumber"));
  assert.ok(store.includes("liveTileIndex"));
  // The DB enum is untouched: the live run reuses round_1.
  assert.ok(constants.includes('LIVE: "round_1"'));
  assert.ok(store.includes("status: MATCH_STATUS.LIVE"));
  // The enum itself is never altered (only commented about): no ALTER TYPE
  // statement and no new enum value anywhere in the migration.
  const migration = read("src/db/migrations/0164_keno_survival_duel.sql");
  assert.ok(!/^\s*ALTER\s+TYPE/m.test(migration));
  assert.ok(!/ADD\s+VALUE\s+'/i.test(migration));
});

test("the migration is additive and settles in-flight legacy rows", () => {
  const migration = read("src/db/migrations/0164_keno_survival_duel.sql");
  for (const column of [
    "p1_lives",
    "p2_lives",
    "p1_tiles",
    "p2_tiles",
    "live_tile",
    "live_tile_index",
    "live_started_at",
    "used_tiles",
    "tile_log",
  ]) {
    assert.ok(
      migration.includes(`ADD COLUMN IF NOT EXISTS "${column}"`),
      `migration is missing ${column}`,
    );
  }
  assert.ok(migration.includes('"status" = \'finished\''));
  assert.ok(migration.includes('"result" = \'draw\''));
  assert.ok(migration.includes('"balance" = u."balance" + r."stake_amount"'));
  assert.ok(!/DROP COLUMN/i.test(migration), "the migration must not drop legacy columns");
});
