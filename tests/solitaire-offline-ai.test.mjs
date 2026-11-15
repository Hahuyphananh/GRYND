// tests/solitaire-offline-ai.test.mjs
//
// Play vs Bots must work with no server. These tests pin the two halves of
// that:
//
//   * the controller in src/lib/solitaire-duel/localMatch.ts deals, validates,
//     paces the bot and settles entirely in-process, with no fetch/DB import;
//   * the Play vs Bots page actually routes an offline challenge to the local
//     arena instead of posting to /api/solitaire-duel/create-ai.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  advanceAi,
  applyPlayerMove,
  createLocalMatch,
  forfeitIfInactive,
  playerView,
} from "../src/lib/solitaire-duel/localMatch.ts";
import { aiMoveDelayMs, legalMoves } from "../src/lib/solitaire-duel/ai.ts";
import { INACTIVITY_FORFEIT_MS } from "../src/lib/solitaire-duel/constants.ts";

const NOW = 1_700_000_000_000;
const SEED = 0x51ced00d;

function freshMatch(overrides = {}) {
  return createLocalMatch({
    botId: "ace",
    seed: SEED,
    nowMs: NOW,
    countdownMs: 0,
    ...overrides,
  });
}

test("a local match deals both seats the same solvable deal", () => {
  const first = freshMatch();
  const second = freshMatch();

  // Deterministic: the same seed is the same puzzle, always.
  assert.deepEqual(first.deal, second.deal);
  // The same deal, but two independent boards — no shared pile objects.
  assert.notEqual(first.player, first.ai);
  assert.equal(first.player.tableau.length, 7);
  assert.equal(first.ai.tableau.length, 7);
  assert.equal(first.result, null);
  assert.equal(first.goAtMs, NOW);
});

test("the local controller never reaches for the network or the database", () => {
  const source = fs.readFileSync("src/lib/solitaire-duel/localMatch.ts", "utf8");
  // Strip comments first: the header deliberately NAMES the modules this file
  // must never import, so a raw text scan would match its own guardrail.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  for (const forbidden of ["fetch(", "serverStore", "drizzle", "/api/", "socket"]) {
    assert.equal(
      code.includes(forbidden),
      false,
      `localMatch.ts must not reference ${forbidden}`,
    );
  }
});

test("a legal player move is applied by the engine", () => {
  const match = freshMatch();
  const move = legalMoves(match.player)[0];
  assert.ok(move, "a fresh board always has a legal move");

  const outcome = applyPlayerMove(match, move, NOW + 1_000);
  assert.equal(outcome.error, null);
  assert.equal(outcome.match.log.length, 1);
  assert.equal(outcome.match.lastActivityAtMs, NOW + 1_000);
  // The view the board renders is the engine's projection of that move.
  assert.equal(playerView(outcome.match).ply, match.player.ply + 1);
});

test("an illegal move is refused and leaves the board untouched", () => {
  const match = freshMatch();
  // Foundation moves from an empty foundation are only legal for an Ace.
  const bogus = {
    kind: "tableau-to-foundation",
    from: { pile: "tableau", index: 0, cardIndex: 0 },
    to: { pile: "foundation", index: 2 },
  };
  const outcome = applyPlayerMove(match, bogus, NOW + 1_000);
  assert.notEqual(outcome.error, null);
  assert.equal(outcome.match, match);
});

test("the bot is paced by the clock, exactly like the server", () => {
  const match = freshMatch();
  const delay = aiMoveDelayMs("ace");
  const early = advanceAi(match, NOW + delay - 1);
  assert.equal(early.ai.ply, match.ai.ply);

  const later = advanceAi(match, NOW + delay * 4);
  assert.ok(later.ai.ply > match.ai.ply, "the bot has moved by its own pace");
});

test("no move for twenty minutes forfeits the race to the bot", () => {
  const match = freshMatch();
  const before = forfeitIfInactive(match, match.lastActivityAtMs + INACTIVITY_FORFEIT_MS - 1);
  assert.equal(before.result, null);

  const after = forfeitIfInactive(match, match.lastActivityAtMs + INACTIVITY_FORFEIT_MS + 1);
  assert.equal(after.result, "player2");
  assert.equal(after.resolution, "forfeit");
});

test("the Play vs Bots page falls back to the local arena", () => {
  const page = fs.readFileSync(
    "src/app/casino/solitaire-duel/play-ai/PageClient.tsx",
    "utf8",
  );
  assert.match(page, /OfflineSolitaireMatch/);
  assert.match(page, /setOfflineBotId\(bot\.id\)/);
  assert.match(page, /isOfflineError/);
  // No unconditional navigate after a challenge: the offline branch returns
  // before the request is attempted.
  const offlineBranch = page.indexOf("if (!online");
  const request = page.indexOf('fetch("/api/solitaire-duel/create-ai"');
  assert.ok(offlineBranch >= 0 && request > offlineBranch);
  assert.match(page.slice(offlineBranch, request), /setOfflineBotId\(bot\.id\)/);
});
