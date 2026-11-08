/**
 * solitaire-duel-bots.test.mjs
 *
 * The named-bot roster, pinned by BEHAVIOUR — not by reading the config back.
 *
 * Every test drives the real decision engine (`chooseAiMove`) on deterministic
 * deals and scores the chosen move with Perfect's full visible-information
 * search (`evaluateMoveForBot(..., "perfect")`). The strength test therefore
 * measures decision regret: Rookie must give up more than Felix, Felix more than
 * Ace, and so on to Perfect. Pacing and mistake rates are not treated as proof.
 *
 * FAIRNESS. Perfect is given the same board a human sees. The hidden-information
 * test mutates ONLY face-down card identities and stock order — information the
 * player cannot observe — and proves Perfect's move and every move score are
 * unchanged.
 *
 * Run: node --import tsx --test tests/solitaire-duel-bots.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  SOLITAIRE_BOTS,
  SOLITAIRE_BOT_BY_ID,
  isSolitaireBotId,
  publicSolitaireBot,
  solitaireBotFor,
} from "../src/lib/solitaire-duel/bots.ts";
import {
  chooseAiMove,
  evaluateMoveForBot,
  legalMoves,
} from "../src/lib/solitaire-duel/ai.ts";
import {
  applyMove,
  initialStateFromDeal,
} from "../src/lib/solitaire-duel/rules.ts";
import { solvableDealFromSeed } from "../src/lib/solitaire-duel/solvable.ts";

const BOT_ORDER = ["rookie", "felix", "ace", "professor", "grandmaster", "perfect"];

/** A deterministic roll sequence, so every run compares the same decisions. */
function rollFrom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const sameMove = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Fixed, reproducible positions reached by Perfect's own visible play from
 * proven-solvable deals. Every position has a real choice (two or more legal
 * moves), so it can separate the profiles.
 */
function positions() {
  const found = [];
  for (const seed of [7, 2026, 4242, 31337, 99, 104729]) {
    let state = initialStateFromDeal(solvableDealFromSeed(seed));
    for (let ply = 0; ply < 12 && !state.completed; ply += 1) {
      if (legalMoves(state).length >= 2) found.push(state);
      const move = chooseAiMove({ state, botId: "perfect", random: () => 1 });
      if (!move) break;
      const applied = applyMove({ state, move });
      if (!applied.ok) break;
      state = applied.state;
    }
  }
  return found;
}

const POSITIONS = positions();

/** Change ONLY what the human cannot see: hidden identities and stock order. */
function hideInformation(state) {
  const next = structuredClone(state);
  next.stock = [...next.stock].reverse();
  for (const column of next.tableau ?? []) {
    for (const pile of column) {
      if (pile.faceUp || !pile.card) continue;
      pile.card = {
        suit: pile.card.suit,
        // A guaranteed different hidden rank. Nothing in the evaluator may read
        // this while the card is face down.
        rank: (pile.card.rank % 13) + 1,
      };
    }
  }
  return next;
}

// ── Roster and selection ─────────────────────────────────────────────────

test("the roster is the six named opponents, with stable short ids", () => {
  assert.deepEqual(
    SOLITAIRE_BOTS.map((bot) => bot.id),
    BOT_ORDER,
  );
  const expected = {
    rookie: [200, "200", "Very Easy", "Beginner"],
    felix: [1000, "1,000", "Easy", "Beginner"],
    ace: [3000, "3,000", "Intermediate", "Intermediate"],
    professor: [6500, "6,500", "Hard", "Intermediate"],
    grandmaster: [10000, "10,000", "Expert", "Advanced"],
    perfect: [null, "PERFECT", "Perfect", "Advanced"],
  };

  for (const bot of SOLITAIRE_BOTS) {
    assert.equal(bot.rating, expected[bot.id][0], `${bot.id} rating`);
    assert.equal(bot.ratingLabel, expected[bot.id][1], `${bot.id} label`);
    assert.equal(bot.difficultyLabel, expected[bot.id][2], `${bot.id} difficulty`);
    assert.equal(bot.audienceLabel, expected[bot.id][3], `${bot.id} audience`);
    assert.ok(bot.description.length > 20, `${bot.id} needs real copy`);
    assert.equal(bot.avatar.src, null, "no external or generated avatar yet");
    assert.ok(bot.avatar.alt.length > 0);
    assert.ok(bot.id.length <= 16, "the stable id fits the existing varchar(16)");
    assert.equal(isSolitaireBotId(bot.id), true);
  }

  // Perfect is a special challenge, not a numeric player trophy.
  assert.equal(SOLITAIRE_BOT_BY_ID.perfect.rating, null);
  assert.equal(SOLITAIRE_BOT_BY_ID.perfect.ratingLabel, "PERFECT");
  // The public DTO carries identity but never the internal AI profile.
  const pub = publicSolitaireBot(SOLITAIRE_BOT_BY_ID.perfect);
  assert.equal(pub.name, "Perfect");
  assert.equal(pub.ratingLabel, "PERFECT");
  assert.equal("ai" in pub, false);
});

test("selection resolves named bots and legacy tiers without inventing one", () => {
  for (const id of BOT_ORDER) {
    assert.equal(solitaireBotFor(id).id, id);
    assert.equal(solitaireBotFor(id.toUpperCase()).id, id);
  }
  assert.equal(solitaireBotFor("easy").id, "rookie");
  assert.equal(solitaireBotFor("normal").id, "ace");
  assert.equal(solitaireBotFor("hard").id, "grandmaster");
  assert.equal(solitaireBotFor("expert").id, "perfect");
  assert.equal(solitaireBotFor("advanced").id, "professor");
  assert.equal(solitaireBotFor(null).id, "ace");
  assert.equal(solitaireBotFor("not-a-bot").id, "ace");
});

// ── Legality ─────────────────────────────────────────────────────────────

test("every bot only ever makes a legal move, from real deals", () => {
  for (const seed of [7, 2026, 4242, 31337, 99, 104729]) {
    for (const id of BOT_ORDER) {
      const random = rollFrom(seed);
      let state = initialStateFromDeal(solvableDealFromSeed(seed));
      let played = 0;
      for (let ply = 0; ply < 12 && !state.completed; ply += 1) {
        const moves = legalMoves(state);
        const chosen = chooseAiMove({ state, botId: id, random });
        if (moves.length === 0) {
          assert.equal(chosen, null, `${id}/seed ${seed}: no move on a dead board`);
          break;
        }
        assert.ok(chosen, `${id}/seed ${seed}: a live board must get a move`);
        assert.ok(
          moves.some((move) => sameMove(move, chosen)),
          `${id}/seed ${seed}: chosen move must be in legalMoves`,
        );
        const applied = applyMove({ state, move: chosen });
        assert.equal(applied.ok, true, `${id}/seed ${seed}: engine must accept it`);
        state = applied.state;
        played += 1;
      }
      assert.ok(played > 0, `${id}/seed ${seed}: the bot must actually play`);
    }
  }
});

// ── Genuine strength ordering ────────────────────────────────────────────

test("decision quality is strictly ordered Rookie < … < Perfect", () => {
  assert.ok(POSITIONS.length >= 20, "the fixed sample must contain real choices");

  const quality = {};
  for (const id of BOT_ORDER) {
    const random = rollFrom(0x5eed);
    let total = 0;
    let count = 0;
    for (const state of POSITIONS) {
      for (let sample = 0; sample < 5; sample += 1) {
        const move = chooseAiMove({ state, botId: id, random });
        if (!move) continue;
        // Perfect's full profile is the strongest fair objective available.
        total += evaluateMoveForBot(state, move, "perfect");
        count += 1;
      }
    }
    assert.ok(count > 0, `${id} produced decisions`);
    quality[id] = total / count;
  }

  for (let i = 1; i < BOT_ORDER.length; i += 1) {
    const weaker = BOT_ORDER[i - 1];
    const stronger = BOT_ORDER[i];
    assert.ok(
      quality[weaker] < quality[stronger],
      `${weaker} (${quality[weaker].toFixed(1)}) must decide worse than ` +
        `${stronger} (${quality[stronger].toFixed(1)})`,
    );
  }
});

test("the profiles do not all make the same decision", () => {
  let differingPositions = 0;
  for (const state of POSITIONS) {
    const choices = new Set(
      SOLITAIRE_BOTS.map((bot) =>
        JSON.stringify(chooseAiMove({ state, botId: bot.id, random: () => 1 })),
      ),
    );
    if (choices.size > 1) differingPositions += 1;
  }
  assert.ok(
    differingPositions > 0,
    "at least one fixed position must separate the named profiles",
  );
});

// ── Perfect: strongest fair move, never a deliberate slip ────────────────

test("Perfect always takes a highest-scoring legal move and never rolls a mistake", () => {
  for (const state of POSITIONS) {
    const moves = legalMoves(state);
    const best = Math.max(...moves.map((move) => evaluateMoveForBot(state, move, "perfect")));
    const chosen = chooseAiMove({ state, botId: "perfect", random: () => 0 });
    assert.ok(chosen, "a live position has a Perfect move");
    assert.equal(
      evaluateMoveForBot(state, chosen, "perfect"),
      best,
      "Perfect must not leave a demonstrably better move available",
    );
    assert.ok(moves.some((move) => sameMove(move, chosen)));
    // The roll cannot change a zero-mistake profile's decision.
    assert.deepEqual(
      chooseAiMove({ state, botId: "perfect", random: () => 0.999 }),
      chosen,
    );
  }
});

test("Perfect's decision is invariant to hidden cards and stock order", () => {
  for (const state of POSITIONS) {
    const hidden = hideInformation(state);
    assert.notDeepEqual(hidden, state, "the fixture must actually hide something");
    assert.deepEqual(
      legalMoves(hidden),
      legalMoves(state),
      "hidden identities do not change the legal move set",
    );

    const onVisible = chooseAiMove({ state, botId: "perfect", random: () => 1 });
    const onHidden = chooseAiMove({ state: hidden, botId: "perfect", random: () => 1 });
    assert.deepEqual(
      onHidden,
      onVisible,
      "Perfect must not use information behind a face-down card or in the stock",
    );

    for (const move of legalMoves(state)) {
      assert.equal(
        evaluateMoveForBot(hidden, move, "perfect"),
        evaluateMoveForBot(state, move, "perfect"),
        "no move may be scored differently from hidden information",
      );
    }
  }
});

// ── The server/standalone never hand the bot the solution ────────────────

test("practice code does not consult the proven deal solution", () => {
  const strip = (path) =>
    fs
      .readFileSync(path, "utf8")
      .replace(/\r\n/g, "\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  const store = strip("src/lib/solitaire-duel/serverStore.ts");
  assert.match(store, /planAiMoves\(\{/);
  assert.doesNotMatch(store, /planAiSolution|solveDealLine/);

  const standalone = strip("standalone/solitaire-duel/src/match.ts");
  assert.match(standalone, /planAiMoves\(\{/);
  assert.doesNotMatch(standalone, /planAiSolution|solveDealLine/);
});
