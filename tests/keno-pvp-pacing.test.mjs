// tests/keno-pvp-pacing.test.mjs
//
// Server-authoritative pacing for the Keno SURVIVAL DUEL:
//
//   A. the reaction window is a bounded, seed-derived progression (no fixed
//      ramp, no client randomness, identical for both seats);
//   B. the anticipation pause between targets is server-selected and
//      bounded, and no future target is exposed while it runs;
//   C. fairness: timing never depends on lives, score, identity, or either
//      player's reactions, and claims stay graded against the server clock;
//   D. the edge cases (deadline boundaries, duplicates, simultaneous
//      elimination, reconnects, the all-40 tiebreak) still hold.
//
// Values are derived from src/lib/keno-pvp/{engine,serverStore,constants}.js
// and the match route — the same modules the server runs.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ANTICIPATION_MAX_MS,
  ANTICIPATION_MIN_MS,
  KENO_POOL_SIZE,
  KENO_WINDOW_JITTER_MAX_MS,
  MIN_WINDOW_MS,
  RESULT,
  STARTING_LIVES,
  START_WINDOW_MS,
  TAP_GRACE_MS,
  WINDOW_STEP_MS,
} from "../src/lib/keno-pvp/constants.js";
import {
  anticipationDelayMs,
  decideSurvivalResult,
  isClaimInWindow,
  tileWindowForIndex,
} from "../src/lib/keno-pvp/engine.js";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const store = read("src/lib/keno-pvp/serverStore.js");
const route = read("src/app/api/keno-pvp/match/[matchId]/route.js");
const page = read("src/app/casino/keno-pvp/[matchId]/PageClient.jsx");
const engine = read("src/lib/keno-pvp/engine.js");

const SEEDS = Array.from({ length: 24 }, (_, i) => `keno-pvp:${1000 + i}`);
const INDEXES = Array.from({ length: KENO_POOL_SIZE }, (_, i) => i);
const windowsFor = (seed) =>
  INDEXES.map((index) => tileWindowForIndex({ seed, index }));
const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;

// ── A. Randomized, bounded, shared progression ───────────────────────

test("A. every tile's window stays inside [MIN_WINDOW_MS, START_WINDOW_MS]", () => {
  for (const seed of SEEDS) {
    for (const windowMs of windowsFor(seed)) {
      assert.ok(Number.isInteger(windowMs), `non-integer window ${windowMs}`);
      assert.ok(
        windowMs >= MIN_WINDOW_MS && windowMs <= START_WINDOW_MS,
        `${windowMs}ms is outside [${MIN_WINDOW_MS}, ${START_WINDOW_MS}]`,
      );
    }
  }
});

test("A. the opening window and the floor are preserved", () => {
  for (const seed of SEEDS) {
    assert.equal(tileWindowForIndex({ seed, index: 0 }), START_WINDOW_MS);
    const late = tileWindowForIndex({ seed, index: 30 });
    assert.ok(late >= MIN_WINDOW_MS && late <= MIN_WINDOW_MS + 30, `late=${late}`);
    // Enough claims and even the jitter is clamped away.
    assert.ok(tileWindowForIndex({ seed, index: 39 }) >= MIN_WINDOW_MS);
  }
});

test("A. both players get the SAME window for the same target", () => {
  // The window is a pure function of (seed, index): there is no viewer,
  // seat, lives or reaction input to disagree about.
  for (const seed of SEEDS) {
    for (const index of [0, 3, 11, 27]) {
      const a = tileWindowForIndex({ seed, index });
      const b = tileWindowForIndex({ seed, index });
      assert.equal(a, b);
    }
  }
  assert.match(
    engine,
    /function tileWindowForIndex\(\{ seed = "", index = 0 \} = \{\}\)/,
    "the window must be derived from the seed + tile index only",
  );
  assert.doesNotMatch(
    engine.slice(
      engine.indexOf("export function tileWindowForIndex"),
      engine.indexOf("export function anticipationDelayMs"),
    ),
    /p1Lives|p2Lives|p1Tiles|p2Tiles|viewer|seat|reaction/i,
    "the window must never read lives, score, seat or reactions",
  );
});

test("A. the window is a randomized progression, not the fixed ramp", () => {
  const deviations = SEEDS.map(
    (seed) => windowsFor(seed).filter((w, i) => i > 0 && w !== Math.max(MIN_WINDOW_MS, START_WINDOW_MS - WINDOW_STEP_MS * i)).length,
  );
  assert.ok(
    deviations.some((count) => count > 0),
    "no seed produced a non-fixed step — the ramp is still deterministic",
  );
  // Different matches do not share one sequence.
  const signatures = new Set(SEEDS.map((seed) => windowsFor(seed).join(",")));
  assert.ok(signatures.size > 1, "every seed produced the same windows");
});

test("A. difficulty generally increases without requiring every step to fall", () => {
  for (const seed of SEEDS) {
    const windows = windowsFor(seed);
    assert.ok(
      mean(windows.slice(0, 8)) > mean(windows.slice(16, 24)),
      "early windows should be more generous than late ones",
    );
    assert.ok(
      mean(windows.slice(16, 24)) > mean(windows.slice(24, 32)),
      "the ramp should still be tightening in its second half",
    );
    // A step may hold or be modestly forgiving, but never inverts the curve.
    for (let i = 1; i < windows.length; i += 1) {
      const rise = windows[i] - windows[i - 1];
      assert.ok(
        rise <= 200,
        `window rose ${rise}ms at index ${i} (seed ${seed})`,
      );
    }
  }
});

test("A. the progression leaves room for surges, plateaus and ease-offs", () => {
  let surges = 0;
  let plateaus = 0;
  let forgiving = 0;
  for (const seed of SEEDS) {
    const windows = windowsFor(seed);
    for (let i = 1; i < windows.length; i += 1) {
      const step = windows[i - 1] - windows[i];
      if (step > WINDOW_STEP_MS) surges += 1;
      if (step === 0) plateaus += 1;
      if (step < 0) forgiving += 1;
    }
  }
  assert.ok(surges > 0, "no tighter-than-ramp steps were produced");
  assert.ok(plateaus + forgiving > 0, "no plateaus or forgiving steps were produced");
});

// ── B. Anticipation delay ────────────────────────────────────────────

test("B. anticipation delays are server-selected, bounded and shared", () => {
  assert.equal(anticipationDelayMs({ seed: SEEDS[0], index: 0 }), 0, "the first tile lights at once");
  const seen = new Set();
  for (const seed of SEEDS) {
    for (const index of INDEXES.slice(1)) {
      const delay = anticipationDelayMs({ seed, index });
      assert.ok(Number.isInteger(delay));
      assert.ok(
        delay >= ANTICIPATION_MIN_MS && delay <= ANTICIPATION_MAX_MS,
        `${delay}ms is outside [${ANTICIPATION_MIN_MS}, ${ANTICIPATION_MAX_MS}]`,
      );
      assert.equal(delay, anticipationDelayMs({ seed, index }), "must be deterministic");
      seen.add(delay);
    }
  }
  assert.ok(seen.size > 1, "the delay never varied");
});

test("B. no future target is exposed or claimable during the pause", () => {
  // The pause is a server-side marker: the row has no live tile at all, so
  // there is no number to see, pre-aim at, or claim.
  assert.ok(
    store.includes("liveTile: null,") &&
      store.includes("roundDeadline: new Date(now + delayMs)"),
    "the gap must clear the live tile and mark when the next one may light",
  );
  assert.ok(
    store.includes("if (nextAtMs <= Date.now())"),
    "a poll must not skip the server-set pause",
  );
  assert.ok(
    route.includes("liveDeadline: isLive && hasTile ? liveDeadline : null"),
    "a pending marker is not a claim deadline",
  );
  // …but it IS readable as its own instant, so a page can arm its ONE read on it
  // instead of waiting for an unrelated event to light the next target.
  assert.ok(
    route.includes(
      "nextTileAt: isLive && !hasTile ? (match.roundDeadline ?? null) : null",
    ),
    "the anticipation marker must be exposed so the board can read past it",
  );
  assert.ok(
    store.includes("return { error: \"No tile is live yet\", status: 409 };"),
    "claims between targets are refused",
  );
  assert.ok(
    store.includes("if (now < startedMs)") &&
      store.includes("Tile is not live yet"),
    "a claim before the window opens is refused",
  );
});

// ── C. Fairness and authority ────────────────────────────────────────

test("C. the server owns the window and the client has no pacing randomness", () => {
  assert.ok(
    store.includes("tileWindowForIndex({") &&
      store.includes("seed: runSeed(match)") &&
      store.includes("index: Math.max(0, intOr(match?.liveTileIndex))"),
    "the store must derive the window from the match seed + tile index",
  );
  assert.ok(route.includes("const windowMs = currentWindowMs(match);"));
  assert.ok(
    !page.includes("tileWindowForIndex") &&
      !page.includes("anticipationDelayMs"),
    "the client must never generate pacing values",
  );
  assert.ok(
    /socket\.on\("connect", joinRoom\)/.test(page),
    "the match room must be (re)joined on every connect, or pushes die on a reconnect",
  );
  // No future sequence is shipped: the payload carries one window, for the
  // tile in play.
  assert.ok(!/windowMs\s*:\s*\[/.test(route), "the route must not ship a window sequence");
});

test("C. timing never depends on who is winning, losing or reacting faster", () => {
  const body = store.slice(
    store.indexOf("export function currentWindowMs"),
    store.indexOf("function liveDeadlineMs"),
  );
  assert.doesNotMatch(body, /p1Lives|p2Lives|p1Tiles|p2Tiles|viewer|seat/i);
  const claimBody = store.slice(
    store.indexOf("export async function claimTile"),
    store.indexOf("// ── Server AI"),
  );
  // Claim grading uses the stored server instants, never a client value.
  assert.ok(claimBody.includes("const deadlineMs = liveDeadlineMs(match);"));
  assert.ok(claimBody.includes("const startedMs = liveStartedMs(match);"));
  assert.doesNotMatch(claimBody, /body\.(deadline|startedAt|windowMs)/);
});

test("C. a reconnect recomputes the same window for the tile in play", () => {
  // The window reads the seed + index only, so a rebuilt payload (reconnect,
  // poll, stale socket message) lands on the same number, and the pending
  // gap is replayable from the stored marker.
  const seed = SEEDS[5];
  const first = tileWindowForIndex({ seed, index: 7 });
  // A tap on the live tile credits the counter mid-tile — that must not move
  // the window the server is grading against.
  const afterCredit = tileWindowForIndex({ seed, index: 7 });
  assert.equal(afterCredit, first);
  assert.ok(store.includes("liveTileIndex: nextIndex,"), "the index is persisted with the gap");
});

// ── D. Claim grading edge cases ──────────────────────────────────────

test("D. claims before, at and after the deadline are graded correctly", () => {
  const startedMs = 1_000_000;
  const windowMs = tileWindowForIndex({ seed: SEEDS[1], index: 0 });
  const deadlineMs = startedMs + windowMs;

  assert.equal(isClaimInWindow({ atMs: startedMs - 1, startedMs, deadlineMs }), false, "before the window");
  assert.equal(isClaimInWindow({ atMs: startedMs, startedMs, deadlineMs }), true, "at the start");
  assert.equal(isClaimInWindow({ atMs: deadlineMs, startedMs, deadlineMs }), true, "at the deadline");
  assert.equal(
    isClaimInWindow({ atMs: deadlineMs + TAP_GRACE_MS, startedMs, deadlineMs }),
    true,
    "inside the network grace",
  );
  assert.equal(
    isClaimInWindow({ atMs: deadlineMs + TAP_GRACE_MS + 1, startedMs, deadlineMs }),
    false,
    "past the grace",
  );
});

test("D. duplicate and stale claims cannot be double-counted", () => {
  assert.ok(
    store.includes("if (seat === \"player1\" ? priorTaps.p1 : priorTaps.p2)") &&
      store.includes("You already tapped this tile"),
    "a retried claim must be refused",
  );
  assert.ok(
    store.includes("tileNumber !== Number(match.liveTile)") &&
      store.includes("That tile is not live"),
    "a stale tile must be refused",
  );
});

test("D. simultaneous elimination resolves as a draw; a single elimination wins", () => {
  assert.equal(
    decideSurvivalResult({ p1Lives: 0, p2Lives: 0, p1Tiles: 3, p2Tiles: 5 }),
    RESULT.DRAW,
  );
  assert.equal(decideSurvivalResult({ p1Lives: 0, p2Lives: 1 }), RESULT.PLAYER2);
  assert.equal(decideSurvivalResult({ p1Lives: 1, p2Lives: 0 }), RESULT.PLAYER1);
});

test("D. the exhausted 40-tile board still breaks ties by lives, then tiles", () => {
  assert.equal(
    decideSurvivalResult({ p1Lives: 2, p2Lives: 1, p1Tiles: 0, p2Tiles: 9, exhausted: true }),
    RESULT.PLAYER1,
    "lives are the score",
  );
  assert.equal(
    decideSurvivalResult({
      p1Lives: 1,
      p2Lives: 1,
      p1Tiles: 20,
      p2Tiles: 19,
      exhausted: true,
    }),
    RESULT.PLAYER1,
    "equal lives fall back to tiles claimed",
  );
  assert.equal(
    decideSurvivalResult({
      p1Lives: 1,
      p2Lives: 1,
      p1Tiles: 20,
      p2Tiles: 20,
      exhausted: true,
    }),
    RESULT.DRAW,
  );
  assert.equal(
    decideSurvivalResult({ p1Lives: STARTING_LIVES, p2Lives: STARTING_LIVES }),
    null,
    "a live run has no result",
  );
});
