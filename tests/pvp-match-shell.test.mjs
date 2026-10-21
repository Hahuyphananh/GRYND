// tests/pvp-match-shell.test.mjs
//
// THE MATCH-PAGE SHELL RULE.
//
// A player inside a LIVE match must not be able to walk back to the lobby:
// there is no Return to Lobby / Back to Lobby / Lobby button, and the shared
// result panel's lobby CTA may only be passed behind a PRACTICE check. The only
// way out of a live match is Resign (the waiting-table cancel is a different
// action and stays, because no opponent has joined yet).
//
// Practice / vs-AI matches are the exception, by product decision: their
// win / loss / draw popup carries the "Return to Lobby" button, while the game
// page itself no longer does (that in-page button is what the shell rule
// originally removed — the popup is now the one place it lives). Every
// `onReturnToLobby` in these pages must therefore name the game's own AI flag,
// and every game's match-end popup must pass one.
//
// This test pins both halves across every PvP match page so a future
// result-screen change can neither quietly reintroduce a live-match exit nor
// drop the practice exit.
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
  /(Return to Lobby|Back to Lobby|Back to lobby|Back to the [^"\n]*lobby|>Lobby<|"Lobby"|neonFlush\.lobby|return_to_lobby|back_to_lobby)/;

// The game's own practice flag. The popup CTA must be gated on one of these, so
// a live match can never reach it.
const AI_GATE_RE = /(isAi|isAI|isAiGame|aiEnabled|aiMode|isBotMatch|opponentIsAi|oppLabel === "AI")/;

// The pages that can host a PRACTICE (vs-AI) match, so their match-end popup
// must offer the lobby CTA. Every other page in MATCH_PAGES is PvP-only: it must
// not pass one at all.
const PRACTICE_PAGES = new Set([
  "src/app/casino/dice-flush/PageClient.tsx",
  "src/app/casino/dots-and-boxes/game/[gameId]/PageClient.tsx",
  "src/app/casino/hex-duel/game/[matchId]/PageClient.tsx",
  "src/app/casino/keno-pvp/[matchId]/PageClient.jsx",
  "src/app/casino/memory-grid/[matchId]/PageClient.tsx",
  "src/app/casino/mines-pvp/[matchId]/PageClient.tsx",
  "src/app/casino/mini-golf/[matchId]/PageClient.tsx",
  "src/app/casino/pool-masters/game/[matchId]/PageClient.tsx",
  "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx",
  "src/app/casino/speed-typing/[matchId]/PageClient.tsx",
  "src/app/casino/sudoku-duel/[matchId]/PageClient.tsx",
  "src/app/casino/tic-tac-toe/[matchId]/PageClient.tsx",
  "src/app/casino/tower-arena/game/[matchId]/PageClient.tsx",
]);

// Lane Rush already offers the lobby as a game link ("Back to Lane Rush"), and
// Precision's round-popup game auto-returns when the replay window closes —
// neither grows a second CTA.
const NO_CTA_BY_DESIGN = new Set([
  "src/app/casino/lane-runner/[matchId]/PageClient.jsx",
  "src/app/casino/precision/game/[matchId]/PageClient.tsx",
]);

// Anything that ends the match on the player's own terms. Every game spells it
// Resign or Forfeit; both are accepted.
const RESIGN_RE = /(resign|forfeit|surrender)/i;

for (const [game, path] of Object.entries(MATCH_PAGES)) {
  const source = read(path);

  test(`${game}: a live match has no lobby exit`, () => {
    // No lobby button of any kind is drawn by the page itself.
    assert.doesNotMatch(source, LOBBY_BUTTON_RE);
    // The shared panel's CTA is only ever gated on a practice match.
    for (const call of source.match(/onReturnToLobby=\{[\s\S]*?\}/g) ?? []) {
      assert.match(
        call,
        AI_GATE_RE,
        `${game}: onReturnToLobby must be gated on the match's own AI flag`,
      );
    }
  });

  test(`${game}: the result popup carries the practice lobby exit`, () => {
    if (PRACTICE_PAGES.has(path)) {
      // Dice Flush's lobby is the page's own table list, so it resets in place
      // instead of routing; every other practice page navigates to its lobby.
      assert.match(
        source,
        /onReturnToLobby=\{[\s\S]*?(router\.push\(|resetToLobby)[\s\S]*?\}/,
        "a practice match must be able to return to the lobby from its result popup",
      );
      return;
    }
    if (NO_CTA_BY_DESIGN.has(path)) {
      assert.doesNotMatch(source, /onReturnToLobby/);
      return;
    }
    // PvP-only page: no CTA, ever.
    assert.doesNotMatch(source, /onReturnToLobby/);
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
