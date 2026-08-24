import test from "node:test";
import assert from "node:assert/strict";
import { checkWinner, createEmptyBoard, getDropRow, isBoardFull } from "../src/lib/connectFour.ts";

test("Connect Four AI starts with seven legal columns", () => {
  const board = createEmptyBoard();
  assert.deepEqual(
    Array.from({ length: 7 }, (_, col) => getDropRow(board, col)),
    [5, 5, 5, 5, 5, 5, 5],
  );
});

test("Connect Four winner detection remains server-compatible", () => {
  const board = createEmptyBoard();
  board[5][0] = 2;
  board[5][1] = 2;
  board[5][2] = 2;
  board[5][3] = 2;
  assert.equal(checkWinner(board, 5, 3, 2), true);
  assert.equal(isBoardFull(board), false);
});
