import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  checkWinner,
  createEmptyBoard,
  findWinningLine,
} from "../src/lib/fourInARow.ts";

// ── Winning-line geometry ──────────────────────────────────────────────
// `findWinningLine` is read-only: it must return exactly the four connected
// cells (in order along the line) for the UI, and must never disagree with the
// existing `checkWinner` gate.

const put = (board, cells, player) => {
  for (const [row, col] of cells) board[row][col] = player;
  return board;
};

const key = (cell) => `${cell.row}-${cell.col}`;
const sorted = (cells) => cells.map(key).sort();
const expected = (cells) => cells.map(([r, c]) => `${r}-${c}`).sort();

// A straight, evenly-spaced run of four, whatever direction it was found from.
const isStraightLine = (cells) => {
  if (!cells || cells.length !== 4) return false;
  const dr = cells[1].row - cells[0].row;
  const dc = cells[1].col - cells[0].col;
  if (dr === 0 && dc === 0) return false;
  if (Math.abs(dr) > 1 || Math.abs(dc) > 1) return false;
  return cells.every(
    (cell, index) =>
      cell.row === cells[0].row + dr * index &&
      cell.col === cells[0].col + dc * index,
  );
};

test("findWinningLine finds a horizontal four", () => {
  const board = createEmptyBoard();
  put(board, [[5, 0], [5, 1], [5, 2], [5, 3]], 1);
  const line = findWinningLine(board, 1);
  assert.deepEqual(sorted(line), expected([[5, 0], [5, 1], [5, 2], [5, 3]]));
  assert.ok(isStraightLine(line));
  assert.equal(checkWinner(board, 5, 3, 1), true);
});

test("findWinningLine finds a vertical four", () => {
  const board = createEmptyBoard();
  put(board, [[2, 4], [3, 4], [4, 4], [5, 4]], 2);
  const line = findWinningLine(board, 2);
  assert.deepEqual(sorted(line), expected([[2, 4], [3, 4], [4, 4], [5, 4]]));
  assert.ok(isStraightLine(line));
  assert.equal(checkWinner(board, 5, 4, 2), true);
});

test("findWinningLine finds both diagonals", () => {
  const upRight = createEmptyBoard();
  put(upRight, [[5, 0], [4, 1], [3, 2], [2, 3]], 1);
  const a = findWinningLine(upRight, 1);
  assert.deepEqual(sorted(a), expected([[2, 3], [3, 2], [4, 1], [5, 0]]));
  assert.ok(isStraightLine(a));
  assert.equal(checkWinner(upRight, 2, 3, 1), true);

  const downRight = createEmptyBoard();
  put(downRight, [[2, 0], [3, 1], [4, 2], [5, 3]], 2);
  const b = findWinningLine(downRight, 2);
  assert.deepEqual(sorted(b), expected([[2, 0], [3, 1], [4, 2], [5, 3]]));
  assert.ok(isStraightLine(b));
  assert.equal(checkWinner(downRight, 2, 0, 2), true);
});

test("findWinningLine returns null without a four", () => {
  const board = createEmptyBoard();
  put(board, [[5, 0], [5, 1], [5, 2]], 1); // three, not four
  put(board, [[5, 4], [4, 4], [3, 4]], 2);
  assert.equal(findWinningLine(board, 1), null);
  assert.equal(findWinningLine(board, 2), null);
});

test("findWinningLine ignores the opponent's pieces", () => {
  const board = createEmptyBoard();
  put(board, [[5, 0], [5, 1], [5, 2], [5, 3]], 1);
  assert.equal(findWinningLine(board, 2), null);
  assert.equal(checkWinner(board, 5, 3, 2), false);
});

test("findWinningLine returns the 4 cells of a longer run", () => {
  const board = createEmptyBoard();
  put(board, [[5, 0], [5, 1], [5, 2], [5, 3], [5, 4]], 1);
  const line = findWinningLine(board, 1);
  assert.equal(line.length, 4);
  assert.ok(isStraightLine(line));
});

// ── UI wiring ──────────────────────────────────────────────────────────
const GAME = fs.readFileSync(
  "src/app/casino/four-in-a-row/game/[gameId]/PageClient.tsx",
  "utf8",
);
const AI = fs.readFileSync(
  "src/app/casino/four-in-a-row/play-ai/PageClient.tsx",
  "utf8",
);
const CSS = fs.readFileSync("src/app/globals.css", "utf8");

for (const [name, src] of [
  ["multiplayer", GAME],
  ["play-ai", AI],
]) {
  test(`Four-In-A-Row (${name}) emphasises the winning four and dims the rest`, () => {
    assert.match(src, /findWinningLine/);
    assert.match(src, /winCells\.has\(cellKey\)/);
    assert.match(src, /"four-in-a-row-win"/);
    assert.match(src, /"four-in-a-row-dim"/);
    // A per-cell stagger along the line.
    assert.match(src, /--win-order/);
  });

  test(`Four-In-A-Row (${name}) holds the result overlay for the reveal`, () => {
    // The hold is derived from the visible line (not effect-set), so it is
    // already in force in the commit that shows the winning four.
    assert.match(src, /const revealHolding =/);
    assert.match(src, /winVisible && winLineKey !== null && revealDoneKey !== winLineKey/);
    assert.match(src, /!revealHolding/);
    // The reveal is keyed on a stable line identity so polling can't restart it.
    assert.match(src, /winLineKey/);
    assert.match(src, /setRevealDoneKey\(winLineKey\)/);
  });
}

test("Four-In-A-Row (multiplayer) only celebrates after the disc lands", () => {
  assert.match(GAME, /const winVisible = Boolean\(winLine\) && !fallingDisc/);
  assert.match(
    GAME,
    /game\?\.status === "finished" && !game\?\.nextGameId && !revealHolding/,
  );
});

test("Four-In-A-Row (play-ai) gates the result screen on the reveal", () => {
  assert.match(AI, /\{isGameEnded && !revealHolding && \(/);
});

test("Four-In-A-Row win emphasis is one-shot and reduced-motion safe", () => {
  assert.match(CSS, /\.four-in-a-row-win\s*\{/);
  assert.match(CSS, /\.four-in-a-row-dim\s*\{/);
  assert.match(CSS, /@keyframes fourInARowWin/);
  // No looping animation anywhere in the win emphasis.
  assert.doesNotMatch(CSS, /fourInARowWin[\s\S]{0,240}infinite/);
  // Reduced motion removes the pop and its stagger entirely.
  assert.match(CSS, /\.four-in-a-row-win \{ animation: none; \}/);
});
