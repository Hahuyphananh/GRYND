/** Grid size shared across all hex duel modules */
export const GRID_SIZE = 5;

/**
 * Hex adjacency offsets for a flat-top hex grid with offset rows.
 *
 * In a flat-top layout, even rows and odd rows have different neighbor offsets:
 *
 *   Even row (y=0,2,4):
 *     (-1,-1)  (0,-1)
 *   (-1, 0)   (x,y)   (+1, 0)
 *     (-1,+1)  (0,+1)
 *
 *   Odd row (y=1,3):
 *     (0,-1)   (+1,-1)
 *   (-1, 0)   (x,y)   (+1, 0)
 *     (0,+1)   (+1,+1)
 */
export function getHexNeighbors(x: number, y: number): { x: number; y: number }[] {
  const isEvenRow = y % 2 === 0;

  const offsets: [number, number][] = isEvenRow
    ? [
        [-1, -1],
        [0, -1],
        [-1, 0],
        [1, 0],
        [-1, 1],
        [0, 1],
      ]
    : [
        [0, -1],
        [1, -1],
        [-1, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ];

  return offsets
    .map(([dx, dy]) => ({ x: x + dx, y: y + dy }))
    .filter((c) => c.x >= 0 && c.x < GRID_SIZE && c.y >= 0 && c.y < GRID_SIZE);
}
