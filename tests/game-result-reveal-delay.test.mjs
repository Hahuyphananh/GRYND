// tests/game-result-reveal-delay.test.mjs
//
// THE 3s RESULT BEAT.
//
// A match that ends must not slam a WIN / LOSS panel over the final board: the
// result popup is held back for three seconds, so the last move — the winning
// line, the last ball, the losing tile — is what the player reads first. The
// hold lives in ONE place (the shared PvpResultScreen), because every game's
// win / loss / draw popup mounts through it. UNO, which draws its own end
// panel, holds the same beat itself.
//
// This is the audit in test form: a match page with a result popup either
// routes through the shared screen or implements the hold, and no page may
// stack its own pre-delay on top of the 3s (that would make the wait longer
// than the spec).
//
// Run: node --test tests/game-result-reveal-delay.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

const SHARED_SCREEN = "src/components/result/PvpResultScreen.jsx";
const PRECISION_POPUP = "src/components/precision/PrecisionResultPopup.tsx";
const UNO_PAGE = "src/app/casino/uno/game/[gameId]/PageClient.jsx";

// Every game whose win / loss / draw popup is the shared result screen. If a
// new match page grows a result popup, it belongs in this list.
const SHARED_SCREEN_PAGES = {
  "Barrier Blitz": "src/app/casino/barrier-blitz/[matchId]/PageClient.tsx",
  "Barrier Blitz (practice)": "src/app/casino/barrier-blitz/play-ai/PageClient.tsx",
  "Chess vs AI": "src/app/casino/chess/ai/ChessAIPageInner.tsx",
  "Chess Arena": "src/app/casino/chess-game/[gameId]/PageClient.jsx",
  "Dice Flush": "src/app/casino/dice-flush/PageClient.tsx",
  Dominoes: "src/app/casino/dominoes/[matchId]/PageClient.tsx",
  "Dots & Boxes": "src/app/casino/dots-and-boxes/game/[gameId]/PageClient.tsx",
  "Four in a Row": "src/app/casino/four-in-a-row/game/[gameId]/PageClient.tsx",
  "Four in a Row vs AI": "src/app/casino/four-in-a-row/play-ai/PageClient.tsx",
  "Hex Duel": "src/app/casino/hex-duel/game/[matchId]/PageClient.tsx",
  Hillstrike: "src/app/casino/hillstrike/[matchId]/PageClient.tsx",
  "Hillstrike (practice)": "src/app/casino/hillstrike/play-ai/PageClient.tsx",
  "Keno Duel": "src/app/casino/keno-pvp/[matchId]/PageClient.jsx",
  "Lane Rush Duel": "src/app/casino/lane-runner/[matchId]/PageClient.jsx",
  "Memory Grid": "src/app/casino/memory-grid/[matchId]/PageClient.tsx",
  "Mines Duel": "src/app/casino/mines-pvp/[matchId]/PageClient.tsx",
  "Mini Golf": "src/app/casino/mini-golf/[matchId]/PageClient.tsx",
  Odds: "src/app/casino/odds/game/[matchId]/PageClient.tsx",
  "Pool Masters": "src/app/casino/pool-masters/game/[matchId]/PageClient.tsx",
  RPS: "src/app/casino/rps/game/[gameId]/PageClient.tsx",
  "RPS vs AI": "src/app/casino/rps/play-ai/PageClient.tsx",
  "Solitaire Duel": "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx",
  "Speed Typing": "src/app/casino/speed-typing/[matchId]/PageClient.tsx",
  "Sudoku Duel": "src/app/casino/sudoku-duel/[matchId]/PageClient.tsx",
  "Tic-Tac-Toe": "src/app/casino/tic-tac-toe/[matchId]/PageClient.tsx",
  "Tower Arena": "src/app/casino/tower-arena/game/[matchId]/PageClient.tsx",
};

test("the shared result screen holds the popup for 3s", () => {
  const src = read(SHARED_SCREEN);

  assert.match(
    src,
    /export const RESULT_REVEAL_DELAY_MS = 3_000;/,
    "the platform-wide beat is one exported constant",
  );
  assert.match(
    src,
    /setTimeout\(\(\) => setRevealed\(true\), hold\)/,
    "the overlay is revealed by a timer, not by the finished flag itself",
  );
  assert.match(
    src,
    /\{revealed && \(/,
    "the overlay renders from the held flag",
  );
  assert.doesNotMatch(
    src,
    /\{open && \(/,
    "no render path may show the result the instant `open` flips",
  );
});

test("every game's result popup goes through the shared 3s hold", () => {
  for (const [game, path] of Object.entries(SHARED_SCREEN_PAGES)) {
    assert.match(
      read(path),
      /components\/result\/PvpResultScreen/,
      `${game} must mount the shared result screen (it owns the 3s hold)`,
    );
  }
  // Precision's page keeps its own replay-window adapter, so the shared
  // screen — and its hold — must still be behind it.
  assert.match(
    read(PRECISION_POPUP),
    /\.\.\/result\/PvpResultScreen/,
    "Precision must hand its match-end popup to the shared screen",
  );
});

test("UNO's own end panel holds the same 3s beat", () => {
  const src = read(UNO_PAGE);

  assert.match(src, /const END_PANEL_DELAY_MS = 3_000;/, "UNO holds 3s itself");
  assert.match(
    src,
    /setTimeout\(\(\) => setEndPopupVisible\(true\), END_PANEL_DELAY_MS\)/,
    "the panel appears on a timer",
  );
  assert.match(
    src,
    /\{endPopup && endPopupVisible && \(/,
    "the panel renders from the held flag",
  );
  assert.match(
    src,
    /endPopup\.openedAt \+ END_PANEL_DELAY_MS \+ 15000/,
    "the 15s replay window starts when the panel appears, not during the hold",
  );
});

test("Battleship's victory / defeat popup holds its 2s beat", () => {
  // Battleship does not mount the shared screen: it draws a compact victory /
  // defeat popup over the combat screen (`data-testid="battle-result"`), held
  // 2s after the server's verdict.
  const src = read("src/components/games/battleship/BattlePreview.tsx");
  assert.match(src, /export const BATTLE_RESULT_DELAY_MS = 2_000;/, "the hold is 2s");
  assert.match(
    src,
    /data-testid="battle-result-overlay"/,
    "the verdict is a popup, not an inline strip",
  );
  assert.match(src, /role="dialog"/, "the popup is a dialog");
  assert.match(
    src,
    /max-w-\[20rem\]/,
    "the popup is a compact card, not a full result page",
  );
  assert.match(
    src,
    /setTimeout\(\(\) => setRevealedResult\(result\), BATTLE_RESULT_DELAY_MS\)/,
    "the panel appears on a timer, not with the finished snapshot",
  );
  assert.match(
    src,
    /const resultLabel = seatResultLabel\(revealedResult, seat\);/,
    "the visible label reads the held result",
  );
});

test("no game stacks its own popup hold on top of the 3s beat", () => {
  // Keno used to hold its shared popup 1.2s (3s + 1.2s = 4.2s) and Pool 600ms
  // (3.6s). Both holds are now the shared screen's alone.
  const keno = read("src/app/casino/keno-pvp/[matchId]/PageClient.jsx");
  assert.doesNotMatch(
    keno,
    /setShowResult\(true\), 1200/,
    "Keno must not pre-delay the shared result screen",
  );
  const pool = read("src/app/casino/pool-masters/game/[matchId]/PageClient.tsx");
  assert.doesNotMatch(
    pool,
    /setShowWinLossPopup\(true\), 600/,
    "Pool Masters must not pre-delay the shared result screen",
  );
});
