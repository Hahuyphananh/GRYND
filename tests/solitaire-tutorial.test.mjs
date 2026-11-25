// tests/solitaire-tutorial.test.mjs
//
// The onboarding tutorial is a REAL game of Klondike: the deal, every guided
// move and every goal predicate are checked through the production engine, so
// this suite is what stops the tutorial from drifting into a mockup.
//
// Run: node --import tsx --test tests/solitaire-tutorial.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  TUTORIAL_DEAL,
  TUTORIAL_STEPS,
  TUTORIAL_STEP_COUNT,
  applyTutorialMove,
  runTutorialSequence,
  tutorialComplete,
  tutorialHintMove,
  tutorialInitialState,
  tutorialStepIndex,
} from "../src/lib/solitaire-duel/tutorial.ts";
import { applyMove, viewForState } from "../src/lib/solitaire-duel/rules.ts";
import { SUITS, TABLEAU_COLUMNS } from "../src/lib/solitaire-duel/constants.ts";

const TUTORIAL_SOURCE = "src/lib/solitaire-duel/tutorial.ts";
const TUTORIAL_UI = "src/components/solitaire-duel/SolitaireTutorial.tsx";

test("the tutorial deal is a complete, unique 52-card deck with seven columns", () => {
  assert.equal(TUTORIAL_DEAL.tableau.length, TABLEAU_COLUMNS);
  const cards = [
    ...TUTORIAL_DEAL.tableau.flatMap((column) => column.map((pile) => pile.card)),
    ...TUTORIAL_DEAL.stock,
  ];
  assert.equal(cards.length, 52, "a full deck, no duplicates and nothing missing");
  const keys = new Set(cards.map((card) => `${card.suit}-${card.rank}`));
  assert.equal(keys.size, 52);
  assert.equal(TUTORIAL_DEAL.stock.length, 47);
  // The four guided cards are where the hints name them.
  assert.deepEqual(TUTORIAL_DEAL.tableau[0][0].card, { suit: "hearts", rank: 1 });
  assert.deepEqual(TUTORIAL_DEAL.tableau[1][0].card, { suit: "hearts", rank: 2 });
  assert.equal(TUTORIAL_DEAL.tableau[2][0].faceUp, false);
  assert.deepEqual(TUTORIAL_DEAL.tableau[2][1].card, { suit: "diamonds", rank: 7 });
  assert.deepEqual(TUTORIAL_DEAL.tableau[3][0].card, { suit: "clubs", rank: 8 });
});

test("the canonical tutorial sequence is legal, ordered and actually completes", () => {
  const result = runTutorialSequence();
  assert.equal(result.ok, true, JSON.stringify(result.trace));
  assert.deepEqual(
    result.trace.map((entry) => [entry.id, entry.legal, entry.stepIndex]),
    [
      ["ace", true, 1],
      ["two", true, 2],
      ["reveal", true, 3],
      ["draw", true, TUTORIAL_STEP_COUNT],
    ],
  );
  assert.equal(tutorialComplete(result.state), true);
  // The reveal goal is met by the ENGINE flipping the 6♠, not by us.
  assert.deepEqual(result.state.tableau[2], [
    { card: { suit: "spades", rank: 6 }, faceUp: true },
  ]);
  // And the draw really moved a card from the stock to the waste.
  assert.equal(result.state.waste.length, 1);
  assert.equal(result.state.stock.length, 46);
});

test("the goal predicates advance one at a time and never skip ahead", () => {
  let state = tutorialInitialState();
  assert.equal(tutorialStepIndex(state), 0);

  const ace = applyTutorialMove({ state, move: TUTORIAL_STEPS[0].move });
  assert.equal(ace.ok, true);
  state = ace.state;
  assert.equal(ace.stepBefore, 0);
  assert.equal(ace.stepAfter, 1);
  assert.equal(ace.advanced, true);
  assert.equal(ace.complete, false);

  // The 2♥ is legal ONLY after the Ace is on the foundation.
  const outOfOrder = applyMove({
    state: tutorialInitialState(),
    move: TUTORIAL_STEPS[1].move,
  });
  assert.equal(outOfOrder.ok, false, "the engine refuses a premature foundation move");

  const two = applyTutorialMove({ state, move: TUTORIAL_STEPS[1].move });
  assert.equal(two.ok, true);
  state = two.state;
  assert.equal(two.stepAfter, 2);

  const reveal = applyTutorialMove({ state, move: TUTORIAL_STEPS[2].move });
  assert.equal(reveal.ok, true);
  state = reveal.state;
  assert.equal(reveal.stepAfter, 3);
  assert.deepEqual(reveal.revealed, [{ suit: "spades", rank: 6 }], "the flip is reported");

  const draw = applyTutorialMove({ state, move: { kind: "draw" } });
  assert.equal(draw.ok, true);
  assert.equal(draw.stepAfter, TUTORIAL_STEP_COUNT);
  assert.equal(draw.complete, true);
});

test("hints only ever name a legal move for the current board", () => {
  const state = tutorialInitialState();
  assert.deepEqual(tutorialHintMove(state), TUTORIAL_STEPS[0].move);

  // A legal-but-off-script move is accepted by the engine and does not break
  // the tutorial: the goal is still the Ace, and its hint is still legal.
  const draw = applyTutorialMove({ state, move: { kind: "draw" } });
  assert.equal(draw.ok, true);
  assert.equal(draw.advanced, false);
  assert.equal(tutorialStepIndex(draw.state), 0);
  assert.deepEqual(tutorialHintMove(draw.state), TUTORIAL_STEPS[0].move);
});

test("illegal input is rejected and never mutates the tutorial board", () => {
  const state = tutorialInitialState();
  const before = JSON.stringify(state);

  const bad = applyTutorialMove({
    state,
    move: {
      kind: "tableau-to-foundation",
      fromColumn: 3,
      card: { suit: "clubs", rank: 8 },
      suit: "clubs",
    },
  });
  assert.equal(bad.ok, false);

  const junk = applyTutorialMove({ state, move: { kind: "nonsense" } });
  assert.equal(junk.ok, false);

  assert.equal(JSON.stringify(state), before, "the state object is untouched");
});

test("the tutorial never stands in for the player and never persists anything", () => {
  const source = fs.readFileSync(TUTORIAL_SOURCE, "utf8");
  // The UI only ever receives a move from the board; nothing applies a
  // canonical move on the player's behalf.
  assert.match(source, /export function applyTutorialMove/);
  assert.match(source, /normalizeMove\(move\)/);
  assert.match(source, /applyMove\(\{ state, move: normalized\.move \}\)/);
  // No ranking, matchmaking, bots or storage is even imported here.
  assert.doesNotMatch(source, /from "\.\/(bots|matchmaking|ranked|elo|trophy)/i);
  assert.doesNotMatch(source, /localStorage|sessionStorage|fetch\(/);
  assert.doesNotMatch(source, /export function (autoPlay|playForPlayer|runTutorial)\(/);
});

test("the tutorial board is rendered from the engine's own projection", () => {
  const view = viewForState(tutorialInitialState());
  assert.equal(view.tableau.length, TABLEAU_COLUMNS);
  assert.equal(view.stockCount, 47);
  // The view exposes only the top of the stock, and it is the engine's pick.
  assert.deepEqual(
    view.nextStockCard,
    TUTORIAL_DEAL.stock[TUTORIAL_DEAL.stock.length - 1],
  );
  // Face-down identities never reach the view.
  assert.deepEqual(view.tableau[2][0], { faceUp: false, card: null });
  for (const suit of SUITS) assert.deepEqual(view.foundations[suit], []);
});

test("the tutorial UI is wired to the real board, engine and Glitch", () => {
  const source = fs.readFileSync(TUTORIAL_UI, "utf8");
  assert.match(source, /<SolitaireBoard/);
  assert.match(source, /applyTutorialMove/);
  assert.match(source, /viewForState/);
  assert.match(source, /GlitchSay/);
  assert.match(source, /placement="inline"/);
  // Skip and restart are real, separate controls, wired to the parent flow.
  assert.match(source, /onboarding\.solitaire\.tutorial\.skip/);
  assert.match(source, /onSkip/);
  assert.match(source, /onComplete/);
  assert.match(source, /tutorialInitialState\(\)/);
  // A move is only ever the board's proposal — never a canned step.
  assert.match(source, /const onMove = useCallback\(\s*\(move: SolitaireMove\)/);
  assert.doesNotMatch(source, /applyTutorialMove\(\{\s*state,\s*move:\s*TUTORIAL_STEPS/);
});
