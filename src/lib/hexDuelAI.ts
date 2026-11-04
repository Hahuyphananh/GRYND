import type { DuelPlayer } from "./hexDuelEngine";
import { GRID_SIZE, getHexNeighbors } from "./hexGridUtils";
import { coerceAiDifficulty } from "./aiDifficulty";
import {
  TERRITORY_LEVELS,
  getUpgradeInfo,
  normalizeTerritoryLevel,
  type TerritoryLevel,
} from "./hex-duel/rules";

// ── Types ───────────────────────────────────────────────────────────────────

// The canonical shared AI scale (see `src/lib/aiDifficulty.ts`). The old
// `medium` spelling coerces to `normal`, so stored games and older clients
// keep working.
export type AIDifficulty = "easy" | "normal" | "hard";

export type AIAction =
  | { type: "attack"; sourceKey: string; targetKey: string; troopCount: number }
  | { type: "displace"; sourceKey: string; targetKey: string; troopCount: number }
  | { type: "upgrade"; sourceKey: string }
  | { type: "endTurn" };

export interface AIStateSnapshot {
  myPlayer: DuelPlayer;
  enemyPlayer: DuelPlayer;
  capturedTiles: Record<string, DuelPlayer>;
  tileTroops: Record<string, number>;
  capitals: Record<string, DuelPlayer>;
  /** Permanent level per tile; a missing key is level 1. */
  territoryLevels?: Record<string, number>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isEnemyTile(key: string, snap: AIStateSnapshot): boolean {
  return snap.capturedTiles[key] === snap.enemyPlayer;
}

/** Check if a tile is neutral/unowned (not owned by anyone) */
function isNeutralTile(key: string, snap: AIStateSnapshot): boolean {
  return snap.capturedTiles[key] === undefined;
}

function isAttackableTile(key: string, snap: AIStateSnapshot): boolean {
  return isEnemyTile(key, snap) || isNeutralTile(key, snap);
}

function isMyTile(key: string, snap: AIStateSnapshot): boolean {
  return snap.capturedTiles[key] === snap.myPlayer;
}

function getTroops(key: string, snap: AIStateSnapshot): number {
  // Neutral/unowned tiles have 0 troops
  if (!snap.capturedTiles[key]) return 0;
  return snap.tileTroops[key] ?? 1;
}

/** Troop ceiling of a tile, from its territory level. */
function capacityOf(key: string, snap: AIStateSnapshot): number {
  const level = normalizeTerritoryLevel(snap.territoryLevels?.[key]);
  return TERRITORY_LEVELS[level].maxTroops;
}

function areAdjacent(keyA: string, keyB: string): boolean {
  const [ax, ay] = keyA.split(",").map(Number);
  const [bx, by] = keyB.split(",").map(Number);
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
}

interface ThreatenedCapital {
  key: string;
  troops: number;
  /** "x,y" of every enemy tile standing next to the capital. */
  adjacentEnemies: string[];
}

/**
 * The bot's capital and the enemies next to it, or null when it is safe.
 *
 * A threatened capital is the whole match: the bot keeps its garrison at home,
 * banks reinforcements on it and only spends those troops to remove the threat
 * or to win outright.
 */
function threatenedCapitalOf(snap: AIStateSnapshot): ThreatenedCapital | null {
  const key = Object.entries(snap.capitals).find(
    ([, owner]) => owner === snap.myPlayer,
  )?.[0];
  if (!key) return null;
  const [x, y] = key.split(",").map(Number);
  const adjacentEnemies = getHexNeighbors(x, y)
    .map((neighbour) => `${neighbour.x},${neighbour.y}`)
    .filter((neighbourKey) => isEnemyTile(neighbourKey, snap));
  if (adjacentEnemies.length === 0) return null;
  return { key, troops: getTroops(key, snap), adjacentEnemies };
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

  // A threatened capital does not throw its garrison away. It may attack ONLY
  // the tile that is threatening it, and only when that attack conquers —
  // that trade removes the threat (or takes the enemy capital and wins).
  const threatened = threatenedCapitalOf(snap);
  if (threatened && sourceKey === threatened.key) {
    const removesThreat =
      threatened.adjacentEnemies.includes(targetKey) &&
      sourceTroops > targetTroops;
    if (!removesThreat) return null;
  }

  // Neutral tiles have 0 troops, so any attack with ≥1 troop conquers them
  const isNeutral = isNeutralTile(targetKey, snap);

  // Determine optimal troop count to send
  // We want to send just enough to conquer + a bit extra
  const optimalCount = targetTroops + 1; // need 1 more to conquer

  if (maxSend < optimalCount && !isNeutral) {
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

  // Capacity: a move the rulebook would refuse (the destination cannot take
  // that many troops) must never be proposed.
  const room = capacityOf(targetKey, snap) - targetTroops;
  if (room <= 0) return null;

  // While the capital is threatened, troops go IN, never out. Reinforcing it
  // outranks almost anything else — the capital is the win condition, and a
  // garrison that grows every turn is what makes the threat pointless.
  const threatened = threatenedCapitalOf(snap);
  if (threatened) {
    if (sourceKey === threatened.key) return null;
    if (targetKey === threatened.key) {
      const banked = Math.min(maxSend, room);
      if (banked <= 0) return null;
      return { sourceKey, targetKey, troopCount: banked, score: 150 + banked * 10 };
    }
  }

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

  return { sourceKey, targetKey, troopCount: Math.min(troopCount, maxSend, room), score };
}

// ── Upgrade scoring ─────────────────────────────────────────────────────────

interface ScoredUpgrade {
  sourceKey: string;
  score: number;
}

/**
 * Upgrading is an action like any other — it ends the turn — so the bot only
 * considers it when it has no worthwhile attack or displacement. The score
 * favours front-line territories and tiles already sitting at their ceiling:
 * the two cases where a higher capacity changes what the next turn can do.
 *
 * The payment plan comes from `getUpgradeInfo`, the same rulebook the validator
 * and the reducer use: the tile pays what it can (keeping one) and the rest is
 * drawn from adjacent friendly territories. That means a tile holding less than
 * the whole price can still be upgraded by borrowing — and the bot can never
 * propose an upgrade the rulebook would refuse. Borrowing is discounted, since
 * every troop comes off a neighbour's garrison.
 */
export function scoreUpgrade(sourceKey: string, snap: AIStateSnapshot): ScoredUpgrade | null {
  if (!isMyTile(sourceKey, snap)) return null;

  const info = getUpgradeInfo(
    {
      capturedTiles: snap.capturedTiles,
      tileTroops: snap.tileTroops,
      territoryLevels: snap.territoryLevels as Record<string, TerritoryLevel> | undefined,
    },
    snap.myPlayer,
    sourceKey,
  );
  if (!info.ok) return null;

  const [x, y] = sourceKey.split(",").map(Number);
  const onFrontline = getHexNeighbors(x, y).some((n) =>
    isAttackableTile(`${n.x},${n.y}`, snap),
  );
  const atCapacity = info.troops >= info.maxTroops;

  let score = 40 + info.level * 10;
  if (onFrontline) score += 120;
  if (atCapacity) score += 160; // growth is blocked until the level rises
  if (snap.capitals[sourceKey] === snap.myPlayer) score += 30;

  // The capital is the win condition: never strip it to fortify somewhere
  // else, and never leave it too thin to answer an enemy standing next to it.
  // A level is worth less than the tile that loses the match.
  const myCapitalKey = Object.entries(snap.capitals).find(
    ([, owner]) => owner === snap.myPlayer,
  )?.[0];
  if (myCapitalKey) {
    const paidFromCapital =
      info.contributions.find((contribution) => contribution.key === myCapitalKey)
        ?.troops ?? 0;
    if (paidFromCapital > 0) {
      const capitalFloor = threatenedCapitalOf(snap) ? 5 : 3;
      if (getTroops(myCapitalKey, snap) - paidFromCapital < capitalFloor) return null;
    }
  }

  if (info.paidFromNeighbours > 0) {
    // Thinning a neighbour is a real cost: it may be holding a front line.
    score -= info.paidFromNeighbours * 8;
    const drainsFrontlineNeighbour = info.contributions.some((contribution) => {
      if (!contribution.fromNeighbour) return false;
      const [nx, ny] = contribution.key.split(",").map(Number);
      return getHexNeighbors(nx, ny).some((n) =>
        isAttackableTile(`${n.x},${n.y}`, snap),
      );
    });
    if (drainsFrontlineNeighbour) score -= 60;
  }

  return { sourceKey, score };
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
      if (!isAttackableTile(nKey, snap)) continue;

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

  // ── Score upgrades (a legal action since the level system landed) ────
  const scoredUpgrades: ScoredUpgrade[] = [];
  for (const sourceKey of myTiles) {
    const upgrade = scoreUpgrade(sourceKey, snap);
    if (upgrade) scoredUpgrades.push(upgrade);
  }

  // ── Sort by score descending ────────────────────────────────────────
  scoredAttacks.sort((a, b) => b.score - a.score);
  scoredDisplaces.sort((a, b) => b.score - a.score);
  scoredUpgrades.sort((a, b) => b.score - a.score);

  // ── Difficulty modifiers ────────────────────────────────────────────
  // `normal` reproduces the noise the old `medium` tier shipped with, so an
  // existing vs-AI game (stored as `medium`) plays exactly as before.
  const tier = coerceAiDifficulty(difficulty);
  const noise = tier === "easy" ? 0.5 : tier === "normal" ? 0.15 : 0;
  if (noise > 0) {
    for (const a of scoredAttacks) {
      a.score += a.score * (Math.random() * noise - noise / 2);
    }
    for (const d of scoredDisplaces) {
      d.score += d.score * (Math.random() * noise - noise / 2);
    }
    scoredAttacks.sort((a, b) => b.score - a.score);
    scoredDisplaces.sort((a, b) => b.score - a.score);
  }

  // ── Decide: attack or displace ──────────────────────────────────────
  const bestAttack = scoredAttacks[0];
  const bestDisplace = scoredDisplaces[0];

  const attackScore = bestAttack?.score ?? -Infinity;
  const displaceScore = bestDisplace?.score ?? -Infinity;

  // A capital capture always outranks everything — it ends the match.
  const winningAttack =
    bestAttack &&
    snap.capitals[bestAttack.targetKey] === snap.enemyPlayer &&
    bestAttack.score >= 5000;
  if (winningAttack) {
    return {
      type: "attack",
      sourceKey: bestAttack!.sourceKey,
      targetKey: bestAttack!.targetKey,
      troopCount: bestAttack!.troopCount,
    };
  }

  // Otherwise every legal action competes on the same score. Upgrading a
  // full or front-line territory (its score dominates) beats grabbing another
  // neutral tile; a plain expansion still wins over a low-value upgrade.
  const upgradeScore = scoredUpgrades[0]?.score ?? -Infinity;
  if (upgradeScore > 0 && upgradeScore >= attackScore && upgradeScore >= displaceScore) {
    return { type: "upgrade", sourceKey: scoredUpgrades[0].sourceKey };
  }

  // Attack when it is the best remaining action (aggressive by default).
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

  // No worthwhile attack or displacement: invest in capacity rather than
  // passing. Still exactly one action for the turn.
  if (scoredUpgrades.length > 0) {
    return { type: "upgrade", sourceKey: scoredUpgrades[0].sourceKey };
  }

  // End turn as fallback
  return { type: "endTurn" };
}
