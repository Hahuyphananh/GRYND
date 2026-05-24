"use client";

import type { DuelPlayer } from "./hexDuelEngine";

// ── Types ──────────────────────────────────────────────────────────────────

export interface WinCheckParams {
  /** The capital tile of each player: "x,y" → player */
  capitals: Record<string, DuelPlayer>;
  /** Which player owns each captured tile: "x,y" → player */
  capturedTiles: Record<string, DuelPlayer>;
}

/**
 * Check if either player has won by conquering the enemy's capital.
 *
 * Player 1 wins if they own Player 2's capital tile.
 * Player 2 wins if they own Player 1's capital tile.
 *
 * @returns The winning player, or null if no winner yet.
 */
export function checkWinCondition({
  capitals,
  capturedTiles,
}: WinCheckParams): DuelPlayer | null {
  for (const [capitalKey, originalOwner] of Object.entries(capitals)) {
    const currentOwner = capturedTiles[capitalKey];
    // If someone else owns this capital, that someone wins
    if (currentOwner && currentOwner !== originalOwner) {
      return currentOwner;
    }
  }

  return null;
}
