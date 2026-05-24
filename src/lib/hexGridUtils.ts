/** Grid size shared across all hex duel modules */
export const GRID_SIZE = 5;

/**
 * Square grid 8-directional adjacency offsets (including diagonals).
 *
 * (-1,-1) (0,-1) (+1,-1)
 * (-1, 0) (x,y)  (+1, 0)
 * (-1,+1) (0,+1) (+1,+1)
 */
export function getHexNeighbors(x: number, y: number): { x: number; y: number }[] {
  const offsets: [number, number][] = [
    [-1, -1], // up-left
    [0, -1],  // up
    [1, -1],  // up-right
    [-1, 0],  // left
    [1, 0],   // right
    [-1, 1],  // down-left
    [0, 1],   // down
    [1, 1],   // down-right
  ];

  return offsets
    .map(([dx, dy]) => ({ x: x + dx, y: y + dy }))
    .filter((c) => c.x >= 0 && c.x < GRID_SIZE && c.y >= 0 && c.y < GRID_SIZE);
}
