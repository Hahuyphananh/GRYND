// src/components/solitaire-duel/measureFinishCards.ts
//
// Measure where each auto-finish card sits RIGHT NOW, and where its foundation
// is, so the cosmetic flight can start from the board the player is looking at.
//
// Measured once, before the completed board paints: after that the source cards
// no longer exist. A missing rect simply drops that card from the flight — the
// result is already recorded either way. Shared by solo and the duel so the two
// finishes cannot drift.

import type { AutoFinishStep } from "../../lib/solitaire-duel/autoFinish";
import type { Card } from "../../lib/solitaire-duel/types";

export type FlyingCard = {
  card: Card;
  from: { x: number; y: number; width: number; height: number };
  to: { x: number; y: number; width: number; height: number };
};

export function measureFinishCards(steps: AutoFinishStep[]): FlyingCard[] {
  if (typeof document === "undefined") return [];
  const flying: FlyingCard[] = [];
  for (const step of steps) {
    const source = document.querySelector(
      `[data-card="${step.card.suit}-${step.card.rank}"]`,
    );
    const target = document.querySelector(
      `[data-testid="solitaire-foundation-${step.suit}"]`,
    );
    if (!source || !target) continue;
    const from = source.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    if (!from.width || !to.width) continue;
    flying.push({
      card: step.card,
      from: { x: from.left, y: from.top, width: from.width, height: from.height },
      to: { x: to.left, y: to.top, width: to.width, height: to.height },
    });
  }
  return flying;
}
