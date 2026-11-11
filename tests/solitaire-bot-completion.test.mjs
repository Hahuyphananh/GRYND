/**
 * solitaire-bot-completion.test.mjs
 *
 * The practice bot must FINISH the puzzle it is racing, not dead-end and be
 * re-dealt.
 *
 * The v3 deal generator only serves boards that defeat naive play, and a named
 * bot's fair heuristic loses most of them. The store now chooses a deal the bot
 * itself can finish, which is only meaningful if the bot's play is reproducible
 * — so both halves are pinned here: the die is a function of the move cursor,
 * and a plan sliced by the clock plays out exactly like the whole one.
 *
 * Run: node --import tsx --test tests/solitaire-bot-completion.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  botCanFinishDeal,
  botRoll,
  planAiMoves,
} from "../src/lib/solitaire-duel/ai.ts";
import {
  applyMove,
  initialStateFromDeal,
} from "../src/lib/solitaire-duel/rules.ts";
import { constructedDealFromSeed } from "../src/lib/solitaire-duel/solvable.ts";

const SAMPLE_DEAL = constructedDealFromSeed(7);

test("a bot's die is a stable function of the move cursor", () => {
  assert.equal(botRoll(0), botRoll(0));
  assert.equal(botRoll(12), botRoll(12));
  assert.notEqual(botRoll(12), botRoll(13), "adjacent plies must not repeat");
  for (const ply of [0, 1, 2, 5, 40, 300, 1499]) {
    const roll = botRoll(ply);
    assert.ok(Number.isFinite(roll) && roll >= 0 && roll < 1, `ply ${ply}: ${roll}`);
  }
});

test("the bot finishes the deal the store verifies it on", () => {
  assert.equal(botCanFinishDeal({ deal: SAMPLE_DEAL, difficulty: "rookie" }), true);
  const plan = planAiMoves({ state: initialStateFromDeal(SAMPLE_DEAL), difficulty: "rookie", maxMoves: 700 });
  assert.equal(plan.completed, true, "the verified plan must actually complete");
  assert.equal(plan.stuck, false);
});

test("a clock-sliced plan plays exactly like the whole one", () => {
  // The store advances the bot a few plies at a time, once per read. Decisions
  // keyed on Math.random would diverge between those reads, which would make
  // "this deal is finishable" a promise the bot then breaks.
  const full = planAiMoves({
    state: initialStateFromDeal(SAMPLE_DEAL),
    difficulty: "rookie",
    maxMoves: 700,
  });
  assert.equal(full.completed, true);

  let state = initialStateFromDeal(SAMPLE_DEAL);
  const sliced = [];
  for (let slice = 0; slice < 40 && !state.completed; slice += 1) {
    const chunk = planAiMoves({ state, difficulty: "rookie", maxMoves: 9 });
    sliced.push(...chunk.moves);
    for (const move of chunk.moves) {
      const applied = applyMove({ state, move });
      assert.equal(applied.ok, true);
      state = applied.state;
    }
    if (chunk.moves.length === 0) break;
  }
  assert.equal(state.completed, true, "the sliced run must still finish");
  assert.deepEqual(
    sliced.map((move) => JSON.stringify(move)),
    full.moves.map((move) => JSON.stringify(move)),
    "a re-plan from a mid-board must reproduce the verified line",
  );
});

test("an unverifiable deal is simply not claimed", () => {
  assert.equal(botCanFinishDeal({ deal: null, difficulty: "rookie" }), false);
  // A deal the bot cannot finish is reported honestly; the fallback is the
  // store's, not a completion claim.
  const honest = botCanFinishDeal({ deal: SAMPLE_DEAL, difficulty: "perfect", maxMoves: 1 });
  assert.equal(typeof honest, "boolean");
});

test("practice matches are dealt a finishable board, and a stall recovers", () => {
  const strip = (path) =>
    fs
      .readFileSync(path, "utf8")
      .replace(/\r\n/g, "\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const store = strip("src/lib/solitaire-duel/serverStore.ts");

  assert.match(store, /botCanFinishDeal/);
  assert.match(store, /function finishableDealFor\(/);
  assert.match(store, /finishableDealFor\(bot\.id\)/);
  assert.match(store, /AI_DEAL_SEARCH_MS/);
  // The bot's mid-race re-deal must use the same guarantee, not a fresh random
  // proven-solvable board that dead-ends it again.
  assert.match(store, /match\.isAi && seat === SEAT\.PLAYER2/);
  // A stalled heuristic is recovered onto the committed deal's proven line, so
  // the bot always finishes instead of spinning on a dead end.
  assert.match(store, /planAiLine\(/);
  assert.match(store, /solveDealLine\(matchDeal\)/);
  assert.match(store, /aiStagnant/);
});
