// tests/dominoes-practice.test.mjs
//
// FREE PRACTICE VS THE DOMINOES BOT.
//
// Two halves:
//
//   1. THE BOT ITSELF, driven for real. `chooseAiAction` must always answer with
//      an action the shared rules engine accepts — at every difficulty — and the
//      forced draw/pass must never be "improved" on by a tier. Self-play is the
//      strongest cheap check: a bot that ever returned an illegal action would
//      stop the loop on the engine's own rejection.
//
//   2. THE WIRING, as static contracts (the routes need a live database):
//      the practice entry route accepts a guest, the bot is answered INSIDE the
//      human's move transaction, practice settles UNRATED, the lobby offers the
//      shared difficulty picker and the board names the bot seat.
//
// Run:  node --import tsx --test tests/dominoes-practice.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { chooseAiAction } from "../src/lib/dominoes/ai.ts";
import { dealMatch } from "../src/lib/dominoes/deal.ts";
import {
  applyAction,
  legalActions,
  validateAction,
} from "../src/lib/dominoes/rules.ts";
import { ACTION_TYPES, MATCH_STATUS } from "../src/lib/dominoes/constants.ts";

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

/** A deterministic [0,1) source, so a self-play game is reproducible. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ── 1. The bot ──────────────────────────────────────────────────────────────

test("the bot never returns an action the engine rejects (easy / normal / hard)", () => {
  for (const difficulty of ["easy", "normal", "hard"]) {
    for (let seed = 1; seed <= 6; seed += 1) {
      const random = seeded(seed);
      let state = dealMatch(random);
      let guard = 0;

      while (state.status === MATCH_STATUS.PLAYING && guard < 200) {
        guard += 1;
        const seat = state.turn;
        const action = chooseAiAction({ state, seat, difficulty, random });

        assert.ok(action, `a live turn always has a legal action (${difficulty}/${seed})`);
        const verdict = validateAction(state, seat, action);
        assert.equal(
          verdict.ok,
          true,
          `engine rejected ${JSON.stringify(action)} at ${difficulty}/${seed}`,
        );

        // A tier can never dodge a FORCED turn: when no play exists the engine
        // offers exactly one draw (pile not empty) or one pass (pile empty).
        const options = legalActions(state);
        if (options.every((option) => option.type !== ACTION_TYPES.PLAY)) {
          assert.equal(options.length, 1);
          assert.equal(action.type, options[0].type);
        }

        state = applyAction(state, seat, action);
      }

      assert.equal(state.status, MATCH_STATUS.FINISHED, "self-play always terminates");
    }
  }
});

test("the bot stays out of a turn that is not its own, and out of a decided match", () => {
  const state = dealMatch(seeded(11));
  const other = state.turn === "player1" ? "player2" : "player1";
  assert.equal(chooseAiAction({ state, seat: other }), null);
  assert.equal(chooseAiAction({ state: null, seat: state.turn }), null);

  // Play the game out as two bots, then ask again.
  const random = seeded(12);
  let current = dealMatch(random);
  let guard = 0;
  while (current.status === MATCH_STATUS.PLAYING && guard < 200) {
    guard += 1;
    const action = chooseAiAction({ state: current, seat: current.turn, random });
    current = applyAction(current, current.turn, action);
  }
  assert.equal(current.status, MATCH_STATUS.FINISHED);
  assert.equal(
    chooseAiAction({ state: current, seat: current.turn, difficulty: "hard" }),
    null,
  );
});

test("the tier changes the decisions, not the legality", () => {
  const state = dealMatch(seeded(21));
  const seat = state.turn;
  const plays = legalActions(state).filter((o) => o.type === ACTION_TYPES.PLAY);
  if (plays.length < 2) return; // an opening with one option proves nothing

  const easy = chooseAiAction({ state, seat, difficulty: "easy", random: () => 0 });
  const hard = chooseAiAction({ state, seat, difficulty: "hard", random: () => 0 });
  assert.ok(easy && hard);
  // Both are legal; they need not be the same option.
  assert.equal(validateAction(state, seat, easy).ok, true);
  assert.equal(validateAction(state, seat, hard).ok, true);
});

// ── 2. The wiring ───────────────────────────────────────────────────────────

test("the practice entry route accepts guests and delegates to the store", () => {
  const src = read("src/app/api/dominoes/create-ai/route.ts");
  assert.match(src, /requirePracticePlayer\(\{ create: true \}\)/);
  assert.doesNotMatch(src, /requireAgeVerifiedUser/);
  assert.match(src, /createAiMatch\(\{/);
  // The request carries a PREFERENCE only; the server coerces it.
  assert.match(src, /body\?\.difficulty/);
});

test("practice routes authorise by seat; matchmaking stays account-only", () => {
  for (const file of [
    "src/app/api/dominoes/match/[matchId]/route.ts",
    "src/app/api/dominoes/match/[matchId]/move/route.ts",
    "src/app/api/dominoes/match/[matchId]/forfeit/route.ts",
  ]) {
    const src = read(file);
    assert.match(src, /requirePracticePlayer\(\)/, `${file} must accept a guest`);
    assert.doesNotMatch(src, /requireAgeVerifiedUser/, `${file} must not keep the age gate`);
  }
  for (const file of [
    "src/app/api/dominoes/create-or-join/route.ts",
    "src/app/api/dominoes/available/route.ts",
    "src/app/api/dominoes/match/[matchId]/cancel/route.ts",
  ]) {
    const src = read(file);
    assert.match(src, /requireAgeVerifiedUser/, `${file} must stay account-gated`);
    assert.doesNotMatch(src, /requirePracticePlayer/, `${file} must not accept guests`);
  }
});

test("the store seats the bot on player2, answers it inline and settles unrated", () => {
  const store = read("src/lib/dominoes/serverStore.ts");

  // Both seats occupied from creation: a practice row is never an open lobby.
  assert.match(store, /player2Id: DOMINOES_AI_PLAYER_ID/);
  assert.match(store, /isAi: true,/);
  assert.match(store, /aiDifficulty: tier,/);

  // The bot answers inside the caller's transaction — after a human action…
  assert.match(
    store,
    /const finalState =\s*\n?\s*match\.isAi && next\.status === MATCH_STATUS\.PLAYING\s*\n?\s*\? await playAiTurns\(tx, match, next\)/,
  );
  // …and after a timeout that hands it the turn.
  assert.match(store, /match\.isAi && timedOutState\.status === MATCH_STATUS\.PLAYING/);

  // Settlement: practice touches no rating, trophy or W/L counter, and a human
  // win unlocks the daily reward.
  const settle = store.slice(store.indexOf("async function settleMatch("));
  assert.match(settle, /if \(match\.isAi\) \{/);
  assert.match(settle, /markDailyRewardWin\(tx, winnerId\)/);
  const aiBranch = settle.slice(
    settle.indexOf("if (match.isAi) {"),
    settle.indexOf("if (!match.player2Id) return;"),
  );
  assert.doesNotMatch(aiBranch, /applyRatingResult|applyTrophyResult|gamesWon/);

  // The DTO declares the practice flag so the board never has to guess.
  assert.match(store, /isAi: Boolean\(match\.isAi\)/);
  assert.match(store, /aiDifficulty: match\.aiDifficulty \?\? null/);
});

test("the lobby offers Play vs AI with the shared difficulty picker", () => {
  const lobby = read("src/app/casino/dominoes/PageClient.tsx");
  assert.match(lobby, /\/api\/dominoes\/create-ai/);
  assert.match(lobby, /vsAi=\{\{/);
  assert.match(lobby, /AiDifficultyPicker/);
  assert.match(lobby, /gameKey="dominoes"/);
  // The tier is a remembered device preference, like every other game.
  assert.match(lobby, /readStoredAiDifficulty\("dominoes"\)/);
  assert.match(lobby, /storeAiDifficulty\("dominoes", aiDifficulty\)/);
});

test("the board names the bot seat and draws it as AI", () => {
  const view = read("src/components/dominoes/DominoMatchView.tsx");
  assert.match(view, /isAi=\{opponentIsAi\}/);
  assert.match(view, /t\("games\.dominoes\.ai_opponent"\)/);

  const page = read("src/app/casino/dominoes/[matchId]/PageClient.tsx");
  assert.match(page, /match\?\.isAi/);
  assert.match(page, /t\("games\.dominoes\.ai_opponent"\)/);
  // Guests can play: the match page must not gate on a Clerk session.
  assert.doesNotMatch(page, /useUser\(\)/);

  const translations = read("src/lib/appTextTranslations.js");
  const keys = translations.match(/ai_opponent:/g) ?? [];
  assert.equal(keys.length, 3, "the bot's name is translated in every language");
});
