/**
 * PvP Keno ("Keno Survival Duel") — flow + race-safety tests.
 *
 * `tests/keno-pvp-engine.test.mjs` proves the pure RULES. This file covers
 * what those rules mean for a live duel, on both sides of the wire:
 *
 *   • a full run, from the first lit tile to a 3-lives-claimed win;
 *   • duplicate / stale tile taps (one tap per player per tile);
 *   • two claims on the same tile: BOTH players keep their lives, the
 *     faster one is credited the tile (row lock + the live-tile identity
 *     gate);
 *   • a tap that arrives after the window (not a claim — your own miss is
 *     resolved instead, so the match never stalls);
 *   • a tap inside the hidden network grace tail;
 *   • a miss that costs ONLY the player who did not tap;
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
  applyMissesToLives,
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
const waitingPanel = read("src/components/keno-pvp/KenoWaitingPanel.jsx");
const lobby = read("src/app/casino/keno/PageClient.jsx");

const SEED = "keno-pvp:99";

// ════════════════════════════════════════════════════════════════════
// A driver that plays the run exactly as `claimTile` / `resolveLiveTile`
// resolve it — the rules, not the DB. A tile stays lit until its window
// closes (or until BOTH players have tapped), so the driver keeps a
// per-player tap record for the tile that is currently live.
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
    // Who has already tapped the tile that is lit RIGHT NOW.
    taps: { p1: false, p2: false, p1Ms: null, p2Ms: null },
    log: [],
    result: null,
  };
}

const NO_TAPS = () => ({ p1: false, p2: false, p1Ms: null, p2Ms: null });

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

// Resolve the lit tile at `now`, exactly as `resolveLiveTile` does: a life
// is lost by whichever player never tapped it, the tile credit goes to the
// faster of the tappers (only one credit per tile), and the window for the
// next tile tightens by the number of tiles claimed so far.
function resolveLiveTile(run, now) {
  const taps = run.taps || NO_TAPS();
  const p1Claimed = Boolean(taps.p1);
  const p2Claimed = Boolean(taps.p2);
  const lives = applyMissesToLives({
    p1Lives: run.p1Lives,
    p2Lives: run.p2Lives,
    p1Missed: !p1Claimed,
    p2Missed: !p2Claimed,
  });
  const outcome =
    p1Claimed && p2Claimed
      ? "both_claim"
      : p1Claimed
        ? "player1"
        : p2Claimed
          ? "player2"
          : "both_miss";
  const reactions = [taps.p1Ms, taps.p2Ms].filter((v) => v != null);
  const entry = tileLogEntry({
    tile: run.liveTile,
    index: run.index,
    outcome,
    at: now,
    ...lives,
    windowMs: run.windowMs,
    reactionMs: reactions.length ? Math.min(...reactions) : null,
    p1Claimed,
    p2Claimed,
    p1ReactionMs: taps.p1Ms ?? null,
    p2ReactionMs: taps.p2Ms ?? null,
  });
  // One credit per tile: the faster tap takes it. A tile only the opponent
  // tapped is theirs; a both-claim is decided by reaction time.
  let p1Tiles = run.p1Tiles;
  let p2Tiles = run.p2Tiles;
  if (p1Claimed && p2Claimed) {
    if (taps.p1Ms <= taps.p2Ms) p1Tiles += 1;
    else p2Tiles += 1;
  } else if (p1Claimed) p1Tiles += 1;
  else if (p2Claimed) p2Tiles += 1;

  const next = {
    ...run,
    ...lives,
    p1Tiles,
    p2Tiles,
    taps: NO_TAPS(),
    log: [...run.log, entry],
  };
  const result = decideSurvivalResult(next);
  if (result) return { ...next, result };
  return lightNext(next, now);
}

function resolveBothMiss(run, now) {
  // A both-miss IS the no-tap resolution.
  return resolveLiveTile({ ...run, taps: NO_TAPS() }, now);
}

function playClaim(run, { seat, tile, atMs }) {
  if (run.result) return { accepted: false, reason: "Match is over", run };
  if (tile !== run.liveTile) {
    // Not the lit tile. If its window has already closed the miss resolves.
    if (atMs > run.deadlineMs + TAP_GRACE_MS) {
      return { accepted: false, reason: "That tile is no longer live", run: resolveLiveTile(run, atMs) };
    }
    return { accepted: false, reason: "That tile is not live", run };
  }
  if (atMs < run.startedMs) {
    return { accepted: false, reason: "Tile is not live yet", run };
  }
  if (!isClaimInWindow({ atMs, startedMs: run.startedMs, deadlineMs: run.deadlineMs })) {
    // The window closed before this tap arrived: the tap is void, but this
    // player still tapped nothing, so THEIR miss resolves here.
    return { accepted: false, reason: "Too slow — the tile expired", run: resolveLiveTile(run, atMs) };
  }

  const seatKey = seat === "player1" ? "p1" : "p2";
  const prior = run.taps || NO_TAPS();
  if (prior[seatKey]) {
    return { accepted: false, reason: "You already tapped this tile", run };
  }
  const theirKey = seat === "player1" ? "p2" : "p1";
  const reactionMs = Math.max(0, atMs - run.startedMs);
  const taps = { ...prior, [seatKey]: true, [`${seatKey}Ms`]: reactionMs };
  const credited = !prior[theirKey] || reactionMs <= (prior[`${theirKey}Ms`] ?? Infinity);
  const next = { ...run, taps };

  // Both players have tapped → nothing left can change, so resolve now
  // rather than making them sit out the rest of the window.
  if (taps.p1 && taps.p2) {
    return { accepted: true, credited, run: resolveLiveTile(next, atMs) };
  }
  return { accepted: true, credited, run: next };
}

// ════════════════════════════════════════════════════════════════════
// The run
// ════════════════════════════════════════════════════════════════════

test("a run starts at 3 lives each with a 3s window and one lit tile", () => {
  const run = createRun();
  assert.equal(run.p1Lives, STARTING_LIVES);
  assert.equal(run.p2Lives, STARTING_LIVES);
  assert.equal(run.windowMs, START_WINDOW_MS);
  assert.ok(run.liveTile >= 1 && run.liveTile <= KENO_POOL_SIZE);
  assert.equal(run.used.length, 1);
  assert.equal(run.result, null);
});

test("tapping every tile wins — the opponent's OWN misses end the run", () => {
  // The only way to lose a life is to miss a tile yourself, so a player who
  // taps every tile keeps all three lives and outlasts an opponent who
  // never taps. Their claim costs the opponent nothing directly.
  let run = createRun();
  for (let i = 0; i < STARTING_LIVES; i += 1) {
    const out = playClaim(run, {
      seat: "player1",
      tile: run.liveTile,
      atMs: run.startedMs + 250,
    });
    assert.equal(out.accepted, true, `claim ${i} was rejected: ${out.reason}`);
    assert.equal(out.credited, true, `claim ${i} was not credited`);
    // The tile stays lit until the window closes, then resolves as this
    // player's claim and the opponent's miss.
    run = resolveLiveTile(out.run, out.run.deadlineMs + TAP_GRACE_MS + 1);
    if (run.result) break;
  }
  assert.equal(run.p1Tiles, STARTING_LIVES);
  assert.equal(run.p2Tiles, 0);
  assert.equal(run.p1Lives, STARTING_LIVES, "claiming the tile costs the claimant nothing");
  assert.equal(run.p2Lives, 0, "three own misses cost the idle player three lives");
  assert.equal(run.result, RESULT.PLAYER1);
  assert.equal(run.log.length, STARTING_LIVES);
  assert.equal(run.log[run.log.length - 1].p2Lives, 0);
  // …and the opponent's claim never happened on any of those tiles.
  assert.ok(run.log.every((e) => e.p1Claimed === true && e.p2Claimed === false));
});

test("a claim while the OPPONENT also taps costs the claimant nothing", () => {
  let run = createRun();
  const first = playClaim(run, { seat: "player1", tile: run.liveTile, atMs: run.startedMs + 120 });
  assert.equal(first.accepted, true);
  assert.equal(first.credited, true, "the faster tap takes the credit");
  run = first.run;
  // The tile is still live: the second player may still save their life.
  assert.equal(run.liveTile, first.run.liveTile);
  const second = playClaim(run, { seat: "player2", tile: run.liveTile, atMs: run.startedMs + 260 });
  assert.equal(second.accepted, true, "a slower tap still counts as your tap");
  assert.equal(second.credited, false, "the credit belongs to the faster tap");
  run = second.run;
  assert.equal(run.log[0].outcome, "both_claim");
  assert.equal(run.p1Lives, STARTING_LIVES, "claiming never costs the opponent a life");
  assert.equal(run.p2Lives, STARTING_LIVES, "and the slower tap saved their own life");
  assert.equal(run.p1Tiles + run.p2Tiles, 1, "exactly one tile is credited");
  assert.equal(run.p1Tiles, 1);
});

test("the window tightens with every claimed tile, never below the floor", () => {
  // A long life bar so the run cannot end before the floor is reached —
  // this test is about the window, not about elimination. Both players tap
  // each tile, which resolves it immediately and tightens the next window.
  let run = { ...createRun(), p1Lives: 99, p2Lives: 99 };
  const windows = [run.windowMs];
  for (let i = 0; i < 30; i += 1) {
    const tile = run.liveTile;
    const started = run.startedMs;
    const a = playClaim(run, { seat: "player1", tile, atMs: started + 200 });
    assert.equal(a.accepted, true, `claim ${i}/a was rejected: ${a.reason}`);
    const b = playClaim(a.run, { seat: "player2", tile, atMs: started + 300 });
    assert.equal(b.accepted, true, `claim ${i}/b was rejected: ${b.reason}`);
    run = b.run;
    // Both tapped → nobody loses a life, which keeps the run alive.
    assert.equal(run.p1Lives, 99);
    assert.equal(run.p2Lives, 99);
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
  const run = createRun();
  const before = run.windowMs;
  const after = resolveBothMiss(run, run.deadlineMs + TAP_GRACE_MS + 1);
  assert.equal(after.p1Lives, STARTING_LIVES - 1, "a no-tap tile is a miss for both");
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

test("a duplicate tap by the SAME player is refused (and never doubles a life)", () => {
  let run = createRun();
  const tile = run.liveTile;
  const started = run.startedMs;
  const first = playClaim(run, { seat: "player1", tile, atMs: started + 150 });
  assert.equal(first.accepted, true);
  run = first.run;
  // The same tile number again (a double tap / a retried POST). The tile is
  // still live — only player1 has tapped it — so the guard is per-player.
  const second = playClaim(run, { seat: "player1", tile, atMs: started + 160 });
  assert.equal(second.accepted, false);
  assert.equal(second.reason, "You already tapped this tile");
  assert.equal(second.run.taps.p1Ms, 150, "the first reaction must survive");
  assert.equal(second.run.log.length, 0, "a retried tap must not resolve the tile");
  // …and the opponent can still tap it, saving their own life.
  const other = playClaim(second.run, { seat: "player2", tile, atMs: started + 300 });
  assert.equal(other.accepted, true);
  assert.equal(other.run.log[0].outcome, "both_claim");
  assert.equal(other.run.p2Lives, STARTING_LIVES, "the second tap rescued their life");
});

test("two simultaneous claims: both lives are safe, the faster tap takes the tile", () => {
  const run = createRun();
  const tile = run.liveTile;
  const at = run.startedMs + 300;
  // The store serves simultaneous taps one at a time behind SELECT … FOR
  // UPDATE, so the second request always sees the state the first wrote —
  // and may still record its own tap (it no longer loses a life for it).
  const a = playClaim(run, { seat: "player1", tile, atMs: at });
  assert.equal(a.accepted, true);
  const b = playClaim(a.run, { seat: "player2", tile, atMs: at });
  assert.equal(b.accepted, true);
  // Nobody lost a life; exactly one tile was credited.
  assert.equal(b.run.p1Lives, STARTING_LIVES);
  assert.equal(b.run.p2Lives, STARTING_LIVES);
  assert.equal(b.run.p1Tiles + b.run.p2Tiles, 1);
  // A tie on reaction time credits player1 (the driver's tie-break).
  assert.equal(b.run.log[0].outcome, "both_claim");
  // And the next tile is different from the one that was just resolved.
  assert.notEqual(b.run.liveTile, tile);
});

test("a tap while no tile is lit yet cannot score", () => {
  const run = createRun();
  const early = playClaim(run, { seat: "player1", tile: run.liveTile, atMs: -10 });
  assert.equal(early.accepted, false);
  assert.equal(early.reason, "Tile is not live yet");
  assert.equal(early.run.log.length, 0);
});

test("a tap inside the hidden grace tail still saves your life", () => {
  const run = createRun();
  const at = run.deadlineMs + TAP_GRACE_MS; // exactly the grace edge
  const out = playClaim(run, { seat: "player1", tile: run.liveTile, atMs: at });
  assert.equal(out.accepted, true);
  const after = resolveLiveTile(out.run, out.run.deadlineMs + TAP_GRACE_MS + 1);
  assert.equal(after.p1Lives, STARTING_LIVES, "a tap in the grace tail is a real tap");
  assert.equal(after.p1Tiles, 1);
  // The opponent never tapped, so the tile is their miss.
  assert.equal(after.p2Lives, STARTING_LIVES - 1);
});

test("a tap past the window is not a claim — the miss resolves instead", () => {
  const run = createRun();
  const out = playClaim(run, {
    seat: "player1",
    tile: run.liveTile,
    atMs: run.deadlineMs + TAP_GRACE_MS + 1,
  });
  assert.equal(out.accepted, false);
  assert.equal(out.reason, "Too slow — the tile expired");
  // Nothing scored. Both players were exposed to that tile and neither
  // tapped it inside the window, so both lose a life and the run moves on.
  assert.equal(out.run.p1Tiles, 0);
  assert.equal(out.run.p2Tiles, 0);
  assert.equal(out.run.p1Lives, STARTING_LIVES - 1);
  assert.equal(out.run.p2Lives, STARTING_LIVES - 1);
  assert.equal(out.run.log[0].outcome, "both_miss");
  assert.equal(out.run.log[0].p1Claimed, false);
  assert.equal(out.run.log[0].p2Claimed, false);
});

test("only the player who missed loses the life — a late tap on a taken tile stings just them", () => {
  const run = createRun();
  const tile = run.liveTile;
  const started = run.startedMs;
  // Player2 taps in time; player1 tries after the window closed.
  const p2 = playClaim(run, { seat: "player2", tile, atMs: started + 120 });
  assert.equal(p2.accepted, true);
  const late = playClaim(p2.run, {
    seat: "player1",
    tile,
    atMs: p2.run.deadlineMs + TAP_GRACE_MS + 1,
  });
  assert.equal(late.accepted, false);
  assert.equal(late.reason, "Too slow — the tile expired");
  // The tapper kept all three lives; only the late player paid.
  assert.equal(late.run.log[0].outcome, "player2");
  assert.equal(late.run.log[0].p1Claimed, false);
  assert.equal(late.run.log[0].p2Claimed, true);
  assert.equal(late.run.p2Lives, STARTING_LIVES);
  assert.equal(late.run.p1Lives, STARTING_LIVES - 1);
  assert.equal(late.run.p2Tiles, 1);
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
const aiPlanBody = store.slice(
  store.indexOf("function aiPlanFor("),
  store.indexOf("// ── Record one player's tap on the live tile"),
);
const missBody = store.slice(
  store.indexOf("async function resolveLiveTile("),
  store.indexOf("// ── claimTile (the main action)"),
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

test("a rejected claim resolves the miss rather than leaving the run stuck", () => {
  assert.ok(
    claimBody.includes("resolveLiveTile(tx, match, { now })"),
    "a late/expired claim must resolve the miss",
  );
  // The late path is only taken once the grace has definitely passed.
  assert.ok(claimBody.includes("now > deadlineMs + TAP_GRACE_MS"));
  assert.ok(claimBody.includes("isClaimInWindow({ atMs: now, startedMs, deadlineMs })"));
});

test("a claim never touches the opponent's lives — only their own miss does", () => {
  // The lives come from the per-player tap flags, so applying a claim can
  // never decrement anything by itself.
  assert.ok(
    store.includes("p1Missed: !taps.p1") && store.includes("p2Missed: !taps.p2"),
    "lives must be derived from who did NOT tap",
  );
  assert.ok(
    !/claimantSeat/.test(store),
    "the retired claimant-loses-a-life rule must be gone from the store",
  );
  // And a tap that lands after the opponent's is accepted, not rejected: it
  // only loses the tile CREDIT.
  assert.ok(claimBody.includes("const credited = !mine && !theirs;"));
  assert.ok(
    claimBody.includes("persistTap(tx, current, { seat, reactionMs, credit: credited })"),
    "every in-window tap is recorded, credited or not",
  );
});

test("one shared resolution path handles claims, misses and the bot", () => {
  assert.ok(store.includes("async function applyResolution("));
  // Every tile — claimed, missed, or resolved by the bot's due tap — is
  // graded through resolveLiveTile, which is the only caller of
  // applyResolution.
  assert.ok(
    missBody.includes("await applyResolution(tx, current, {"),
    "resolveLiveTile must be the single resolution path",
  );
  const callers = store.match(/resolveLiveTile\(tx, /g) || [];
  assert.ok(callers.length >= 2, "claim / miss paths must share resolveLiveTile");
  assert.ok(
    store.includes("decideSurvivalResult({"),
    "the result must come from the shared survival decision",
  );
  assert.ok(store.includes("tileWindowMs(p1Tiles + p2Tiles)"));
  assert.ok(store.includes("applyMissesToLives({"));
});

test("auto-resolve lights the run, runs the bot, then expires the tile — in that order", () => {
  const lightAt = autoResolveBody.indexOf("lightNextTile(tx, current, { reset: true })");
  const aiAt = autoResolveBody.indexOf("playAiTurnInTransaction(tx, current)");
  const expireAt = autoResolveBody.indexOf("resolveLiveTile(tx, current");
  assert.ok(lightAt > 0 && aiAt > lightAt, "the bot must run after the run lights up");
  assert.ok(expireAt > aiAt, "a due bot tap must be graded before the both-miss");
});

test("the bot's tap is an INSTANT inside the tile's window, not a request", () => {
  // The plan carries the instant the bot tapped, derived from the same live
  // window a human is graded against…
  assert.ok(aiPlanBody.includes("chooseAiClaim({"));
  assert.ok(aiPlanBody.includes("tileWindowMs("), "the plan must use the live window");
  assert.ok(
    aiPlanBody.includes("if (!plan.claims || plan.dueAtMs == null) return null;"),
    "a declined plan is not a claim at all",
  );
  // …and that instant — never the moment the server happened to be read — is
  // what is written down, on both the human-claim path and the miss path.
  assert.ok(
    claimBody.includes("aiPlan.dueAtMs <= now"),
    "the human-claim path must grade the bot by its instant",
  );
  assert.ok(claimBody.includes("reactionMs: aiPlan.reactionMs"));
  assert.ok(
    missBody.includes("plan.dueAtMs <= now"),
    "the miss path must record a due bot tap before charging a both-miss",
  );
  assert.ok(missBody.includes("reactionMs: plan.reactionMs"));
  assert.ok(missBody.includes('seat: "player2"'), "the bot is always player2");
  assert.ok(store.includes("applyResolution(tx, current, {"));
});

test("the bot's due tap takes the tile CREDIT but never the human's life", () => {
  // A human tap that arrives after the bot's instant still lands — it just
  // does not take the tile. The bot's instant is graded first, so the human
  // tap the store writes is always recorded against the bot's.
  const aiRaceAt = claimBody.indexOf("aiPlanFor(current)");
  const humanTapAt = claimBody.indexOf(
    "persistTap(tx, current, { seat, reactionMs, credit: credited })",
  );
  assert.ok(aiRaceAt > 0, "claimTile never grades the human tap against the bot's instant");
  assert.ok(
    humanTapAt > aiRaceAt,
    "the bot's instant must be recorded BEFORE the human's tap, so the credit is decided against it",
  );
  // The human's tap still lands: the race only decides the credit.
  assert.ok(claimBody.includes("aiGotThereFirst"));
  assert.ok(
    claimBody.includes("aiClaimed: aiGotThereFirst"),
    "the payload must report the bot's claim rather than rejecting the tap",
  );
  // …and the bot's own miss is resolved the same way a human's is: the miss
  // path records the bot's due tap first, then charges only the players who
  // actually failed to tap.
  assert.ok(missBody.includes("aiPlanFor(current)"), "the miss path never checks the bot's plan");
  assert.ok(
    missBody.indexOf("aiPlanFor(current)") < missBody.indexOf("applyMissesToLives({"),
    "the bot's due tap must be recorded before the own-miss lives are applied",
  );
  assert.ok(missBody.includes("p1Missed: !taps.p1"));
});

test("the client keeps asking the server to run the bot while its tile is live", () => {
  // The bot's plan decides WHO wins a tile (the store grades its tap at its
  // own instant), but nothing runs the bot until the server is read — so
  // without this sweep the bot's claim would only ever appear on the next
  // poll, up to 5s later, with a both-miss resolving tiles in between. The
  // sweep is what makes the bot's tap land promptly in a free AI match
  // (200–420ms into the tile); the 5s backstop poll and the deadline nudge
  // both land too late to drive the board.
  // Slice out just the sweep effect (it sits directly above the socket
  // listener), so the assertions can't be satisfied by an unrelated poll.
  const sweepStart = page.indexOf("Free practice: let the bot actually take its turn");
  assert.ok(sweepStart > 0, "the bot sweep effect is missing entirely");
  const probeBody = page.slice(sweepStart, page.indexOf("// Socket live-update"));
  assert.ok(
    probeBody.includes("AI_TURN_PROBE_OFFSETS_MS.map(") &&
      probeBody.includes("setTimeout(probe, offset)"),
    "the page must schedule its asks for the bot",
  );
  assert.ok(
    probeBody.includes("/ai-turn"),
    "the sweep drives the bot through the ai-turn route",
  );
  assert.ok(
    probeBody.includes("Number(json.data?.actions) > 0") &&
      probeBody.includes("fetchStatus()"),
    "a bot tap repaints the board",
  );
  // Scoped: free AI matches only, only while a live tile is on the board, and
  // only for the human seat — a human duel keeps its single 5s poll.
  assert.ok(
    probeBody.includes("!match?.isAi || !match?.viewerIsPlayer1"),
    "only the human seat of a free AI match sweeps",
  );
  assert.ok(
    probeBody.includes("!match?.viewerCanClaim"),
    "the sweep only runs while a live tile is claimable",
  );
  // The burst has to span the bot's whole reaction band — 200ms floor, 420ms
  // ceiling (AI_MIN_REACTION_MS + AI_REACTION_JITTER_MS) — or a probe can step
  // over the window and the bot never gets its turn.
  const offsets = (page.match(/AI_TURN_PROBE_OFFSETS_MS = \[([^\]]+)\]/) || [])[1];
  const probeOffsets = (offsets || "")
    .split(",")
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n));
  assert.ok(probeOffsets.length >= 3, "the burst must have several probes");
  assert.ok(
    Math.max(...probeOffsets) >= 420,
    "the last probe must land after the bot's slowest possible reaction",
  );
  assert.ok(
    Math.min(...probeOffsets) <= 200,
    "the first waited probe must land inside the bot's fastest reaction band",
  );
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
  // Stakes are retired: settlement records zeroed money columns and never
  // touches a token balance.
  assert.ok(settleBody.includes('houseFee: "0.00"'));
  assert.ok(settleBody.includes('prizePaid: "0.00"'));
  assert.ok(!settleBody.includes("users.balance"));
  assert.ok(settleBody.includes("recordPvPResult("));
});

test("the forfeit path hands the match to the opponent without touching the rules", () => {
  const forfeitBody = store.slice(
    store.indexOf("export async function forfeitMatch("),
    store.indexOf("// ── Raw read (no auto-resolve)"),
  );
  assert.ok(forfeitBody.includes("RESULT.PLAYER2"));
  assert.ok(forfeitBody.includes("RESULT.PLAYER1"));
  assert.ok(forfeitBody.includes('houseFee: "0.00"'));
  assert.ok(forfeitBody.includes('prizePaid: "0.00"'));
  assert.ok(!forfeitBody.includes("users.balance"));
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
  assert.ok(page.includes("went unclaimed"));
  // The feed tells the viewer that only THEIR miss cost a life.
  assert.ok(page.includes("you missed it and lost a life"));
});

test("the client shows a tapped live tile as SAFE instead of looking stuck", () => {
  // The tile stays lit for the whole window now, so a tap that landed has to
  // be visible: the board paints it green and stops accepting taps.
  assert.ok(page.includes("savedByMe"));
  assert.ok(
    page.includes("const iAmSafeOnLiveTile = Boolean(liveTile != null && match?.myClaimedLive);"),
    "the safe state must come from the server's per-player tap flag",
  );
  assert.ok(page.includes("You tapped it — your life is safe"));
  assert.ok(page.includes("can still tap it until the window closes"));
  // A rejected second tap is not a miss — it must never flash or buzz.
  const tapMissReasons = page.slice(
    page.indexOf("const TAP_MISS_REASONS = new Set(["),
    page.indexOf("]);", page.indexOf("const TAP_MISS_REASONS = new Set([")),
  );
  assert.ok(!tapMissReasons.includes("You already tapped this tile"));
  assert.ok(!tapMissReasons.includes("GRYND AI was faster"));
});

test("the client renders the 5s get-ready countdown from the server clock", () => {
  // The waiting room reads the real ready deadline off the payload rather
  // than inventing a number, and renders it while the match is `ready`.
  assert.ok(page.includes("readyDeadline"));
  assert.ok(page.includes("readyRemainingMs={readyDeadlineMs ? readyRemainingMs : null}"));
  assert.ok(waitingPanel.includes("readyRemainingMs"));
  assert.ok(waitingPanel.includes("First tile in "));
  // …and the payload only carries it during the ready banner.
  assert.ok(
    matchRoute.includes("match.status === MATCH_STATUS.READY ? (match.roundDeadline ?? null) : null"),
    "the ready deadline must only be exposed while the match is ready",
  );
});

test("the client renders untouched tiles identically (no information leak)", () => {
  // One class chain per state, and the fallback state is a single shared
  // style for every tile that is not live / claimed / missed.
  assert.ok(page.includes('let cls = "bg-[#0b224f] border border-[#00e5ff]/20 text-white/40 cursor-default";'));
  assert.ok(/Tile \$\{num\}/.test(page), "an untouched tile must only be labelled by its number");
  // Tiles are disabled unless they are a live tile this viewer has not
  // already tapped (a tapped live tile is no longer a target).
  assert.ok(page.includes("const disabled = frozen || !isLive || savedByMe;"));
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
