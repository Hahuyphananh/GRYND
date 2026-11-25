/**
 * solitaire-review-ui.test.mjs
 *
 * Phase 4 — Game Review interface.
 *
 * The repository's UI tests are source contracts plus pure-behaviour tests
 * (there is no jsdom harness). This suite therefore proves:
 *
 *   1. the review position is rebuilt from the deal + a validated log prefix,
 *      and the projection hides every face-down identity;
 *   2. initial / first / last positions and forward/backward navigation;
 *   3. classification, summary counts and the "no accuracy for incomplete"
 *      rule come from the engine's own output;
 *   4. the worker runner is single-flight, falls back when a worker is absent
 *      or fails, and cancels cleanly;
 *   5. the page is read-only, keyboard accessible, responsive by contract, and
 *      never analyses on move selection.
 *
 * Run: node --import tsx --test tests/solitaire-review-ui.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  describeMove,
  isInsightRating,
  notablePlies,
  RATING_META,
  ratingForMove,
  reconstructReviewPosition,
  reviewInsightForMove,
  stepPly,
  stepToNotable,
  summaryCounts,
} from "../src/lib/solitaire-duel/reviewView.ts";
import {
  createReviewAnalysisRunner,
  ReviewAnalysisCancelledError,
} from "../src/lib/solitaire-duel/reviewAnalysisRunner.ts";
import {
  applyMove,
  initialStateFromDeal,
  replayMoves,
  viewForState,
} from "../src/lib/solitaire-duel/rules.ts";
import { solvableDealFromSeed, solveDealLine } from "../src/lib/solitaire-duel/solvable.ts";

const read = (path) => fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const code = (path) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const PAGE = "src/app/solitaire/review/[kind]/[gameId]/PageClient.tsx";
const ROUTE = "src/app/solitaire/review/[kind]/[gameId]/page.tsx";
const HOOK = "src/hooks/useSolitaireReviewAnalysis.ts";
const WORKER = "src/lib/solitaire-duel/analysis.worker.ts";
const RUNNER = "src/lib/solitaire-duel/reviewAnalysisRunner.ts";
const BOARD = "src/components/solitaire-duel/SolitaireBoard.tsx";

// A real, complete game: seed 7 is solvable, and its solved line is a legal log.
const DEAL = solvableDealFromSeed(7);
const LINE = solveDealLine(DEAL) ?? [];
const MOVES = LINE.map((move) => ({ kind: move.kind, move }));
const FINAL = replayMoves({ deal: DEAL, moves: MOVES }).state;

// ── 1. Board reconstruction ────────────────────────────────────────────────

test("initial position is the deal, before any move", () => {
  const position = reconstructReviewPosition(DEAL, MOVES, 0);
  assert.equal(position.ok, true);
  assert.equal(position.state.ply, 0);
  assert.deepEqual(position.state, initialStateFromDeal(DEAL));
  assert.equal(position.view.stockCount, DEAL.stock.length);
  assert.equal(position.state.completed, false);
});

test("the first move is the initial state plus exactly that move", () => {
  const expected = applyMove({
    state: initialStateFromDeal(DEAL),
    move: MOVES[0].move,
  });
  assert.equal(expected.ok, true);

  const position = reconstructReviewPosition(DEAL, MOVES, 1);
  assert.equal(position.ok, true);
  assert.deepEqual(position.state, expected.state);
  assert.equal(position.state.ply, 1);
});

test("the last position is the authoritative completed board", () => {
  const position = reconstructReviewPosition(DEAL, MOVES, MOVES.length);
  assert.equal(position.ok, true);
  assert.equal(position.state.ply, MOVES.length);
  assert.equal(position.state.completed, true);
  assert.deepEqual(position.state, FINAL);
  assert.equal(position.view.completed, true);

  const foundations = Object.values(position.view.foundations).reduce(
    (sum, pile) => sum + pile.length,
    0,
  );
  assert.equal(foundations, 52);
});

test("the projected review board carries no face-down identities", () => {
  for (const ply of [0, 1, Math.floor(MOVES.length / 2), MOVES.length]) {
    const position = reconstructReviewPosition(DEAL, MOVES, ply);
    assert.equal(position.ok, true);
    for (const column of position.view.tableau) {
      for (const slot of column) {
        if (!slot.faceUp) assert.equal(slot.card, null);
      }
    }
    // The stock is a COUNT in the view; its order never leaves the server.
    assert.equal("stock" in position.view, false);
  }
});

test("a log prefix that the engine refuses is not half-rendered", () => {
  const broken = [{ kind: "tableau-to-tableau", move: { kind: "draw" } }];
  const position = reconstructReviewPosition(DEAL, broken, 1);
  assert.equal(position.ok, false);
  assert.equal(position.rejectedAt, 0);
});

// ── 2. Navigation ──────────────────────────────────────────────────────────

test("forward, backward, first and last navigation clamp at both ends", () => {
  const total = 4;
  assert.equal(stepPly(0, total, "previous"), 0);
  assert.equal(stepPly(0, total, "start"), 0);
  assert.equal(stepPly(0, total, "next"), 1);
  assert.equal(stepPly(1, total, "next"), 2);
  assert.equal(stepPly(2, total, "previous"), 1);
  assert.equal(stepPly(4, total, "next"), 4);
  assert.equal(stepPly(4, total, "previous"), 3);
  assert.equal(stepPly(1, total, "end"), 4);
  assert.equal(stepPly(99, total, "start"), 0);
  assert.equal(stepPly(-3, total, "next"), 1);
  assert.equal(stepPly(0, 0, "next"), 0);
});

test("the arrows stop only on standout moves and skip the routine log", () => {
  const analysis = {
    complete: true,
    perMove: [
      { ply: 0, rating: "normal", tags: [] },
      { ply: 1, rating: "normal", tags: [] },
      { ply: 2, rating: "great", tags: [] },
      { ply: 3, rating: "good", tags: [] },
      { ply: 4, rating: "blunder", tags: [] },
      { ply: 5, rating: "normal", tags: [] },
      { ply: 6, rating: "brilliant", tags: [] },
      { ply: 7, rating: "inaccuracy", tags: [] },
      { ply: 8, rating: "normal", tags: [] },
    ],
    summary: { accuracy: 0, ratings: {} },
  };
  const total = 9;
  const stops = notablePlies(analysis, total);

  // 1-based plies: great at index 2, blunder at 4, brilliant at 6, inaccuracy 7.
  assert.deepEqual(stops, [3, 5, 7, 8]);
  assert.deepEqual(notablePlies(null, total), []);
  assert.deepEqual(notablePlies(analysis, 0), []);

  // Forward: the initial deal goes straight to the first standout move.
  assert.equal(stepToNotable(0, total, "next", stops), 3);
  assert.equal(stepToNotable(3, total, "next", stops), 5);
  // From inside a run of normal moves the next stop is still the next standout.
  assert.equal(stepToNotable(4, total, "next", stops), 5);
  assert.equal(stepToNotable(8, total, "next", stops), total);

  // Backward: no stop before the first one means the initial deal.
  assert.equal(stepToNotable(8, total, "previous", stops), 7);
  assert.equal(stepToNotable(6, total, "previous", stops), 5);
  assert.equal(stepToNotable(3, total, "previous", stops), 0);
  assert.equal(stepToNotable(total, total, "next", stops), total);

  assert.equal(stepToNotable(5, total, "start", stops), 0);
  assert.equal(stepToNotable(5, total, "end", stops), total);

  // Before the analysis exists there is nothing to skip: plain one-ply steps.
  assert.equal(stepToNotable(4, total, "next", []), 5);
  assert.equal(stepToNotable(4, total, "previous", []), 3);
});

test("each timeline step matches the board that prefix rebuilds", () => {
  for (let ply = 0; ply <= MOVES.length; ply += 1) {
    const position = reconstructReviewPosition(DEAL, MOVES, ply);
    assert.equal(position.ok, true);
    assert.deepEqual(position.view, viewForState(FINAL_PREFIX(ply)));
  }

  function FINAL_PREFIX(ply) {
    return replayMoves({ deal: DEAL, moves: MOVES.slice(0, ply) }).state;
  }
});

// ── 3. Summary and classification ──────────────────────────────────────────

test("move descriptions name the card and the destination", () => {
  assert.equal(describeMove({ kind: "draw" }), "Draw from stock");
  assert.match(
    describeMove({
      kind: "tableau-to-foundation",
      fromColumn: 0,
      card: { rank: 1, suit: "hearts" },
      suit: "hearts",
    }),
    /A\u2665.*foundation/,
  );
  assert.match(
    describeMove({
      kind: "tableau-to-tableau",
      fromColumn: 0,
      card: { rank: 13, suit: "spades" },
      toColumn: 2,
    }),
    /K\u2660.*column 1.*column 3/,
  );
  assert.match(describeMove({ kind: "waste-to-tableau", toColumn: 1 }), /column 2/);
});

test("rating labels are distinct and never rely on colour alone", () => {
  const labels = Object.values(RATING_META).map((meta) => meta.label);
  assert.equal(new Set(labels).size, labels.length);
  for (const meta of Object.values(RATING_META)) {
    assert.ok(meta.label.length > 0);
    assert.ok(meta.chip.includes("border-"));
  }
  assert.notEqual(RATING_META.normal.chip, RATING_META.blunder.chip);
});

test("summary counts expose only the conservative insight labels", () => {
  const analysis = {
    complete: true,
    perMove: [{ ply: 0, rating: "great" }],
    summary: {
      accuracy: null,
      ratings: { normal: 2, good: 5, great: 3, brilliant: 1, inaccuracy: 4, mistake: 2, blunder: 4 },
    },
  };

  assert.deepEqual(summaryCounts(analysis), {
    great: 3,
    good: 5,
    inaccuracy: 4,
    mistake: 2,
  });
  assert.equal(ratingForMove(analysis, 0), "great");
  assert.equal(ratingForMove(analysis, 1), null);
  assert.equal(isInsightRating("great"), true);
  assert.equal(isInsightRating("good"), true);
  assert.equal(isInsightRating("brilliant"), false);
  assert.equal(isInsightRating("blunder"), false);
  assert.equal(isInsightRating("normal"), false);
});

test("a routine move has no insight and a labelled move does", () => {
  const routine = {
    perMove: [{ ply: 0, rating: "normal", tags: ["stock-draw"], bestAlternative: null }],
  };
  assert.equal(reviewInsightForMove(routine, 0, { kind: "draw" }), null);

  const labelled = {
    perMove: [
      {
        ply: 0,
        rating: "good",
        tags: ["revealed-hidden"],
        bestAlternative: {
          move: { kind: "tableau-to-tableau", fromColumn: 1, card: { rank: 13, suit: "spades" }, toColumn: 2 },
          relation: "lower-ranked",
        },
      },
    ],
  };
  const insight = reviewInsightForMove(labelled, 0, {
    kind: "tableau-to-tableau",
    fromColumn: 0,
    card: { rank: 7, suit: "hearts" },
    toColumn: 1,
  });
  assert.ok(insight);
  assert.equal(insight.rating, "good");
  assert.match(insight.played, /7\u2665/);
  assert.ok(insight.facts.some((fact) => /face-down/.test(fact)));
  assert.match(insight.alternative, /K\u2660/);
  assert.match(insight.basis, /not a solver proof/);
});

test("an insight is built for the selected ply, not the first labelled move", () => {
  const analysis = {
    perMove: [
      { ply: 0, rating: "good", tags: ["revealed-hidden"], bestAlternative: null },
      { ply: 1, rating: "mistake", tags: ["pointless-shuffle"], bestAlternative: null },
    ],
  };
  const first = reviewInsightForMove(analysis, 0, { kind: "draw" });
  const second = reviewInsightForMove(analysis, 1, { kind: "draw" });

  assert.equal(first.rating, "good");
  assert.equal(second.rating, "mistake");
  assert.notEqual(first.facts.join("|"), second.facts.join("|"));
  assert.match(second.lesson, /compare the visible moves/i);
});

test("unsupported quality labels never produce an insight", () => {
  for (const rating of ["normal", "brilliant", "blunder"]) {
    const analysis = { perMove: [{ ply: 0, rating, tags: [] }] };
    assert.equal(
      reviewInsightForMove(analysis, 0, { kind: "draw" }),
      null,
      `${rating} must stay silent`,
    );
  }
});

test("missing analysis degrades to unlabelled moves and empty counts", () => {
  assert.equal(ratingForMove(null, 0), null);
  assert.equal(summaryCounts(null), null);
  assert.equal(reviewInsightForMove(null, 0, { kind: "draw" }), null);
});

// ── 4. Worker runner ───────────────────────────────────────────────────────

class FakeWorker {
  constructor(onPost = null) {
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
    this.messages = [];
    this.onPost = onPost;
  }
  postMessage(message) {
    this.messages.push(message);
    this.onPost?.(this, message);
  }
  terminate() {
    this.terminated = true;
  }
}

const ANALYSIS = {
  version: 1,
  complete: true,
  reconstructable: true,
  rejectedAt: null,
  perMove: [],
  moments: [],
  summary: { accuracy: 90, ratings: {} },
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("one worker result is used and the fallback is not called", async () => {
  let fallbackCalls = 0;
  const worker = new FakeWorker((self, message) => {
    queueMicrotask(() => self.onmessage?.({ data: { id: message.id, analysis: ANALYSIS } }));
  });
  const runner = createReviewAnalysisRunner({
    createWorker: () => worker,
    fallback: async () => {
      fallbackCalls += 1;
      return ANALYSIS;
    },
  });

  assert.deepEqual(await runner.analyze({ key: "solo:1", deal: DEAL, moves: MOVES }), ANALYSIS);
  assert.equal(fallbackCalls, 0);
  assert.equal(worker.messages[0].id, "solo:1");
});

test("no Worker environment falls back to the deferred importer", async () => {
  let fallbackCalls = 0;
  const runner = createReviewAnalysisRunner({
    createWorker: () => null,
    fallback: async () => {
      fallbackCalls += 1;
      return ANALYSIS;
    },
  });

  assert.deepEqual(await runner.analyze({ key: "daily:1", deal: DEAL, moves: MOVES }), ANALYSIS);
  assert.equal(fallbackCalls, 1);
});

test("a worker construction failure and a worker error both fall back", async () => {
  let fallbackCalls = 0;
  const runner = createReviewAnalysisRunner({
    createWorker: () => {
      throw new Error("Worker is blocked");
    },
    fallback: async () => {
      fallbackCalls += 1;
      return ANALYSIS;
    },
  });
  assert.deepEqual(await runner.analyze({ key: "solo:2", deal: DEAL, moves: MOVES }), ANALYSIS);

  const failing = new FakeWorker((self) => {
    queueMicrotask(() => self.onerror?.({ message: "worker crashed" }));
  });
  const second = createReviewAnalysisRunner({
    createWorker: () => failing,
    fallback: async () => {
      fallbackCalls += 1;
      return ANALYSIS;
    },
  });
  assert.deepEqual(await second.analyze({ key: "solo:3", deal: DEAL, moves: MOVES }), ANALYSIS);
  assert.equal(fallbackCalls, 2);
  assert.equal(failing.terminated, true);
});

test("the same game never starts a second worker or analysis", async () => {
  let created = 0;
  let respond;
  const worker = new FakeWorker((self) => {
    respond = () => self.onmessage?.({ data: { id: "game-1", analysis: ANALYSIS } });
  });
  const runner = createReviewAnalysisRunner({
    createWorker: () => {
      created += 1;
      return worker;
    },
    fallback: async () => ANALYSIS,
  });

  const first = runner.analyze({ key: "game-1", deal: DEAL, moves: MOVES });
  const second = runner.analyze({ key: "game-1", deal: DEAL, moves: MOVES });
  assert.strictEqual(first, second);
  assert.equal(created, 1);
  assert.equal(worker.messages.length, 1);

  respond();
  assert.deepEqual(await first, ANALYSIS);
});

test("a new game cancels and terminates the previous worker", async () => {
  const firstWorker = new FakeWorker();
  const secondWorker = new FakeWorker((self, message) => {
    queueMicrotask(() => self.onmessage?.({ data: { id: message.id, analysis: ANALYSIS } }));
  });
  const workers = [firstWorker, secondWorker];
  const runner = createReviewAnalysisRunner({
    createWorker: () => workers.shift(),
    fallback: async () => ANALYSIS,
  });

  const stale = runner.analyze({ key: "game-1", deal: DEAL, moves: MOVES });
  stale.catch(() => {});
  const fresh = runner.analyze({ key: "game-2", deal: DEAL, moves: MOVES });

  await assert.rejects(stale, ReviewAnalysisCancelledError);
  assert.equal(firstWorker.terminated, true);
  assert.deepEqual(await fresh, ANALYSIS);
});

test("cancel terminates the worker and rejects the in-flight analysis", async () => {
  const worker = new FakeWorker();
  const runner = createReviewAnalysisRunner({
    createWorker: () => worker,
    fallback: async () => ANALYSIS,
  });
  const pending = runner.analyze({ key: "game-3", deal: DEAL, moves: MOVES });
  runner.cancel();
  await assert.rejects(pending, ReviewAnalysisCancelledError);
  assert.equal(worker.terminated, true);
  await flush();
});

// ── 5. Page and worker contracts ───────────────────────────────────────────

test("the review route is dedicated, validates the game kind, and is private", () => {
  const route = code(ROUTE);
  assert.match(route, /notFound\(\)/);
  assert.match(route, /params: Promise<\{ kind: string; gameId: string \}>/);
  assert.match(route, /robots: \{ index: false, follow: false \}/);
  assert.match(code(PAGE), /SolitaireReview/);
  assert.equal(fs.existsSync(PAGE), true);
});

test("the page is read-only and never sends a move", () => {
  const page = code(PAGE);
  assert.match(page, /<SolitaireBoard/);
  assert.match(page, /interactive=\{false\}/);
  assert.match(page, /readOnly/);
  assert.match(code(BOARD), /readOnly\?: boolean/);
  assert.match(code(BOARD), /solitaireReview\.ui\.boardNotice/);
  assert.match(page, /pointer-events-none/);
  assert.match(page, /reconstructReviewPosition/);
  assert.doesNotMatch(page, /applyMoveToView|method:\s*["']POST["']/);
  assert.doesNotMatch(page, /onMove=\{\(move/);
});

test("analysis is created once per game, not once per selected move", () => {
  const page = code(PAGE);
  assert.match(page, /useSolitaireReviewAnalysis\(\{/);
  assert.equal((page.match(/useSolitaireReviewAnalysis\(/g) ?? []).length, 1);
  assert.doesNotMatch(page, /analyzeSolitaireGame/);
  assert.match(code(HOOK), /\[enabled, gameKey, deal, moves, initialAnalysis\]/);
  assert.doesNotMatch(code(HOOK), /selectedPly/);
});

test("the worker is a native module worker with a fallback and cancellation", () => {
  const hook = code(HOOK);
  const worker = code(WORKER);
  assert.match(hook, /new Worker\(\s*new URL\(/);
  assert.match(hook, /type: "module"/);
  assert.match(hook, /runner\.cancel\(\)/);
  assert.match(hook, /analyzeSolitaireGame/);
  assert.match(worker, /analyzeSolitaireGame/);
  assert.doesNotMatch(worker, /from\s+["'](?!\.)/m);
  assert.doesNotMatch(hook, /worker-loader|comlink|workerize/);
  assert.match(code(RUNNER), /terminate\(\)/);
});

test("navigation and timeline are keyboard accessible with a clear selection", () => {
  const page = code(PAGE);
  // The listener is on the window, so arrows work without clicking a control
  // first, and it is removed with the page.
  assert.match(page, /window\.addEventListener\("keydown", onKeyDown\)/);
  assert.match(page, /window\.removeEventListener\("keydown", onKeyDown\)/);
  assert.match(page, /ArrowLeft/);
  assert.match(page, /ArrowRight/);
  assert.match(page, /Home/);
  assert.match(page, /End/);
  assert.match(page, /preventDefault\(\)/);
  assert.match(page, /onKeyDown/);
  assert.match(page, /aria-current=\{isSelected \? "step" : undefined\}/);
  // Everything the reader hears comes from the shared translation bundle, so
  // the accessible name is localized along with the visible label.
  assert.match(page, /aria-label=\{t\("solitaireReview\.ui\.moveAria", \{/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /label=\{t\("solitaireReview\.ui\.navStart"\)\}/);
  assert.match(page, /label=\{t\("solitaireReview\.ui\.navPrev"\)\}/);
  assert.match(page, /label=\{t\("solitaireReview\.ui\.navNext"\)\}/);
  assert.match(page, /label=\{t\("solitaireReview\.ui\.navEnd"\)\}/);
  assert.match(page, /aria-label=\{t\("solitaireReview\.ui\.restartAria"\)\}/);
  assert.match(page, /role="group"\s*aria-label=\{t\("solitaireReview\.ui\.moveNavigation"\)\}/);
  assert.match(page, /disabled=\{selectedPly === 0\}/);
  assert.match(page, /disabled=\{selectedPly >= totalMoves\}/);
});

test("playback walks one move at a time and pauses at the end", () => {
  const page = code(PAGE);
  assert.match(page, /IconPlayerPlay/);
  assert.match(page, /IconPlayerPause/);
  assert.match(page, /data-testid="review-autoplay"/);
  assert.match(page, /aria-pressed=\{playing\}/);
  assert.match(page, /if \(playing\) \{\s*setPlaying\(false\);\s*return;/);
  assert.match(page, /setPlaying\(true\)/);

  // It advances exactly one ply, re-arming after every step.
  assert.match(page, /setTimeout\(\(\) => go\("next", playbackSpeed < 2\), playbackMs\)/);
  assert.match(page, /stepPly\(current, totalMoves, action\)/);

  // An empty log cannot be played; reaching the end pauses itself.
  assert.match(page, /disabled=\{totalMoves === 0\}/);
  assert.match(page, /selectedPly >= totalMoves/);
  assert.match(page, /setPlaying\(false\)/);

  // Starting from the final position rewinds to the deal instead of stalling.
  assert.match(page, /if \(selectedPly >= totalMoves\) setSelectedPly\(0\)/);
});

test("playback speed offers 0.5x, 1x and 2x", () => {
  const page = code(PAGE);
  assert.match(page, /data-testid="review-playback-speed"/);
  assert.match(page, /aria-label=\{t\("solitaireReview\.ui\.playbackSpeed"\)\}/);
  assert.match(page, /const next = Number\(event\.target\.value\)/);
  assert.match(page, /setPlaybackSpeed\(next\)/);
  assert.match(page, /PLAYBACK_SPEEDS/);
  assert.match(page, /\{ label: "0\.5x", value: 0\.5, ms: 1400 \}/);
  assert.match(page, /\{ label: "1x", value: 1, ms: 700 \}/);
  assert.match(page, /\{ label: "2x", value: 2, ms: 350 \}/);

  // The timer uses the selected pace and re-arms when it changes.
  assert.match(page, /setTimeout\(\(\) => go\("next", playbackSpeed < 2\), playbackMs\)/);
  assert.match(page, /\[playing, selectedPly, totalMoves, go, playbackMs, playbackSpeed\]/);
});

test("Space toggles Play/Pause without double-toggling a focused button", () => {
  const page = code(PAGE);
  assert.match(page, /const togglePlay = useCallback/);
  assert.match(page, /event\.key === " "/);
  assert.match(page, /!target\?\.closest\("button, a, select, summary"\)/);
  assert.match(page, /if \(!event\.repeat\) togglePlay\(\)/);
  assert.match(page, /onClick=\{togglePlay\}/);
  assert.match(page, /\[closeRecommendation, demo, goManually, togglePlay\]/);
});

test("the chosen playback speed survives a visit", () => {
  const page = code(PAGE);
  assert.match(page, /PLAYBACK_SPEED_STORAGE_KEY = "grynd:solitaire-review:playback-speed"/);

  // A chosen pace is written immediately; only an offered pace is restored.
  assert.match(page, /window\.localStorage\.setItem\(\s*PLAYBACK_SPEED_STORAGE_KEY,\s*String\(next\),?\s*\)/);
  assert.match(page, /window\.localStorage\.getItem\(PLAYBACK_SPEED_STORAGE_KEY\)/);
  assert.match(page, /PLAYBACK_SPEEDS\.some\(\(option\) => option\.value === stored\)/);

  // Storage can throw (private mode), so reading and writing both degrade to
  // the 1x default instead of breaking the review page.
  assert.match(page, /PLAYBACK_SPEEDS\.some/);
  assert.ok(
    (page.match(/catch \{/g) ?? []).length >= 2,
    "both the restore and the save must guard against storage throwing",
  );

  // The restore runs after mount, never in the state initializer.
  assert.match(page, /useEffect\(\(\) => \{\s*try \{\s*const stored = Number\(window\.localStorage\.getItem/);
});

test("manual navigation pauses playback", () => {
  const page = code(PAGE);

  // One manual wrapper pauses and then steps, for buttons and the keyboard.
  assert.match(page, /const goManually = useCallback/);
  assert.match(page, /setPlaying\(false\);/);
  assert.match(page, /onClick=\{\(\) => goManually\("start"\)\}/);
  assert.match(page, /onClick=\{\(\) => goManually\("previous"\)\}/);
  assert.match(page, /onClick=\{\(\) => goManually\("next"\)\}/);
  assert.match(page, /onClick=\{\(\) => goManually\("end"\)\}/);
  assert.match(page, /goManually\("ArrowLeft"\)|goManually\("previous"\)/);
  assert.match(page, /\[closeRecommendation, demo, goManually, togglePlay\]/);

  // Timeline rows and key moments select directly, so they pause too.
  assert.match(page, /const selectManually = useCallback/);
  assert.match(page, /onClick=\{\(\) => selectManually\(moment\.ply \+ 1\)\}/);
  assert.match(page, /onClick=\{\(\) => selectManually\(index \+ 1\)\}/);

  // The auto timer is the only caller left on the raw stepper.
  assert.match(page, /setTimeout\(\(\) => go\("next", playbackSpeed < 2\), playbackMs\)/);
});

test("the hint names the next move", () => {
  const page = code(PAGE);
  assert.match(page, /data-testid="review-nav-hint"/);
  assert.match(page, /const nextTarget = selectedPly >= totalMoves \? null : selectedPly \+ 1/);
  assert.match(page, /t\("solitaireReview\.ui\.hintNext", \{ next: nextTarget \}\)/);
  // With no further move the hint says so rather than showing a stale number.
  assert.match(page, /selectedPly >= totalMoves\s*\? null/);
  assert.match(page, /t\("solitaireReview\.ui\.hintEnd"\)/);
});

test("playback never scrolls the page and commentary sits above the board", () => {
  const page = code(PAGE);
  // Scrolling the selected timeline row must touch the list, never the window.
  assert.doesNotMatch(page, /scrollIntoView/);
  assert.match(page, /timelineListRef/);

  // GLITCH's line renders before the board, i.e. at the top of the analysis.
  const glitch = page.indexOf('data-testid="review-glitch"');
  const board = page.indexOf('data-testid="review-board"');
  assert.ok(glitch > 0, "the review still renders GLITCH commentary");
  assert.ok(board > 0, "the review still renders the board");
  assert.ok(glitch < board, "GLITCH's line must sit above the board, not below it");

  // The arrows/playback use the exact validated log, one ply at a time.
  assert.match(page, /stepPly\(current, totalMoves, action\)/);
  assert.match(page, /setAnimateStep\(animate\)/);
});

test("restart returns to the initial deal and stops playback", () => {
  const page = code(PAGE);
  assert.match(page, /data-testid="review-restart"/);
  assert.match(page, /const restartReview = useCallback/);
  assert.match(page, /onClick=\{restartReview\}/);
  assert.match(page, /setPlaying\(false\);\s*setAnimateStep\(false\);\s*setSelectedPly\(0\);/);
});

test("a jump skips animations while a single forward step opts in", () => {
  const page = code(PAGE);
  assert.match(page, /const \[animateStep, setAnimateStep\]/);
  assert.match(page, /go\(action, action === "next"\)/);
  assert.match(page, /const selectManually[\s\S]*?setAnimateStep\(false\)/);
  assert.match(page, /reviewAnimate=\{boardAnimate\}/);
  assert.match(page, /data-review-animate=\{boardAnimate/);
  assert.match(code(BOARD), /reviewAnimate\?: boolean/);
  assert.match(code(BOARD), /if \(readOnly && !reviewAnimate\)/);
});

test("changing speed never resets the selected move", () => {
  const page = code(PAGE);
  const readOnly = page.slice(page.indexOf('data-testid="review-playback-speed"'));
  const handler = readOnly.slice(0, readOnly.indexOf("</select>"));
  assert.doesNotMatch(handler, /setSelectedPly/);
  assert.doesNotMatch(handler, /setPlaying/);
});

test("the timeline is first on mobile and the back link names the result", () => {
  const page = code(PAGE);
  assert.match(page, /min-w-0 flex flex-col gap-4/);
  assert.match(page, /data-testid="review-timeline"\s*className="order-first/);
  // The back link names the surface it returns to, in the active locale.
  assert.match(page, /"solitaireReview\.ui\.backDuel"/);
  assert.match(page, /"solitaireReview\.ui\.backSolo"/);
});

test("the review page is public but its data API stays owner-gated", () => {
  const proxy = read("src/proxy.ts");
  assert.ok(proxy.includes('\"/solitaire/review(.*)\"'), "the review shell is public");
  const api = code("src/app/api/solitaire/review/route.ts");
  assert.match(api, /eq\(solitaireSoloResults\.userId, player\.playerId\)/);
  assert.match(api, /eq\(solitaireDailyResults\.userId, player\.playerId\)/);
});

test("the review exposes only supported insights and no accuracy score", () => {
  const page = code(PAGE);
  assert.match(page, /data-testid="review-insight"/);
  assert.match(page, /reviewInsightForMove\(analysis/);
  assert.match(page, /isInsightRating\(currentRating\)/);
  assert.match(page, /testId="review-inaccuracy"/);
  assert.match(page, /data-testid="review-partial-analysis"/);
  assert.match(page, /t\("solitaireReview\.ui\.labelsNote"\)/);
  assert.doesNotMatch(page, /data-testid="review-accuracy"/);
  assert.doesNotMatch(page, /data-testid="review-brilliant"/);
  assert.doesNotMatch(page, /data-testid="review-blunders"/);
  assert.doesNotMatch(page, /<h3[^>]*>\s*Accuracy\s*<\/h3>/);
});

test("timeline rows are unannotated unless the engine labelled them", () => {
  const page = code(PAGE);
  assert.match(page, /const meta = isInsightRating\(rating\) \? RATING_META\[rating\] : null/);
  assert.match(page, /data-rating=\{meta \? rating : "unannotated"\}/);
  assert.match(page, /meta\s*\? `, \$\{localizedRating\(rating \?\? "normal"\)\}`\s*: `, \$\{t\("solitaireReview\.ui\.noExtraInsight"\)\}`/);
});

test("the layout has a mobile-first grid, scrollable timeline and reduced motion", () => {
  const page = code(PAGE);
  assert.match(page, /grid grid-cols-1 gap-5 lg:grid-cols-\[/);
  assert.match(page, /overflow-y-auto/);
  assert.match(page, /sm:max-h-/);
  assert.match(page, /motion-reduce:transition-none/);
  assert.match(page, /min-w-0/);
  assert.match(page, /flex-wrap/);
});
