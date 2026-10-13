/**
 * Tic-Tac-Toe & Speed Typing → Game Evaluation wiring.
 *
 * Phase 3 wires the shared evaluation report into the finished-match result
 * screens for the two games whose evaluators are registered, following the
 * existing chess flow. These are static contract checks (the screens need Clerk
 * + a live match to mount, exactly like tests/chess-evaluation-link.test.mjs),
 * so they pin the rules that make the links correct and honest:
 *
 *   1. The link is the shared panel's GENERIC `secondaryAction` — the panel
 *      still knows nothing about games or evaluation.
 *   2. The href uses the game's real key and the match id the page is about.
 *   3. It is offered ONLY for a match the evaluator will accept: unfinished
 *      matches, cancelled races, expanded Tic-Tac-Toe lattices (stage 2/3) and
 *      ties must resolve to `null`, never a dead link that 409/422s.
 *   4. Errors / insufficient data are handled honestly by the evaluation page
 *      the link opens.
 *   5. Chess behavior is unchanged.
 *
 * Run: npm run test:evaluation-links
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

const PANEL = read("src/components/result/PvpResultScreen.jsx");
const CHESS = read("src/app/casino/chess-game/[gameId]/PageClient.jsx");
const TTT = read("src/app/casino/tic-tac-toe/[matchId]/PageClient.tsx");
const SPEED = read("src/app/casino/speed-typing/[matchId]/PageClient.tsx");
const EVAL_PAGE = read("src/app/evaluation/[gameKey]/[matchId]/PageClient.tsx");
const TTT_EVALUATOR = read("src/lib/evaluation/games/ticTacToeEvaluator.ts");

const count = (source, needle) => source.split(needle).length - 1;

// ════════════════════════════════════════════════════════════════════
// 1. The shared panel stays generic
// ════════════════════════════════════════════════════════════════════

test("the shared result panel exposes secondaryAction as navigation, game-agnostically", () => {
  assert.match(PANEL, /secondaryAction = null,/);
  assert.match(PANEL, /\{secondaryAction && secondaryAction\.href && \(/);
  assert.match(PANEL, /href=\{secondaryAction\.href\}/);
  assert.doesNotMatch(PANEL, /\/evaluation\//, "the route belongs to the caller");
});

// ════════════════════════════════════════════════════════════════════
// 2. Tic-Tac-Toe: correct link, correct gate
// ════════════════════════════════════════════════════════════════════

test("tic-tac-toe offers See Evaluation → /evaluation/tic-tac-toe/[matchId]", () => {
  assert.match(TTT, /gameKey="tic-tac-toe"/);
  assert.match(TTT, /secondaryAction=\{/);
  assert.match(TTT, /label: "See Evaluation"/);
  assert.match(TTT, /href: `\/evaluation\/tic-tac-toe\/\$\{matchId\}`/);
  // Exactly one evaluation action, gated by the eligibility flag.
  assert.equal(count(TTT, "secondaryAction="), 1);
  assert.match(
    TTT,
    /secondaryAction=\{\s*evaluationEligible\s*\? \{ label: "See Evaluation", href: `\/evaluation\/tic-tac-toe\/\$\{matchId\}` \}\s*:\s*null\s*\}/,
  );
});

test("tic-tac-toe hides the link for anything the evaluator would reject", () => {
  // The gate mirrors the evaluator: a match DECIDED inside stage 1 with a
  // settled winning seat. Unfinished, expanded (stage 2/3) and tie matches are
  // all excluded, and a non-eligible match resolves to `null` (hidden).
  assert.match(
    TTT,
    /const evaluationEligible =\s*finished &&\s*stage === 1 &&\s*\(match\?\.result === "player1" \|\| match\?\.result === "player2"\)/,
  );
  // ...and the evaluator really does reject an expanded / undecided match, so
  // the UI gate above cannot be broader than the server's.
  assert.match(
    TTT_EVALUATOR,
    /if \(state\.stage !== 1 \|\| state\.winner === null\) \{\s*return emptyReport\(input, "not_exactly_evaluable"\)/,
  );
  assert.match(
    TTT_EVALUATOR,
    /if \(input\.result !== "player1" && input\.result !== "player2"\)/,
  );
});

// ════════════════════════════════════════════════════════════════════
// 3. Speed Typing: correct link, correct gate
// ════════════════════════════════════════════════════════════════════

test("speed typing offers See Evaluation → /evaluation/speed-typing/[matchId]", () => {
  assert.match(SPEED, /gameKey="speed-typing"/);
  assert.match(SPEED, /secondaryAction=\{/);
  assert.match(SPEED, /label: "See Evaluation"/);
  assert.match(SPEED, /href: `\/evaluation\/speed-typing\/\$\{matchId\}`/);
  assert.equal(count(SPEED, "secondaryAction="), 1);
  assert.match(
    SPEED,
    /secondaryAction=\{\s*evaluationEligible\s*\? \{ label: "See Evaluation", href: `\/evaluation\/speed-typing\/\$\{matchId\}` \}\s*:\s*null\s*\}/,
  );
});

test("speed typing hides the link unless the race actually finished", () => {
  // Only `finished` is evaluable — a cancelled race has no performance report,
  // even though the arena uses the wider TERMINAL set to close itself.
  assert.match(SPEED, /const finished = TERMINAL\.has\(status\);/);
  assert.match(SPEED, /const evaluationEligible = match\?\.status === "finished";/);
  // The link must not be keyed off the terminal set or the raw `finished` flag.
  assert.doesNotMatch(SPEED, /href: `\/evaluation\/speed-typing\/\$\{matchId\}`[\s\S]{0,40}finished &&/);
});

// ════════════════════════════════════════════════════════════════════
// 4. Errors / insufficient data are handled honestly downstream
// ════════════════════════════════════════════════════════════════════

test("the evaluation page the links open surfaces errors without misleading", () => {
  // Any non-OK answer (422 insufficient data, 404, 5xx, 409 in flight) is
  // rendered as the honest error state with Retry — never an empty report.
  assert.match(EVAL_PAGE, /if \(!res\.ok \|\| !json\?\.success\)/);
  assert.match(EVAL_PAGE, /setErrorMessage\(/);
  assert.match(EVAL_PAGE, /setPhase\("error"\)/);
  assert.match(EVAL_PAGE, /onRetry=\{load\}/);
  // A link is never a promise of results: absent / malformed / unavailable
  // reports each state why.
  assert.match(EVAL_PAGE, /Report unavailable/);
  assert.match(EVAL_PAGE, /No report available/);
  assert.match(EVAL_PAGE, /couldn't be read, so its statistics are not shown/);
});

// ════════════════════════════════════════════════════════════════════
// 5. Chess is unchanged
// ════════════════════════════════════════════════════════════════════

test("chess keeps its existing finished-match evaluation link", () => {
  assert.match(CHESS, /label: "See Evaluation"/);
  assert.match(CHESS, /href: `\/evaluation\/chess\/\$\{gameId\}`/);
  assert.match(
    CHESS,
    /gameData\.status === "finished"[\s\S]{0,160}\? \{ label: "See Evaluation"/,
  );
});
