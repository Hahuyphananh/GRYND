/**
 * PvP Keno ("Keno Survival Duel") — AI opponent tests.
 *
 * The bot races for the SAME lit tile as a human and is graded by the same
 * server clock. Its plan is deterministic per (seed, tile index, tile) and
 * it can never tap faster than AI_MIN_REACTION_MS.
 *
 * Under the own-miss rules, SKIPPING a tile is the bot's survival leak
 * (it loses a life for it), so the bot goes for ~90% of tiles instead of
 * the ~55% it used to race for. Its reaction band (200–420ms) stays under
 * the 0.5s floor window, so late tiles are a fair race rather than a coin
 * flip.
 *
 * Run:  node --import tsx --test tests/keno-pvp-ai.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { KENO_POOL_SIZE, MIN_WINDOW_MS, START_WINDOW_MS } from "../src/lib/keno-pvp/constants.js";
import { chooseAiClaim, tileWindowMs } from "../src/lib/keno-pvp/engine.js";

const SEED = "keno-pvp:42:ai";
const STARTED_MS = 1_000_000;

test("the bot's plan is deterministic for the same match + tile", () => {
  const args = { seed: SEED, index: 3, tile: 17, windowMs: 1300, startedMs: STARTED_MS };
  assert.deepEqual(chooseAiClaim(args), chooseAiClaim(args));
});

test("the bot's reaction is always slower than the human's floor — and inside the window", () => {
  let claims = 0;
  let skipped = 0;
  for (let index = 0; index < KENO_POOL_SIZE; index += 1) {
    const tile = (index % KENO_POOL_SIZE) + 1;
    const windowMs = tileWindowMs(index);
    const plan = chooseAiClaim({
      seed: SEED,
      index,
      tile,
      windowMs,
      startedMs: STARTED_MS,
    });
    if (!plan.claims) {
      skipped += 1;
      assert.equal(plan.dueAtMs, null);
      continue;
    }
    claims += 1;
    assert.ok(plan.reactionMs >= 200, `reaction ${plan.reactionMs} is too fast`);
    assert.ok(
      plan.reactionMs <= windowMs,
      `reaction ${plan.reactionMs}ms cannot fit a ${windowMs}ms window`,
    );
    assert.equal(plan.dueAtMs, STARTED_MS + plan.reactionMs);
  }
  // The bot neither ignores every tile nor claims every one: the skips
  // are what cost it lives.
  assert.ok(claims > 0, "the bot never went for a tile");
  assert.ok(skipped > 0, "the bot never skipped a tile");
});

test("the bot goes for ~90% of tiles (its own misses are how it loses lives)", () => {
  let claims = 0;
  for (let index = 0; index < 400; index += 1) {
    const plan = chooseAiClaim({
      seed: `${SEED}:${index}`,
      index,
      tile: (index % KENO_POOL_SIZE) + 1,
      windowMs: START_WINDOW_MS,
      startedMs: STARTED_MS,
    });
    if (plan.claims) claims += 1;
  }
  const rate = claims / 400;
  assert.ok(rate > 0.8 && rate <= 1, `bot claim rate was ${rate}`);
});

test("the reaction band always fits the 0.5s floor window", () => {
  let reachable = 0;
  let skipped = 0;
  for (let index = 0; index < 200; index += 1) {
    const plan = chooseAiClaim({
      seed: `${SEED}:floor:${index}`,
      index,
      tile: (index % KENO_POOL_SIZE) + 1,
      windowMs: MIN_WINDOW_MS,
      startedMs: STARTED_MS,
    });
    if (plan.claims) {
      reachable += 1;
      assert.ok(plan.reactionMs >= 200, `reaction ${plan.reactionMs} is too fast`);
      assert.ok(
        plan.reactionMs <= MIN_WINDOW_MS,
        `reaction ${plan.reactionMs}ms cannot fit a ${MIN_WINDOW_MS}ms window`,
      );
    } else {
      skipped += 1;
    }
  }
  // The band (200–420ms) sits under the floor, so a floor-window tile is
  // always physically reachable — the bot only ever skips by CHOICE, and
  // that choice is what leaks a life.
  assert.ok(reachable > 0, "the bot never claimed a floor-window tile");
  assert.ok(skipped < 40, `the bot skipped ${skipped}/200 floor-window tiles`);
});

test("a malformed tile/window yields no plan at all", () => {
  assert.deepEqual(chooseAiClaim({ seed: SEED, index: 0, tile: null, windowMs: 1000 }), {
    claims: false,
    reactionMs: null,
    dueAtMs: null,
  });
  assert.deepEqual(chooseAiClaim({ seed: SEED, index: 0, tile: 5, windowMs: 0 }), {
    claims: false,
    reactionMs: null,
    dueAtMs: null,
  });
  assert.deepEqual(chooseAiClaim({}), {
    claims: false,
    reactionMs: null,
    dueAtMs: null,
  });
});
