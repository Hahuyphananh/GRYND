import type { DuelPlayer } from "./hexDuelEngine";
import { GRID_SIZE, getHexNeighbors } from "./hexGridUtils";

// ── Types ──────────────────────────────────────────────────────────────────

export interface WinCheckParams {
  capturedTiles: Record<string, DuelPlayer>;
  player1Pos: { x: number; y: number };
  player2Pos: { x: number; y: number };
}

/**
 * Builds the full set of tiles owned by a given player.
 * Includes both explicit captures and the unit's current position.
 */
function getOwnedTiles(
  player: DuelPlayer,
  capturedTiles: Record<string, DuelPlayer>,
  player1Pos: { x: number; y: number },
  player2Pos: { x: number; y: number }
): Set<string> {
  const owned = new Set<string>();

  // Add explicitly captured tiles
  for (const [key, owner] of Object.entries(capturedTiles)) {
    if (owner === player) owned.add(key);
  }

  // Add unit position (always counts as owned)
  const pos = player === "player1" ? player1Pos : player2Pos;
  owned.add(`${pos.x},${pos.y}`);

  return owned;
}

/**
 * BFS connectivity check: can we reach from `startEdge` to `targetEdge`
 * using only tiles owned by the player?
 *
 * @param ownedTiles - Set of "x,y" keys the player owns
 * @param startEdge - Array of "x,y" keys on the starting edge
 * @param targetRowOrCol - Predicate testing if a tile is on the target edge
 * @returns true if there's a connected path from start edge to target edge
 */
function hasConnectedPath(
  ownedTiles: Set<string>,
  startEdge: string[],
  isTargetEdge: (x: number, y: number) => boolean
): boolean {
  if (startEdge.length === 0) return false;

  const visited = new Set<string>();
  const queue: string[] = [];

  // Seed BFS with starting-edge tiles that the player owns
  for (const key of startEdge) {
    if (ownedTiles.has(key)) {
      queue.push(key);
      visited.add(key);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const [cx, cy] = current.split(",").map(Number);

    // Check if we've reached the target edge
    if (isTargetEdge(cx, cy)) return true;

    // Explore neighbors
    for (const neighbor of getHexNeighbors(cx, cy)) {
      const nKey = `${neighbor.x},${neighbor.y}`;
      if (ownedTiles.has(nKey) && !visited.has(nKey)) {
        visited.add(nKey);
        queue.push(nKey);
      }
    }
  }

  return false;
}

// ── Main win condition check ───────────────────────────────────────────────

/**
 * Checks if either player has won by connecting their side of the board
 * to the opposite side using owned hexes.
 *
 * Player 1 (blue): top edge (y=0) → bottom edge (y=4)
 * Player 2 (red):  left edge (x=0) → right edge (x=4)
 *
 * @returns The winning player, or null if no winner yet.
 */
export function checkWinCondition({
  capturedTiles,
  player1Pos,
  player2Pos,
}: WinCheckParams): DuelPlayer | null {
  // ── Player 1: top (y=0) → bottom (y=4) ─────────────────────────────
  const p1Owned = getOwnedTiles("player1", capturedTiles, player1Pos, player2Pos);

  const topEdge: string[] = [];
  for (let x = 0; x < GRID_SIZE; x++) {
    topEdge.push(`${x},0`);
  }

  if (hasConnectedPath(p1Owned, topEdge, (_x, y) => y === GRID_SIZE - 1)) {
    return "player1";
  }

  // ── Player 2: left (x=0) → right (x=4) ────────────────────────────
  const p2Owned = getOwnedTiles("player2", capturedTiles, player1Pos, player2Pos);

  const leftEdge: string[] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    leftEdge.push(`0,${y}`);
  }

  if (hasConnectedPath(p2Owned, leftEdge, (x, _y) => x === GRID_SIZE - 1)) {
    return "player2";
  }

  return null;
}
