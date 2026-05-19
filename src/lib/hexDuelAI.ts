import type { DuelPlayer } from "./hexDuelEngine";
import { GRID_SIZE, getHexNeighbors } from "./hexGridUtils";
import { checkWinCondition } from "./hexWinDetection";

// ── Types ───────────────────────────────────────────────────────────────────

export type AIDifficulty = "easy" | "medium";

export type AIAction =
  | { type: "move"; x: number; y: number }
  | { type: "push"; x: number; y: number }
  | { type: "endTurn" };

export interface AIStateSnapshot {
  myPos: { x: number; y: number };
  enemyPos: { x: number; y: number };
  myPlayer: DuelPlayer;
  enemyPlayer: DuelPlayer;
  capturedTiles: Record<string, DuelPlayer>;
  powerNodes: Set<string>;
  currentAP: number;
}

// ── Score constants ─────────────────────────────────────────────────────────

const SCORE_WINNING = 1000;
const SCORE_CAPTURE_NEUTRAL = 100;
const SCORE_CAPTURE_POWER_NODE = 80;
const SCORE_BLOCK_OPPONENT = 50;
const SCORE_PUSH_OFF_NODE = 90;
const SCORE_PUSH_BLOCK = 70;
const SCORE_PROGRESS_TOWARDS_GOAL = 20;
const SCORE_STAY = 1;
const BLOCK_CENTRALITY_DIVISOR = 8;
const NOISE_CAP_WINNING = 0.05; // max 5% noise on winning moves to prevent overtaking

// ── Push destination math ───────────────────────────────────────────────────

function getPushDestination(
  myPos: { x: number; y: number },
  enemyPos: { x: number; y: number }
): { x: number; y: number } | null {
  const dx = enemyPos.x - myPos.x;
  const dy = enemyPos.y - myPos.y;
  const destX = enemyPos.x + dx;
  const destY = enemyPos.y + dy;
  if (destX < 0 || destX >= GRID_SIZE || destY < 0 || destY >= GRID_SIZE) return null;
  if (destX === myPos.x && destY === myPos.y) return null;
  return { x: destX, y: destY };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build the set of tiles a player owns (captured + position) */
function getOwnedSet(
  player: DuelPlayer,
  pos: { x: number; y: number },
  capturedTiles: Record<string, DuelPlayer>
): Set<string> {
  const owned = new Set<string>();
  for (const [key, owner] of Object.entries(capturedTiles)) {
    if (owner === player) owned.add(key);
  }
  owned.add(`${pos.x},${pos.y}`);
  return owned;
}

/** Check if a tile is neutral (not captured and not occupied by either player) */
function isNeutral(
  x: number,
  y: number,
  myPos: { x: number; y: number },
  enemyPos: { x: number; y: number },
  capturedTiles: Record<string, DuelPlayer>
): boolean {
  const key = `${x},${y}`;
  if (x === myPos.x && y === myPos.y) return false;
  if (x === enemyPos.x && y === enemyPos.y) return false;
  return !capturedTiles[key];
}

/** Manhattan-ish distance heuristic for progress towards goal */
function progressScore(
  player: DuelPlayer,
  x: number,
  y: number
): number {
  // P1 wants to go top→bottom (increase y), P2 wants to go left→right (increase x)
  if (player === "player1") {
    // Normalize: y=0 is start, y=GRID_SIZE-1 is goal
    return y;
  } else {
    // x=0 is start, x=GRID_SIZE-1 is goal
    return x;
  }
}

/** Count how many power nodes a position controls */
function countNodesAtPos(
  pos: { x: number; y: number },
  player: DuelPlayer,
  powerNodes: Set<string>,
  capturedTiles: Record<string, DuelPlayer>
): number {
  let count = 0;
  for (const key of powerNodes) {
    const [px, py] = key.split(",").map(Number);
    if (
      (pos.x === px && pos.y === py) ||
      capturedTiles[key] === player
    ) {
      count++;
    }
  }
  return count;
}

// ── Score evaluators ────────────────────────────────────────────────────────

/** Score a potential move to (x,y) */
function scoreMove(
  x: number,
  y: number,
  snap: AIStateSnapshot
): number {
  let score = 0;

  // Check if this move wins the game
  const tileKey = `${x},${y}`;
  const tileIsNeutral = isNeutral(x, y, snap.myPos, snap.enemyPos, snap.capturedTiles);
  const newCaptures = { ...snap.capturedTiles };
  if (tileIsNeutral) {
    newCaptures[tileKey] = snap.myPlayer;
  }
  const winCheck = checkWinCondition({
    capturedTiles: newCaptures,
    player1Pos: snap.myPlayer === "player1" ? { x, y } : snap.enemyPos,
    player2Pos: snap.myPlayer === "player2" ? { x, y } : snap.enemyPos,
  });
  if (winCheck === snap.myPlayer) {
    return SCORE_WINNING;
  }

  // Capture neutral hex → score based on progress
  if (tileIsNeutral) {
    score += SCORE_CAPTURE_NEUTRAL;
    score += progressScore(snap.myPlayer, x, y) * SCORE_PROGRESS_TOWARDS_GOAL;
  }

  // Capture/stand on power node
  if (snap.powerNodes.has(tileKey)) {
    score += SCORE_CAPTURE_POWER_NODE;
  }

  // Progress towards goal (even on own territory)
  score += progressScore(snap.myPlayer, x, y);

  // Block opponent: move to a hex that's on opponent's likely path
  // For P2 AI (left→right), block P1's vertical path by controlling middle columns
  if (snap.myPlayer === "player2") {
    // P1 needs y=0→4, so controlling tiles with high y near center blocks P1
    const centrality = 2 - Math.abs(x - 2); // 0-2, higher near center
    score += y * centrality * SCORE_BLOCK_OPPONENT / BLOCK_CENTRALITY_DIVISOR;
  } else {
    // For P1 AI, block P2's horizontal path
    const centrality = 2 - Math.abs(y - 2);
    score += x * centrality * SCORE_BLOCK_OPPONENT / BLOCK_CENTRALITY_DIVISOR;
  }

  return score;
}

/** Score a potential push action */
function scorePush(
  enemyX: number,
  enemyY: number,
  snap: AIStateSnapshot
): number {
  const dest = getPushDestination(snap.myPos, snap.enemyPos);
  if (!dest) return -Infinity;

  let score = 0;

  // Push enemy off a power node
  const enemyOldNodes = countNodesAtPos(
    snap.enemyPos,
    snap.enemyPlayer,
    snap.powerNodes,
    snap.capturedTiles
  );
  const enemyNewNodes = countNodesAtPos(
    dest,
    snap.enemyPlayer,
    snap.powerNodes,
    snap.capturedTiles
  );
  if (enemyOldNodes > enemyNewNodes) {
    score += SCORE_PUSH_OFF_NODE;
  }

  // Push enemy away from goal direction
  const oldProgress = progressScore(snap.enemyPlayer, snap.enemyPos.x, snap.enemyPos.y);
  const newProgress = progressScore(snap.enemyPlayer, dest.x, dest.y);
  if (newProgress < oldProgress) {
    score += SCORE_PUSH_BLOCK;
  }

  // Push enemy into a corner/edge
  if (dest.x === 0 || dest.x === GRID_SIZE - 1 || dest.y === 0 || dest.y === GRID_SIZE - 1) {
    score += 20;
  }

  return score;
}

// ── Main AI decision function ───────────────────────────────────────────────

export function decideAIAction(
  snap: AIStateSnapshot,
  difficulty: AIDifficulty
): AIAction {
  const neighbors = getHexNeighbors(snap.myPos.x, snap.myPos.y);

  // Filter valid moves (not occupied by enemy)
  const validMoves = neighbors.filter(
    (n) => !(n.x === snap.enemyPos.x && n.y === snap.enemyPos.y)
  );

  // Check if enemy is adjacent (for push)
  const enemyAdjacent = neighbors.some(
    (n) => n.x === snap.enemyPos.x && n.y === snap.enemyPos.y
  );

  // ── Score all possible moves ─────────────────────────────────────────
  const scoredMoves = validMoves.map((m) => ({
    ...m,
    score: scoreMove(m.x, m.y, snap),
  }));

  // ── Score push if possible ───────────────────────────────────────────
  let pushScore = -Infinity;
  if (enemyAdjacent && snap.currentAP >= 2) {
    pushScore = scorePush(snap.enemyPos.x, snap.enemyPos.y, snap);
  }

  // Sort by score descending
  scoredMoves.sort((a, b) => b.score - a.score);

  // ── Difficulty modifiers ──────────────────────────────────────────────

  if (difficulty === "easy") {
    // Add random noise to scores (0 to 40% of the score)
    for (const m of scoredMoves) {
      m.score += Math.floor(Math.random() * m.score * 0.4);
    }
    // Also add noise to push
    if (pushScore > -Infinity) {
      pushScore += Math.floor(Math.random() * pushScore * 0.4);
    }
    // Sometimes miss the winning move (20% chance)
    if (scoredMoves[0]?.score >= SCORE_WINNING && Math.random() < 0.2) {
      scoredMoves[0].score = scoredMoves[0].score / 2;
    }
    // Re-sort after noise
    scoredMoves.sort((a, b) => b.score - a.score);

    // Easy AI never pushes (too complex)
    pushScore = -Infinity;
  }

  if (difficulty === "medium") {
    // Slight randomness (0-15% noise) to avoid predictability
    // Winning moves get capped noise (max 5%) so they don't get overtaken
    const isWinning = scoredMoves[0]?.score >= SCORE_WINNING;
    for (const m of scoredMoves) {
      const noisePct = isWinning && m.score >= SCORE_WINNING ? NOISE_CAP_WINNING : 0.15;
      m.score += Math.floor(Math.random() * m.score * noisePct);
    }
    if (pushScore > -Infinity) {
      const noisePct = isWinning && pushScore >= SCORE_WINNING ? NOISE_CAP_WINNING : 0.15;
      pushScore += Math.floor(Math.random() * pushScore * noisePct);
    }
    scoredMoves.sort((a, b) => b.score - a.score);
  }

  // ── Decide ────────────────────────────────────────────────────────────

  const bestMove = scoredMoves[0];

  // Push if better than best move
  if (pushScore > (bestMove?.score ?? -Infinity) && enemyAdjacent) {
    return { type: "push", x: snap.enemyPos.x, y: snap.enemyPos.y };
  }

  // If no valid moves or best score is very low, end turn
  if (!bestMove || bestMove.score <= SCORE_STAY) {
    return { type: "endTurn" };
  }

  return { type: "move", x: bestMove.x, y: bestMove.y };
}
