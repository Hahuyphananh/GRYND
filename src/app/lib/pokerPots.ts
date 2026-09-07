// src/app/lib/pokerPots.ts
//
// Pure side-pot (main pot + side pots) settlement math for the poker
// client. Kept outside the match page so it can be unit-tested.
//
// Every player tracks how much they committed to the current pot
// (`committed`, cumulative across betting rounds). At the end of a
// hand the pot is split into slices by contribution level:
//
//   level 1 slice:  contested by everyone who committed >= level 1
//   level 2 slice:  contested by everyone who committed >= level 2
//   ...
//
// Each slice is awarded to the best hand among the players eligible
// to contest it (non-folded AND committed enough). Folded players'
// chips stay in their slices but they can't win them. Any leftover
// (a slice whose only contributors folded) goes to the main winner so
// the full pot is always distributed.
//
// If only one player is still in the hand (everyone else folded) that
// player takes the entire pot — the standard "last player standing"
// rule.

import type { Card } from "./handEval";
import { evaluateHand } from "./handEval";

export type PotPlayer = {
  id: string;
  /** Total chips contributed to the current pot this hand. */
  committed?: number;
  hasFolded?: boolean;
  hand?: Card[];
};

export type PotAward = {
  playerId: string;
  amount: number;
};

// Rank a hand on the same 1-10 ladder the match page already uses
// (10 = Royal Flush … 2 = Pair, 1 = High Card). Ties within a level
// fall back to the first player in the array, matching the previous
// showdown behaviour.
export function handScore(
  playerCards: Card[],
  community: Card[],
): number {
  const label = evaluateHand(playerCards, community);
  if (!label) return 0;
  if (label.includes("Royal")) return 10;
  if (label.includes("Straight Flush")) return 9;
  if (label.includes("Four")) return 8;
  if (label.includes("Full")) return 7;
  if (label.includes("Flush")) return 6;
  if (label.includes("Straight")) return 5;
  if (label.includes("Three")) return 4;
  if (label.includes("Two Pair")) return 3;
  if (label.includes("Pair")) return 2;
  return 1;
}

// Split the current pot into awards per player. The FIRST entry is
// the main-pot winner (best hand overall). Every award amount is
// derived from `committed`, so the sum always equals the pot
// (total committed) — callers never pass the pot in.
export function computePayouts(
  players: PotPlayer[],
  community: Card[],
): PotAward[] {
  const committedOf = (p: PotPlayer) => Number(p?.committed) || 0;
  const active = players.filter((p) => !p.hasFolded);

  if (active.length === 0) return [];
  // Everyone folded except one → last player standing takes it all.
  if (active.length === 1) {
    const total = players.reduce((s, p) => s + committedOf(p), 0);
    return [{ playerId: active[0].id, amount: total }];
  }

  const scores = new Map<string, number>();
  for (const p of active) {
    scores.set(p.id, handScore(p.hand ?? [], community));
  }

  const levels = Array.from(
    new Set(players.map(committedOf)),
  ).sort((a, b) => a - b);

  const awards = new Map<string, number>();
  let prev = 0;
  for (const level of levels) {
    const slice = (level - prev) * players.filter((p) => committedOf(p) >= level).length;
    if (slice <= 0) {
      prev = level;
      continue;
    }
    const contenders = active.filter((p) => committedOf(p) >= level);
    if (contenders.length > 0) {
      let best = contenders[0];
      for (const c of contenders) {
        if ((scores.get(c.id) ?? -1) > (scores.get(best.id) ?? -1)) {
          best = c;
        }
      }
      awards.set(best.id, (awards.get(best.id) ?? 0) + slice);
    }
    prev = level;
  }

  const totalCommitted = players.reduce((s, p) => s + committedOf(p), 0);
  const result = Array.from(awards.entries()).map(([playerId, amount]) => ({
    playerId,
    amount,
  }));

  // Leftover chips (a slice whose only contributors folded) go to the
  // main winner so nothing vanishes from the pot.
  const assigned = result.reduce((s, w) => s + w.amount, 0);
  if (assigned < totalCommitted) {
    if (result.length === 0) {
      // No slice had an eligible contender — hand everything to the
      // best remaining hand. Practically unreachable in real play
      // (blinds guarantee contributions), kept as a safe fallback.
      let best = active[0];
      for (const c of active) {
        if ((scores.get(c.id) ?? -1) > (scores.get(best.id) ?? -1)) {
          best = c;
        }
      }
      result.push({ playerId: best.id, amount: totalCommitted });
    } else {
      result[0] = {
        ...result[0],
        amount: result[0].amount + (totalCommitted - assigned),
      };
    }
  }

  return result;
}