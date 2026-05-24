import type { DuelPlayer } from "./hexDuelEngine";
import { GRID_SIZE, getHexNeighbors } from "./hexGridUtils";

// ── Types ───────────────────────────────────────────────────────────────────

export type AIDifficulty = "easy" | "medium";

export type AIAction =
  | { type: "attack"; sourceKey: string; targetKey: string; troopCount: number }
  | { type: "displace"; sourceKey: string; targetKey: string; troopCount: number }
  | { type: "endTurn" };

export interface AIStateSnapshot {
  myPlayer: DuelPlayer;
  enemyPlayer: DuelPlayer;
  capturedTiles: Record<string, DuelPlayer>;
  tileTroops: Record<string, number>;
  capitals: Record<string, DuelPlayer>;
  currentAP: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isEnemyTile(key: string, snap: AIStateSnapshot): boolean {
  return snap.capturedTiles[key] === snap.enemyPlayer;
}

function isMyTile(key: string, snap: AIStateSnapshot): boolean {
  return snap.capturedTiles[key] === snap.myPlayer;
}

function getTroops(key: string, snap: AIStateSnapshot): number {
  return snap.tileTroops[key] ?? 1;
}

function areAdjacent(keyA: string, keyB: string): boolean {
  const [ax, ay] = keyA.split(",").map(Number);
  const [bx, by] = keyB.split(",").map(Number);
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
}

// ── Attack scoring ──────────────────────────────────────────────────────────

interface ScoredAttack {
  sourceKey: string;
  targetKey: string;
  troopCount: number;
  score: number;
}

function scoreAttack(sourceKey: string, targetKey: string, snap: AIStateSnapshot): ScoredAttack | null {
  const sourceTroops = getTroops(sourceKey, snap);
  const targetTroops = getTroops(targetKey, snap);
  const maxSend = sourceTroops - 1; // must leave at least 1

  if (maxSend <= 0) return null;

  // Determine optimal troop count to send
  // We want to send just enough to conquer + a bit extra
  const optimalCount = targetTroops + 1; // need 1 more to conquer

  if (maxSend < optimalCount) {
    // Can't conquer — send all troops for damage
    // Score: damaging the enemy is valuable, especially on capitals
    let score = maxSend * 2; // damage dealt to enemy
    if (snap.capitals[targetKey] === snap.enemyPlayer) {
      score *= 3; // prioritizing attacking the capital
    }
    // Risk: our source will lose all sent troops
    score -= maxSend * 1.5; // cost of losing our troops
    return { sourceKey, targetKey, troopCount: maxSend, score: Math.max(0, score) };
  }

  // We can conquer! Send only what's needed
  const usedCount = optimalCount;

  let score = 100; // base conquer score
  // Bonus for conquering enemy capital
  if (snap.capitals[targetKey] === snap.enemyPlayer) {
    score += 5000; // WINNING move!
  }
  // Bonus for high-value targets (many troops)
  score += targetTroops * 3;
  // Bonus for source tile remaining strength
  const remainingAfter = sourceTroops - usedCount;
  score += remainingAfter * 2;

  return { sourceKey, targetKey, troopCount: usedCount, score };
}

// ── Displace scoring ─────────────────────────────────────────────────────────

interface ScoredDisplace {
  sourceKey: string;
  targetKey: string;
  troopCount: number;
  score: number;
}

function scoreDisplace(sourceKey: string, targetKey: string, snap: AIStateSnapshot): ScoredDisplace | null {
  if (sourceKey === targetKey) return null;
  if (!isMyTile(sourceKey, snap) || !isMyTile(targetKey, snap)) return null;
  if (!areAdjacent(sourceKey, targetKey)) return null;

  const sourceTroops = getTroops(sourceKey, snap);
  const targetTroops = getTroops(targetKey, snap);
  const maxSend = sourceTroops - 1;

  if (maxSend <= 0) return null;

  // Determine how many to send: bulk up frontline tiles, thin out backline
  const targetIsCapital = snap.capitals[targetKey] === snap.myPlayer;
  const sourceIsCapital = snap.capitals[sourceKey] === snap.myPlayer;

  // Check if target is adjacent to enemy (frontline)
  const [tx, ty] = targetKey.split(",").map(Number);
  const targetAdjacentToEnemy = getHexNeighbors(tx, ty)
    .some((n) => isEnemyTile(`${n.x},${n.y}`, snap));

  let score = 0;
  let troopCount = 0;

  if (targetAdjacentToEnemy) {
    // Move troops to frontline
    troopCount = maxSend; // send as many as possible
    score = troopCount * 10; // +10 per troop sent to frontline
    if (sourceIsCapital) score -= troopCount * 3; // don't strip capital
    if (targetTroops < 3) score += 30; // urgently reinforce weak frontline
  } else if (sourceIsCapital && !targetIsCapital && sourceTroops > 3) {
    // Move excess troops from capital to nearby tiles
    const excess = sourceTroops - 3;
    troopCount = Math.min(excess, maxSend);
    score = troopCount * 5;
  } else if (targetTroops < sourceTroops && targetAdjacentToEnemy) {
    // Consolidate: move from stronger to weaker on frontline
    troopCount = Math.min(maxSend, Math.floor((sourceTroops - targetTroops) / 2));
    if (troopCount > 0) score = troopCount * 8;
  }

  if (troopCount <= 0) return null;

  return { sourceKey, targetKey, troopCount: Math.min(troopCount, maxSend), score };
}

// ── Main AI decision function ───────────────────────────────────────────────

export function decideAIAction(
  snap: AIStateSnapshot,
  difficulty: AIDifficulty
): AIAction {
  // ── Gather all my tiles ─────────────────────────────────────────────
  const myTiles: string[] = [];
  for (const [key, owner] of Object.entries(snap.capturedTiles)) {
    if (owner === snap.myPlayer) myTiles.push(key);
  }

  // ── Score all possible attacks ──────────────────────────────────────
  const scoredAttacks: ScoredAttack[] = [];

  for (const sourceKey of myTiles) {
    const [sx, sy] = sourceKey.split(",").map(Number);
    const neighbors = getHexNeighbors(sx, sy);

    for (const n of neighbors) {
      const nKey = `${n.x},${n.y}`;
      if (!isEnemyTile(nKey, snap)) continue;

      const attack = scoreAttack(sourceKey, nKey, snap);
      if (attack) scoredAttacks.push(attack);
    }
  }

  // ── Score all possible displace moves ───────────────────────────────
  const scoredDisplaces: ScoredDisplace[] = [];

  for (const sourceKey of myTiles) {
    const [sx, sy] = sourceKey.split(",").map(Number);
    const neighbors = getHexNeighbors(sx, sy);

    for (const n of neighbors) {
      const nKey = `${n.x},${n.y}`;
      if (!isMyTile(nKey, snap)) continue;

      const displace = scoreDisplace(sourceKey, nKey, snap);
      if (displace) scoredDisplaces.push(displace);
    }
  }

  // ── Sort by score descending ────────────────────────────────────────
  scoredAttacks.sort((a, b) => b.score - a.score);
  scoredDisplaces.sort((a, b) => b.score - a.score);

  // ── Difficulty modifiers ────────────────────────────────────────────
  if (difficulty === "easy") {
    // Add noise to attack scores
    for (const a of scoredAttacks) {
      a.score += a.score * (Math.random() * 0.5 - 0.25); // -25% to +25%
    }
    for (const d of scoredDisplaces) {
      d.score += d.score * (Math.random() * 0.5 - 0.25);
    }
    scoredAttacks.sort((a, b) => b.score - a.score);
    scoredDisplaces.sort((a, b) => b.score - a.score);
  }

  if (difficulty === "medium") {
    // Slight randomness
    for (const a of scoredAttacks) {
      a.score += a.score * (Math.random() * 0.15 - 0.075);
    }
    for (const d of scoredDisplaces) {
      d.score += d.score * (Math.random() * 0.15 - 0.075);
    }
    scoredAttacks.sort((a, b) => b.score - a.score);
    scoredDisplaces.sort((a, b) => b.score - a.score);
  }

  // ── Decide: attack or displace ──────────────────────────────────────
  const bestAttack = scoredAttacks[0];
  const bestDisplace = scoredDisplaces[0];

  const attackScore = bestAttack?.score ?? -Infinity;
  const displaceScore = bestDisplace?.score ?? -Infinity;

  // Attack is heavily preferred (aggressive AI)
  if (attackScore > 0 && attackScore >= displaceScore) {
    return {
      type: "attack",
      sourceKey: bestAttack!.sourceKey,
      targetKey: bestAttack!.targetKey,
      troopCount: bestAttack!.troopCount,
    };
  }

  // Displace if it's valuable enough
  if (displaceScore > 20) {
    return {
      type: "displace",
      sourceKey: bestDisplace!.sourceKey,
      targetKey: bestDisplace!.targetKey,
      troopCount: bestDisplace!.troopCount,
    };
  }

  // End turn as fallback
  return { type: "endTurn" };
}
