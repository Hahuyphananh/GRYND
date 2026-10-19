// tests/pvp-match-shell.test.mjs
//
// THE MATCH-PAGE SHELL RULE.
//
// A player inside a multiplayer match page must not be able to walk back to
// the lobby: there is no Return to Lobby / Back to Lobby / Lobby button, and
// no `onReturnToLobby` prop feeds the shared result panel. The only way out of
// a live match is Resign (the waiting-table cancel is a different action and
// stays, because no opponent has joined yet).
//
// This test pins that rule across every PvP match page so a future result-screen
// change cannot quietly reintroduce the exit in one game.
//
// Run: node --import tsx --test tests/pvp-match-shell.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

const MATCH_PAGES = {
  "Barrier Blitz": "src/app/casino/barrier-blitz/[matchId]/PageClient.tsx",
  Chess: "src/app/casino/chess-game/[gameId]/PageClient.jsx",
  "Dice Flush": "src/app/casino/dice-flush/PageClient.tsx",
  "Dots & Boxes": "src/app/casino/dots-and-boxes/game/[gameId]/PageClient.tsx",
  "Four in a Row": "src/app/casino/four-in-a-row/game/[gameId]/PageClient.tsx",
  "Hex Duel": "src/app/casino/hex-duel/game/[matchId]/PageClient.tsx",
  "Keno Duel": "src/app/casino/keno-pvp/[matchId]/PageClient.jsx",
  "Lane Rush": "src/app/casino/lane-runner/[matchId]/PageClient.jsx",
  "Memory Grid": "src/app/casino/memory-grid/[matchId]/PageClient.tsx",
  "Mines PvP": "src/app/casino/mines-pvp/[matchId]/PageClient.tsx",
  "Mini Golf": "src/app/casino/mini-golf/[matchId]/PageClient.tsx",
  "Pool Masters": "src/app/casino/pool-masters/game/[matchId]/PageClient.tsx",
  Precision: "src/app/casino/precision/game/[matchId]/PageClient.tsx",
  RPS: "src/app/casino/rps/game/[gameId]/PageClient.tsx",
  "Solitaire Duel": "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx",
  "Speed Typing": "src/app/casino/speed-typing/[matchId]/PageClient.tsx",
  "Sudoku Duel": "src/app/casino/sudoku-duel/[matchId]/PageClient.tsx",
  "Tic-Tac-Toe": "src/app/casino/tic-tac-toe/[matchId]/PageClient.tsx",
  "Tower Arena": "src/app/casino/tower-arena/game/[matchId]/PageClient.tsx",
  Uno: "src/app/casino/uno/game/[gameId]/PageClient.jsx",
};

const LOBBY_BUTTON_RE =
  /(Return to Lobby|Back to Lobby|Back to lobby|Back to the [^"\n]*lobby|>Lobby<|"Lobby"|onReturnToLobby|neonFlush\.lobby|return_to_lobby|back_to_lobby)/;

// Anything that ends the match on the player's own terms. Every game spells it
// Resign or Forfeit; both are accepted.
const RESIGN_RE = /(resign|forfeit|surrender)/i;

for (const [game, path] of Object.entries(MATCH_PAGES)) {
  const source = read(path);

  test(`${game}: a live match has no lobby exit`, () => {
    assert.doesNotMatch(source, LOBBY_BUTTON_RE);
  });

  test(`${game}: the player can resign or forfeit`, () => {
    assert.match(source, RESIGN_RE);
    assert.match(
      source,
      /(data-testid="[^"]*(resign|forfeit)[^"]*"|>\s*(Resign|Forfeit|RESIGN|FORFEIT)\s*<|["'](Resign|Forfeit)["']|resignMatch|resignGame|resignRace|handleResign|handleForfeit|setShowForfeitConfirm|setShowResign)/,
      "a visible resign/forfeit control drives the match exit",
    );
  });
}

test("Keno and Speed Typing resign through a session-authenticated settlement route", () => {
  const kenoPage = read("src/app/casino/keno-pvp/[matchId]/PageClient.jsx");
  const kenoRoute = read("src/app/api/keno-pvp/match/[matchId]/resign/route.js");
  const speedPage = read("src/app/casino/speed-typing/[matchId]/PageClient.tsx");
  const speedRoute = read("src/app/api/speed-typing/match/[matchId]/resign/route.ts");

  assert.match(kenoPage, /\/api\/keno-pvp\/match\/\$\{matchId\}\/resign/);
  assert.match(kenoRoute, /requirePracticePlayer/);
  assert.match(kenoRoute, /forfeitMatch/);

  assert.match(speedPage, /\/api\/speed-typing\/match\/\$\{matchId\}\/resign/);
  assert.match(speedRoute, /requirePracticePlayer/);
  assert.match(speedRoute, /forfeitMatch/);
});

test("the shared result panel only shows its lobby CTA for callers that pass it", () => {
  const panel = read("src/components/result/PvpResultScreen.jsx");
  // AI / practice pages still use the shared CTA, so the panel keeps it; the
  // PvP match pages above simply never pass it.
  assert.match(panel, /onReturnToLobby/);
  assert.match(panel, /\{onReturnToLobby && \(/);
});

test("waiting-table cancellation is still available when no opponent has joined", () => {
  const waitingPages = [
    "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx",
    "src/app/casino/speed-typing/[matchId]/PageClient.tsx",
    "src/app/casino/sudoku-duel/[matchId]/PageClient.tsx",
    "src/app/casino/tic-tac-toe/[matchId]/PageClient.tsx",
  ];
  for (const page of waitingPages) {
    assert.match(read(page), /cancelLobby/, `${page} still cancels an open table`);
  }
});
