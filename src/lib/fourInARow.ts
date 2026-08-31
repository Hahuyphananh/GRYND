export type FourInARowCell = 0 | 1 | 2;
export type FourInARowBoard = FourInARowCell[][];

export function createEmptyBoard(): FourInARowBoard {
  return Array.from({ length: 6 }, () =>
    Array.from({ length: 7 }, () => 0 as FourInARowCell),
  );
}

export function cloneBoard(board: FourInARowBoard): FourInARowBoard {
  return board.map((row) => [...row]) as FourInARowBoard;
}

export function getDropRow(board: FourInARowBoard, col: number): number {
  if (col < 0 || col > 6) return -1;
  for (let row = 5; row >= 0; row -= 1) {
    if (board[row][col] === 0) return row;
  }
  return -1;
}

export function isBoardFull(board: FourInARowBoard): boolean {
  return board[0].every((cell) => cell !== 0);
}

function countDirection(
  board: FourInARowBoard,
  row: number,
  col: number,
  dr: number,
  dc: number,
  player: 1 | 2,
): number {
  let r = row + dr;
  let c = col + dc;
  let count = 0;

  while (r >= 0 && r < 6 && c >= 0 && c < 7 && board[r][c] === player) {
    count += 1;
    r += dr;
    c += dc;
  }

  return count;
}

export function checkWinner(
  board: FourInARowBoard,
  row: number,
  col: number,
  player: 1 | 2,
): boolean {
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ] as const;

  for (const [dr, dc] of directions) {
    const total =
      1 +
      countDirection(board, row, col, dr, dc, player) +
      countDirection(board, row, col, -dr, -dc, player);
    if (total >= 4) return true;
  }

  return false;
}
