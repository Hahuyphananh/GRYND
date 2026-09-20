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

export type FourInARowLine = Array<{ row: number; col: number }>;

// Same directions `checkWinner` walks. `findWinningLine` is a READ-ONLY
// companion to it: it never decides a win (checkWinner does that) — it only
// returns the cells the UI should emphasise.
const LINE_DIRECTIONS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
] as const;

/**
 * The cells of the first run of four (or more) connected pieces belonging to
 * `player`, or `null` when there is none. Returns the four cells that form the
 * connection, in order ALONG the line, so a caller can stagger them. Read-only:
 * existing win detection (`checkWinner`) is unchanged and remains the source of
 * truth for whether a game is won.
 */
export function findWinningLine(
  board: FourInARowBoard,
  player: 1 | 2,
): FourInARowLine | null {
  for (let row = 0; row < 6; row += 1) {
    for (let col = 0; col < 7; col += 1) {
      if (board[row]?.[col] !== player) continue;
      for (const [dr, dc] of LINE_DIRECTIONS) {
        // Only start at the first cell of a run, so each line is found once.
        const prevRow = row - dr;
        const prevCol = col - dc;
        if (
          prevRow >= 0 &&
          prevRow < 6 &&
          prevCol >= 0 &&
          prevCol < 7 &&
          board[prevRow][prevCol] === player
        ) {
          continue;
        }
        const cells: FourInARowLine = [];
        let r = row;
        let c = col;
        while (r >= 0 && r < 6 && c >= 0 && c < 7 && board[r][c] === player) {
          cells.push({ row: r, col: c });
          r += dr;
          c += dc;
        }
        if (cells.length >= 4) return cells.slice(0, 4);
      }
    }
  }
  return null;
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
