/**
 * solitaire-review-entrypoints.test.mjs
 *
 * MATCH ANALYSIS IN EVERY GAMEMODE — and only when the player asks for it.
 *
 * Two halves:
 *
 *   1. The local review builder, driven for real. A guest's completed game is
 *      the deal + the final log kept in this browser; solo derives the deal
 *      from its seed, daily carries the deal the page was dealt. A record the
 *      engine cannot replay is never presented as a review.
 *
 *   2. Source contracts for the entry points: ranked/bots/resign go through the
 *      shared result screen's guarded analysis action, solo and daily offer it
 *      on the win popup, and the Solo page lists past completed games. The
 *      same contracts pin the post-match video to every exit control, including
 *      the one on a resigned (loss) popup.
 *
 * Run: node --import tsx --test tests/solitaire-review-entrypoints.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { dealFromSeed } from "../src/lib/solitaire-duel/deck.ts";
import {
  buildLocalReview,
  isLocalReviewGameId,
  LOCAL_COMPLETED_KEY,
  localCompletedReviewId,
  readLocalCompletedGames,
} from "../src/lib/solitaire-duel/localReview.ts";
import { solvableDealFromSeed, solveDealLine } from "../src/lib/solitaire-duel/solvable.ts";

const read = (path) => fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const code = (path) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const RESULT_SCREEN = "src/components/result/PvpResultScreen.jsx";
const DUEL_PLAY = "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx";
const SOLO = "src/components/solitaire-duel/SoloSolitaireGame.tsx";

// ── A fake browser store ───────────────────────────────────────────────────

const memory = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
  },
};

const DEAL = solvableDealFromSeed(7);
const LOG = (solveDealLine(DEAL) ?? []).map((move) => ({ kind: move.kind, move }));

assert.ok(LOG.length > 0, "the fixture must be a real solved line");

function record({
  mode = "solo",
  seed = 7,
  dateKey = null,
  deal = null,
  log = LOG,
  savedAtMs = 1_700_000_000_000,
} = {}) {
  return {
    id: localCompletedReviewId(savedAtMs, log.length),
    mode,
    seed,
    dateKey,
    deal,
    log,
    startedAtMs: savedAtMs - 61_000,
    endedAtMs: savedAtMs,
    elapsedMs: 61_000,
    won: true,
    savedAtMs,
  };
}

function store(records) {
  memory.set(LOCAL_COMPLETED_KEY, JSON.stringify(records));
}

function reset() {
  memory.clear();
}

// ── 1. The local review builder ────────────────────────────────────────────

test("a guest solo game rebuilds the same review payload the API returns", () => {
  reset();
  const saved = record();
  store([saved]);

  assert.equal(isLocalReviewGameId(saved.id), true);
  assert.equal(isLocalReviewGameId("8d1a8f0e-0000-4000-8000-000000000000"), false);
  assert.equal(isLocalReviewGameId(null), false);

  const review = buildLocalReview(saved.id);
  assert.ok(review);
  assert.equal(review.gameId, saved.id);
  assert.equal(review.gameKind, "solo");
  assert.equal(review.mode, "solo");
  assert.equal(review.status, "complete");
  assert.equal(review.analysisEligible, true);
  assert.equal(review.analysis, null, "the worker computes it on demand");
  assert.equal(review.seed, 7);
  assert.equal(review.dateKey, null);
  assert.equal(review.durationMs, 61_000);
  assert.deepEqual(review.deal, dealFromSeed(7), "the deal is the seed's deal");
  assert.deepEqual(review.moves, LOG);
  assert.equal(review.result.moveCount, LOG.length);
});

test("a guest daily game is reviewable from the deal the page was dealt", () => {
  reset();
  const saved = record({ mode: "daily", seed: 0, dateKey: "2026-11-11", deal: DEAL });
  store([saved]);

  const review = buildLocalReview(saved.id);
  assert.ok(review);
  assert.equal(review.gameKind, "daily");
  assert.equal(review.mode, "daily");
  assert.equal(review.dateKey, "2026-11-11");
  assert.equal(review.status, "complete");
  assert.equal(review.analysisEligible, true);
  assert.deepEqual(review.deal, DEAL, "the stored deal is used verbatim");
  assert.deepEqual(review.moves, LOG);
});

test("a daily record without its deal is refused, not guessed", () => {
  reset();
  const saved = record({ mode: "daily", seed: 0, dateKey: "2026-11-11", deal: null });
  store([saved]);
  assert.equal(buildLocalReview(saved.id), null);

  // A truncated / hand-edited deal fails closed too.
  store([{ ...saved, deal: { stock: [] } }]);
  assert.equal(buildLocalReview(saved.id), null);
});

test("a log the engine cannot replay to a completed board is never a review", () => {
  reset();
  const complete = record();
  store([{ ...complete, log: complete.log.slice(0, -5) }]);
  assert.equal(buildLocalReview(complete.id), null);

  store([{ ...complete, log: [{ kind: "draw", move: { kind: "nope" } }] }]);
  assert.equal(buildLocalReview(complete.id), null);
});

test("an id this browser never issued, or an unknown record, returns nothing", () => {
  reset();
  const saved = record();
  store([saved]);

  assert.equal(buildLocalReview("local-0-0"), null);
  assert.equal(buildLocalReview("8d1a8f0e-0000-4000-8000-000000000000"), null);
  // A record written before ids existed is kept by the reader but is not
  // addressable, so it can never open an empty review.
  store([{ ...saved, id: undefined }]);
  assert.equal(readLocalCompletedGames().length, 1);
  assert.equal(buildLocalReview(saved.id), null);
});

// ── 2. The entry points ────────────────────────────────────────────────────

test("the shared result screen exposes analysis as a guarded player choice", () => {
  const source = code(RESULT_SCREEN);

  assert.match(source, /analysisAction = null,/);
  assert.match(source, /\{analysisAction && analysisAction\.href && \(/);
  // A click is required, and it goes through the same exit gate as every other
  // control (so the post-match video still comes first).
  assert.match(
    source,
    /onClick=\{\(event\) => \{\s*event\.preventDefault\(\);\s*guard\("analysis", \(\) => router\.push\(analysisAction\.href\)\)\(\);/,
  );
  // The shared screen never knows a review URL, so it cannot navigate to one
  // on its own.
  assert.doesNotMatch(source, /solitaire\/review/);
});

test("a rematch is a new RESULT, so the video is offered again", () => {
  const source = code(RESULT_SCREEN);

  // Per-result state must not survive into the next match's result: the route
  // (and so this component instance) survives a rematch.
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*if \(!open\) return;\s*adAttemptedRef\.current = false;/,
    "opening a result resets the one-attempt flag",
  );
  assert.match(source, /pendingExitRef\.current = null;\s*setAdOpen\(false\);/);
  assert.match(source, /setNavigating\(false\);/);

  // ...while the one-attempt-per-result guard and the release path are intact.
  assert.match(source, /if \(!compact && !postMatchAd && !adAttemptedRef\.current\) \{/);
  assert.match(source, /const handleAdSettled = useCallback\(\(\) => \{/);
  assert.match(source, /next\(\);/);
});

test("the ad gate is outcome-agnostic, so a resignation is covered too", () => {
  const source = code(RESULT_SCREEN);
  const guard = source.match(/const guard = \(key, fn\) => \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(guard, "the exit gate must exist");
  assert.doesNotMatch(guard[0], /outcome/, "a loss/resign must offer the video exactly like a win");

  // And every exit the popup offers routes through it.
  assert.match(source, /onClick=\{guard\("playAgain", playAgain\.onClick\)\}/);
  assert.match(source, /onClick=\{guard\("rematch", rematch\.onClick\)\}/);
  assert.match(source, /onClick=\{guard\("lobby", onReturnToLobby\)\}/);
  assert.match(
    source,
    /guard\("secondary", \(\) => router\.push\(secondaryAction\.href\)\)\(\)/,
    "the Back to home link offers the video too",
  );

  // The duel result (ranked, bots and resign) is that shared screen.
  const duel = code(DUEL_PLAY);
  assert.match(duel, /<PvpResultScreen/);
  assert.match(duel, /open=\{phase === "result" && finished && !finishing\}/);
  assert.match(duel, /secondaryAction=\{\{ label: "Back to home", href: "\/" \}\}/);
});

test("ranked, bots and resign reach the analysis for exactly this match", () => {
  const source = code(DUEL_PLAY);

  assert.match(source, /analysisAction=\{\s*match\s*\?/);
  assert.match(
    source,
    /href: `\/solitaire\/review\/duel\/\$\{encodeURIComponent\(match\.matchId\)\}`/,
  );
  // The outcome comes from the settled row, so a forfeit lands on the same
  // result screen (and the same analysis action) as any other ending.
  assert.match(source, /viewerOutcome\(seat, match\?\.result\)/);
});

test("solo offers analysis on the win popup only, never automatically", () => {
  const source = code(SOLO);

  const winPanel = source.indexOf("session.won && !finishing");
  const button = source.indexOf('data-testid="solitaire-analysis"');
  assert.ok(winPanel > -1, "the win popup exists");
  assert.ok(button > winPanel, "the analyse button lives inside the win popup");

  assert.match(source, /\{reviewGameId && \(/);
  assert.match(
    source,
    /onClick=\{\(event\) => \{\s*event\.preventDefault\(\);\s*guardExit\("analysis", \(\) =>/,
  );
  assert.match(source, /guardExit\("playAgain", restart\)/);
});

test("a guest daily game keeps its deal and gets a local review id", () => {
  const source = code(SOLO);

  assert.match(source, /deal: finished\.deal/);
  assert.match(source, /const localReviewId = appendLocalCompleted\(localGame\)/);
  assert.match(source, /if \(localReviewId\) setReviewGameId\(localReviewId\)/);
  // Neither mode is excluded from the local review id.
  assert.doesNotMatch(source, /localReviewId && finished\.mode === "solo"/);
  // A signed-in game is not mirrored into the device ring — that list is the
  // account's — but the account-backed history is read instead.
  assert.doesNotMatch(source, /if \(finished\.won\) appendLocalCompleted\(localGame\)/);
  assert.match(source, /fetch\("\/api\/solitaire\/history\?limit=12"/);
});

test("both single-player pages list past completed games with a review link", () => {
  const source = code(SOLO);

  // The same component renders both pages, so the list must not be gated on
  // solo: a daily player's history is the same account.
  assert.match(source, /readLocalCompletedGames/);
  assert.match(source, /data-testid="solitaire-review-history"/);
  assert.doesNotMatch(source, /mode === "solo" && history\.length > 0/);
  assert.match(source, /serverHistory/);
  assert.match(
    source,
    /href=\{`\/solitaire\/review\/\$\{row\.mode\}\/\$\{encodeURIComponent\(row\.id\)\}`\}/,
  );
  assert.match(read("src/app/solitaire/PageClient.tsx"), /<SoloSolitaireGame mode="solo"/);
  assert.match(read("src/app/daily/PageClient.tsx"), /<SoloSolitaireGame[\s\S]*mode="daily"/);
});
