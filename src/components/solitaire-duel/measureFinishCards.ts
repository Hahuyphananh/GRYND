// src/components/solitaire-duel/measureFinishCards.ts
//
// Measure where each auto-finish card sits RIGHT NOW, and where its foundation
// is, so the cosmetic flight can start from the board the player is looking at.
//
// Measured once, before the completed board paints: after that the source cards
// no longer exist. A missing rect simply drops that card from the flight — the
// result is already recorded either way. Shared by solo and the duel so the two
// finishes cannot drift.
//
// The snapshot also records the BOARD's origin. The finished board is painted
// underneath the flight in the same commit, and it is a shorter board (the
// tableau collapses), which can move the page — so the frozen viewport
// coordinates stop matching the piles on screen. The animation re-expresses the
// flight against the board's live origin and the foundations' live rects (see
// `measureBoardOrigin` / `measureFoundationTargets`), which is what keeps every
// card aimed at the finished pile.

import { SUITS } from "../../lib/solitaire-duel/constants";
import type { AutoFinishStep } from "../../lib/solitaire-duel/autoFinish";
import type { Card, Suit } from "../../lib/solitaire-duel/types";

/** A card-sized box in viewport coordinates. */
export type FinishRect = { x: number; y: number; width: number; height: number };

export type FlyingCard = {
  card: Card;
  from: FinishRect;
  to: FinishRect;
  /** The board's top-left and height when the flight was measured. */
  board: { x: number; y: number; height: number };
};

function rectOf(element: Element): FinishRect {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/**
 * The board's own top-left, in viewport coordinates, right now.
 *
 * The whole flight is drawn in the board's frame: the sources sat in it and the
 * foundations sit in it. Reading it live means a collapse, a clamped page
 * scroll or a phone's shifting viewport moves the flight WITH the table instead
 * of leaving it behind.
 */
export function measureBoardOrigin(): { x: number; y: number } | null {
  if (typeof document === "undefined") return null;
  const board = document.querySelector('[data-testid="solitaire-board"]');
  if (!board) return null;
  const rect = board.getBoundingClientRect();
  return { x: rect.left, y: rect.top };
}

/**
 * The board's FULL height right now, in CSS pixels.
 *
 * The finished board is shorter than the one it replaces (the tableau
 * collapses), and that shrink is what pulls the page — and the piles — out from
 * under the flight. Holding this height on the board until the animation ends
 * keeps the table perfectly still while the cards fly.
 */
export function measureBoardHeight(): number {
  if (typeof document === "undefined") return 0;
  const board = document.querySelector('[data-testid="solitaire-board"]');
  if (!board) return 0;
  return board.getBoundingClientRect().height;
}

/**
 * The four foundation slots as they are RIGHT NOW.
 *
 * Re-read while the cards fly, because the foundations are part of the board
 * that just re-rendered: the animation must land on the pile the player can
 * see, not on where that pile was when the flight was measured.
 */
export function measureFoundationTargets(): Partial<Record<Suit, FinishRect>> {
  if (typeof document === "undefined") return {};
  const targets: Partial<Record<Suit, FinishRect>> = {};
  for (const suit of SUITS) {
    const element = document.querySelector(
      `[data-testid="solitaire-foundation-${suit}"]`,
    );
    if (!element) continue;
    const rect = rectOf(element);
    if (!rect.width || !rect.height) continue;
    targets[suit] = rect;
  }
  return targets;
}

/** The share of the timeline used to stagger the starts within one pile. */
export const FLIGHT_STAGGER = 0.55;

/**
 * When each card flies, as a window of the shared 0 → 1 timeline.
 *
 * Cards are queued PER FOUNDATION, not in one global list: every suit's cards
 * leave one after another, in the order the plan plays them (ascending rank),
 * while the four piles are filled in parallel. So each suit arrives as one tidy
 * stack on its own foundation instead of the whole table interleaving, and the
 * last card of the longest pile still finishes inside the same window.
 */
export function flightWindows(cards: FlyingCard[]): { start: number; end: number }[] {
  const lanes = new Map<Suit, FlyingCard[]>();
  for (const entry of cards) {
    const lane = lanes.get(entry.card.suit);
    if (lane) lane.push(entry);
    else lanes.set(entry.card.suit, [entry]);
  }
  return cards.map((entry) => {
    const lane = lanes.get(entry.card.suit) ?? [entry];
    const index = lane.indexOf(entry);
    const start = (index / Math.max(1, lane.length)) * FLIGHT_STAGGER;
    return { start, end: Math.min(1, start + (1 - FLIGHT_STAGGER) + 0.05) };
  });
}

/**
 * Where a flying card is at `t` (0 → 1), in viewport coordinates.
 *
 * The flight is drawn in the BOARD's frame: the source sat in it and the
 * destination sits in it. When the finished board moves (the tableau collapses,
 * the page scroll is clamped, a phone's viewport settles) the whole frame moves
 * with it, so the card leaves from where the board put it and arrives on the
 * pile as it is drawn NOW. Landing on the LIVE foundation rect is what stops
 * the finish from stopping above the pile; the box is interpolated too, so a
 * resized pile is landed on exactly rather than only at its top-left corner.
 */
export function flightFrame(
  entry: FlyingCard,
  to: FinishRect,
  liveBoard: { x: number; y: number } | null,
  t: number,
): FinishRect {
  const startX = entry.from.x + (liveBoard ? liveBoard.x - entry.board.x : 0);
  const startY = entry.from.y + (liveBoard ? liveBoard.y - entry.board.y : 0);
  return {
    x: startX + (to.x - startX) * t,
    y: startY + (to.y - startY) * t,
    width: entry.from.width + (to.width - entry.from.width) * t,
    height: entry.from.height + (to.height - entry.from.height) * t,
  };
}

export function measureFinishCards(steps: AutoFinishStep[]): FlyingCard[] {
  if (typeof document === "undefined") return [];
  const origin = measureBoardOrigin() ?? { x: 0, y: 0 };
  const board = { ...origin, height: measureBoardHeight() };
  const flying: FlyingCard[] = [];
  for (const step of steps) {
    const source = document.querySelector(
      `[data-card="${step.card.suit}-${step.card.rank}"]`,
    );
    const target = document.querySelector(
      `[data-testid="solitaire-foundation-${step.suit}"]`,
    );
    if (!source || !target) continue;
    const from = rectOf(source);
    const to = rectOf(target);
    if (!from.width || !from.height || !to.width || !to.height) continue;
    flying.push({ card: step.card, from, to, board });
  }
  return flying;
}
