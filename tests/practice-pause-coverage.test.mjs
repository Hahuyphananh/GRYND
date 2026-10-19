/**
 * practice-pause-coverage.test.mjs
 *
 * The free-play Pause control is a shared product rule: every human-vs-AI
 * surface offers it, and a server-backed match refuses bot work while the row
 * is paused. These checks pin that coverage page by page so a new practice mode
 * cannot ship without the control, and a page cannot keep the chip while
 * forgetting to freeze its own AI loop.
 *
 * The implementation deliberately has two halves:
 *   • server-backed games use /api/practice/pause (a practice_pauses row), and
 *   • client-only boards (no match row) use the hook's `local` mode.
 * Both render the same chip and overlay.
 *
 * Run: node --import tsx --test tests/practice-pause-coverage.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(rel, "utf8");
const strip = (src) => src.replace(/\r\n/g, "\n");
const stripComments = (src) =>
  src.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const code = (rel) => stripComments(strip(read(rel)));

const {
  PRACTICE_PAUSE_GAMES,
  LOCAL_PRACTICE_PAUSE_GAMES,
  isPracticePauseGame,
} = await import("../src/lib/practicePauseKeys.ts");

// Every page that runs a human-vs-AI game. Add a row here when a new practice
// mode ships; the assertions below are the checklist for it.
const VS_AI_PAGES = {
  // Server-backed practice matches.
  "src/app/casino/chess/ai/ChessAIPageInner.tsx": { game: "chess", local: false },
  "src/app/casino/dice-flush/PageClient.tsx": { game: "dice-flush", local: false },
  "src/app/casino/dots-and-boxes/game/[gameId]/PageClient.tsx": {
    game: "dots-and-boxes",
    local: false,
  },
  "src/app/casino/keno-pvp/[matchId]/PageClient.jsx": { game: "keno-pvp", local: false },
  "src/app/casino/lane-runner/[matchId]/PageClient.jsx": {
    game: "lane-rush-duel",
    local: false,
  },
  "src/app/casino/memory-grid/[matchId]/PageClient.tsx": { game: "memory-grid", local: false },
  "src/app/casino/mines-pvp/[matchId]/PageClient.tsx": { game: "mines-pvp", local: false },
  "src/app/casino/mini-golf/[matchId]/PageClient.tsx": { game: "mini-golf", local: false },
  "src/app/casino/pool-masters/game/[matchId]/PageClient.tsx": { game: "pool", local: false },
  "src/app/casino/precision/game/[matchId]/PageClient.tsx": { game: "precision", local: false },
  "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx": {
    game: "solitaire-duel",
    local: false,
  },
  "src/app/casino/speed-typing/[matchId]/PageClient.tsx": { game: "speed-typing", local: false },
  "src/app/casino/sudoku-duel/[matchId]/PageClient.tsx": { game: "sudoku-duel", local: false },
  "src/app/casino/tic-tac-toe/[matchId]/PageClient.tsx": { game: "tic-tac-toe", local: false },
  "src/app/casino/uno/game/[gameId]/PageClient.jsx": { game: "uno", local: false },
  // Client-only practice boards.
  "src/app/casino/four-in-a-row/play-ai/PageClient.tsx": {
    game: "four-in-a-row",
    local: true,
  },
  "src/app/casino/barrier-blitz/play-ai/PageClient.tsx": {
    game: "barrier-blitz",
    local: true,
  },
  "src/app/casino/hex-duel/game/[matchId]/PageClient.tsx": { game: "hex-duel", local: true },
  "src/app/casino/rps/play-ai/PageClient.tsx": { game: "rps", local: true },
  "src/app/casino/odds/PageClient.tsx": { game: "odds", local: true },
};

test("keys: server-backed and client-only practice games are separated", () => {
  // Existing server-backed games stay on the route.
  for (const game of ["chess", "tic-tac-toe", "uno", "keno-pvp"]) {
    assert.ok(PRACTICE_PAUSE_GAMES.includes(game), `${game} must be pausable`);
  }

  // A client-only board has no row to freeze, so its key must never be accepted
  // by /api/practice/pause.
  for (const game of ["barrier-blitz", "four-in-a-row", "odds", "rps"]) {
    assert.ok(
      LOCAL_PRACTICE_PAUSE_GAMES.includes(game),
      `${game} must be in the local list`,
    );
    assert.equal(
      PRACTICE_PAUSE_GAMES.includes(game),
      false,
      `${game} has no server row and must not reach the route`,
    );
    assert.equal(isPracticePauseGame(game), false);
  }
  assert.equal(isPracticePauseGame("chess"), true);
  assert.equal(isPracticePauseGame("not-a-game"), false);
});

test("every vs-AI page renders the shared pause chip and overlay", () => {
  for (const [path, { game, local }] of Object.entries(VS_AI_PAGES)) {
    const src = code(path);
    assert.match(
      src,
      /usePracticePause/,
      `${path} must use the shared pause hook`,
    );
    assert.match(
      src,
      new RegExp(`game:\\s*"${game}"`),
      `${path} must name its pause game key`,
    );
    assert.match(
      src,
      /<PracticePause(?:Chip)?\b/,
      `${path} must render the pause chip`,
    );
    assert.match(
      src,
      /<PracticePauseOverlay\b/,
      `${path} must render the paused overlay`,
    );
    if (local) {
      assert.match(src, /local:\s*true/, `${path} must use local pause`);
    }
  }
});

test("chess: the server-backed pause stops the clock, the bot and the row", () => {
  const page = code("src/app/casino/chess/ai/ChessAIPageInner.tsx");
  assert.match(page, /isActive:\s*!gameOver && !paused/);
  // The AI effect must be gated and must re-run on resume.
  assert.match(page, /if \(!game \|\| game\.isGameOver\(\) \|\| paused\) return;/);
  assert.match(page, /\}, \[game, aiColor, aiLevel, paused\]\);/);
  // A response that raced the pause is not adopted.
  assert.match(page, /if \(pausedRef\.current\) return;\s*\n\s*adoptAiTurnState/);

  const aiRoute = code("src/app/api/chess/ai-move/route.js");
  assert.match(aiRoute, /isPracticePaused\("chess", gameId\)/);
  assert.match(aiRoute, /status:\s*409/);

  // The human's own write is frozen too, so a second tab cannot move behind the
  // overlay. PvP chess is never pausable.
  const moveRoute = code("src/app/api/chess/move/route.js");
  assert.match(
    moveRoute,
    /game\.isAiGame && \(await isPracticePaused\("chess", normalizedGameId\)\)/,
  );

  // A poll during the pause cannot settle the frozen clock into a timeout.
  const stateRoute = code("src/app/api/chess/game-state/route.js");
  assert.match(stateRoute, /isPracticePaused\("chess", gameId\)/);
  assert.match(stateRoute, /if \(!paused\) game = await settleTimeoutIfNeeded\(game, clocks\);/);
});

test("client-only boards freeze their own AI loop while paused", () => {
  // Four-in-a-row: the scheduled bot turn re-checks the pause ref instead of
  // computing a move behind the overlay.
  const fiar = code("src/app/casino/four-in-a-row/play-ai/PageClient.tsx");
  assert.match(fiar, /if \(pausedRef\.current\) \{\s*window\.setTimeout\(runAiTurn, 150\);/);
  assert.match(fiar, /status !== "playing" \|\|[\s\S]{0,120}pausedRef\.current/);

  // Barrier Blitz: its bot effect does not run (and is cleaned up) while paused.
  const barrier = code("src/app/casino/barrier-blitz/play-ai/PageClient.tsx");
  assert.match(
    barrier,
    /if \(matchOver \|\| paused \|\| state\.turn !== AI_SEAT\) return undefined;/,
  );

  // RPS: a throw already in flight waits for resume before revealing.
  const rps = code("src/app/casino/rps/play-ai/PageClient.tsx");
  assert.match(rps, /while \(pausedRef\.current\) \{/);
  assert.match(rps, /phase !== "picking" \|\| aiThinking \|\| pausedRef\.current/);

  // Odds: no pick (manual or autopick) is accepted under the overlay.
  const odds = code("src/app/casino/odds/PageClient.tsx");
  assert.match(odds, /if \(pausedRef\.current\) return;/);
  assert.match(odds, /if \(!interactiveState \|\| gameOver \|\| isSubmitting \|\| paused\) return;/);
});

test("tower arena keeps its own pause implementation", () => {
  const page = code("src/app/casino/tower-arena/game/[matchId]/PageClient.tsx");
  assert.match(page, /const togglePause = async \(\) =>/);
  assert.match(page, /<PauseChip paused=\{isPaused\}/);
  assert.match(page, /\/api\/tower-arena\/pause/);
});
