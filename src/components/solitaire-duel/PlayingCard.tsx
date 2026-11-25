"use client";

// src/components/solitaire-duel/PlayingCard.tsx
//
// ONE card face, shared by the tableau, the waste, the foundations, the stock
// and the post-game flight. Presentational only: it renders the identity it is
// handed and nothing else. A face-down card is handed `card = null` by the
// server's projection, so this component cannot display an identity the viewer
// has not exposed — there is nothing here to leak.
//
// ── THE CARD IS A REAL 3D OBJECT ─────────────────────────────────────────
//
// A playing card has two faces, and this renders BOTH at once, stacked on the
// same box. The back face carries the `sol-card-back` class, which CSS paints
// from the board's custom properties (this component reads no theme variable);
// the front face carries the rank and suit. A 3D wrapper
// between them rotates:
//
//   * face-down  → rotateY(0deg)    (the back faces the viewer)
//   * face-up    → rotateY(180deg)  (the front, pre-rotated 180°, faces back)
//
// `backface-visibility: hidden` on each face is what makes the back become
// progressively narrower as it turns and swap at ~90° — a real card turning
// over, not a cross-fade or a new card painted on top of the old one. The
// parent supplies `perspective` so the rotation has depth.
//
// TWO OPTIONAL, ONE-SHOT ANIMATIONS
//
//   * `reveal`  — the card just became face-up: one 300ms flip from back to
//                 face. It is only ever passed on the commit that detected the
//                 change (see lib/solitaire-duel/cardAnimations.ts), so a
//                 re-render or an identical server snapshot cannot replay it.
//   * `drawFrom` — the card just left the stock for the waste: the whole card
//                 travels from that offset (measured from the stock slot) while
//                 the same 3D wrapper flips. Only the newly drawn card gets it.
//
// Both are pure CSS animations on transform, so the animation layer stays out
// of the game state: the card is always painted at its authoritative position,
// and the transform is only a visual offset from it.
//
// Reduced motion is handled a level up: the board simply never passes these
// props, so the card renders its final face immediately.
//
// A card is a real <button> so the board is keyboard playable (Tab to a column's
// cards, Enter to pick up, Enter on a lit target to place). Cards that cannot be
// interacted with render disabled and are skipped by the tab order.

import type { CSSProperties } from "react";
import type { Card } from "../../lib/solitaire-duel/types";
import { isRedSuit } from "../../lib/solitaire-duel/rules";

const RANK_LABELS: Record<number, string> = {
  1: "A",
  11: "J",
  12: "Q",
  13: "K",
};

const SUIT_GLYPHS: Record<string, string> = {
  spades: "\u2660",
  hearts: "\u2665",
  diamonds: "\u2666",
  clubs: "\u2663",
};

/** Matches the `gr-card-reveal` / `gr-card-draw-flip` keyframes. */
const REVEAL_MS = 300;
const DRAW_MS = 340;

export function rankLabel(rank: number): string {
  return RANK_LABELS[rank] ?? String(rank);
}

export function suitGlyph(suit: string): string {
  return SUIT_GLYPHS[suit] ?? "";
}

/** "K♣" — used for accessible names and readouts. */
export function cardLabel(card: Card | null | undefined): string {
  if (!card) return "face-down card";
  return `${rankLabel(card.rank)}${suitGlyph(card.suit)}`;
}

/** Face cards get the deck skin's foil treatment (see solitaire-cosmetics.css). */
function isFaceCard(card: Card): boolean {
  return card.rank >= 11 || card.rank === 1;
}

/** CSS properties plus the custom properties the draw keyframe reads. */
type CardStyle = CSSProperties & Record<`--${string}`, string | number>;

export type PlayingCardProps = {
  card: Card | null;
  faceUp: boolean;
  /** Held by the player (click-to-select). */
  selected?: boolean;
  /** A legal place for the held card (click-to-place). */
  highlighted?: boolean;
  /** A drop is in flight — dimmed but still rendered in place. */
  dimmed?: boolean;
  interactive?: boolean;
  /**
   * Let the page scroll from this card instead of claiming every gesture.
   * Only set when the board is taller than the viewport: a board that fits
   * has nothing to scroll, and `touch-none` is what makes the drag reliable.
   */
  touchScroll?: boolean;
  style?: CSSProperties;
  className?: string;
  /** Accessible name; falls back to the card's own identity. */
  label?: string;
  testId?: string;
  /** Extra `data-*` attributes (the board uses these to identify drag sources). */
  dataAttrs?: Record<string, string>;
  onClick?: () => void;
  /**
   * This card has just become face-up. Play exactly one physical flip; the
   * caller is responsible for passing it only on the commit that detected the
   * reveal, never on every render.
   */
  reveal?: boolean;
  /**
   * Viewport offset of the stock slot relative to this card, when this card was
   * just drawn. The card travels in from there while flipping face-up.
   */
  drawFrom?: { x: number; y: number } | null;
};

export default function PlayingCard({
  card,
  faceUp,
  selected = false,
  highlighted = false,
  dimmed = false,
  interactive = false,
  touchScroll = false,
  style,
  className = "",
  label,
  testId,
  dataAttrs,
  onClick,
  reveal = false,
  drawFrom = null,
}: PlayingCardProps) {
  // A hidden slot is handed `card = null`; the front face exists only when the
  // authoritative view exposes an identity. Both faces coexist in the DOM, but
  // a face-down card's front carries no rank, suit or colour.
  let frontCard: Card | null = null;
  if (!faceUp || !card) {
    frontCard = null;
  } else {
    frontCard = card;
  }

  const red = frontCard ? isRedSuit(frontCard.suit) : false;

  // The selected card is lifted a hair AND takes the shared dashed selection
  // outline; a legal target gets a SOLID cyan ring. The two differ in shape
  // (dashed vs solid) as well as hue, so a colour-blind player can tell the
  // card they are holding from the piles that will accept it. Both are
  // outline/transform only — no layout shift, so a fast player never has a
  // card move out from under the cursor mid-click.
  const stateClasses = selected
    ? // A dark 2px halo first, then the dashed yellow outline: the selected
      // card usually overlaps the white card BELOW it, and yellow dashes on
      // white would disappear there.
      "gr-selected z-10 -translate-y-[3px] shadow-[0_0_0_2px_#030817,0_6px_16px_rgba(3,8,20,0.5)]"
    : highlighted
      ? // Cyan, not the near-white legal-move token: this ring paints over the
        // white face of the card above it in a fan.
        "ring-2 ring-[color:var(--gr-brand-cyan)] shadow-[0_0_0_1px_var(--gr-outline),0_0_12px_rgba(0,229,255,0.35)]"
      : "";
  const dim = dimmed ? "opacity-70" : "";

  // The card's authoritative box, plus the perspective the flip is viewed
  // through. `perspective` sits on the non-rotating wrapper; if it lived on the
  // rotating element the card would only look skewed, not turn.
  const outerStyle: CardStyle = { ...style, perspective: "700px" };
  if (drawFrom) {
    outerStyle["--gr-draw-x"] = `${drawFrom.x}px`;
    outerStyle["--gr-draw-y"] = `${drawFrom.y}px`;
    outerStyle.animation = `gr-card-draw-translate ${DRAW_MS}ms cubic-bezier(0.22, 0.75, 0.25, 1)`;
  }

  // One animation on the 3D wrapper. A reveal and a draw are mutually
  // exclusive in practice (a drawn card arrives in the waste, a reveal happens
  // in the tableau), but the reveal takes precedence if both are ever set.
  const innerAnimation = reveal
    ? `gr-card-reveal ${REVEAL_MS}ms cubic-bezier(0.25, 0.75, 0.3, 1)`
    : drawFrom
      ? `gr-card-draw-flip ${DRAW_MS}ms cubic-bezier(0.22, 0.75, 0.25, 1)`
      : undefined;

  return (
    <button
      type="button"
      disabled={!interactive}
      tabIndex={interactive ? 0 : -1}
      onClick={onClick}
      aria-label={label || (frontCard ? cardLabel(frontCard) : "Face-down card")}
      data-testid={testId}
      data-face-up={frontCard ? "true" : "false"}
      // The identity is only ever written to the DOM once the view exposes it.
      data-card={frontCard ? `${frontCard.suit}-${frontCard.rank}` : undefined}
      {...dataAttrs}
      style={outerStyle}
      className={`gr-focusable relative block h-full w-full select-none rounded-[6px] transition focus-visible:z-10 ${stateClasses} ${dim} ${
        interactive
          ? `cursor-pointer ${touchScroll ? "touch-pan-y" : "touch-none"}`
          : "cursor-default"
      } ${className}`}
    >
      <span
        className="absolute inset-0 block"
        style={{
          transformStyle: "preserve-3d",
          transform: frontCard ? "rotateY(180deg)" : "rotateY(0deg)",
          animation: innerAnimation,
        }}
      >
        {/* ── The back. Painted from the board's cosmetic custom properties,
               so a card-back change repaints every card in place. ─────────── */}
        <span
          aria-hidden="true"
          className="sol-card-back absolute inset-0 flex items-center justify-center overflow-hidden rounded-[6px] border-2 shadow-[0_1px_2px_rgba(3,8,20,0.55)]"
          style={{
            backfaceVisibility: "hidden",
            WebkitBackfaceVisibility: "hidden",
          }}
        >
          <span
            aria-hidden="true"
            className="sol-card-back-pattern h-[62%] w-[62%] rounded-[4px] border bg-[repeating-linear-gradient(45deg,rgba(255,255,255,0.08)_0_2px,transparent_2px_6px)]"
          />
        </span>

        {/* ── The face. Pre-rotated 180° so it reads correctly at the wrapper's
               face-up angle, and invisible from behind. ────────────────────── */}
        <span
          className={`absolute inset-0 flex flex-col overflow-hidden rounded-[6px] border-2 border-[color:var(--gr-outline)] bg-linear-to-b from-white to-[#e8ecf3] text-left shadow-[0_2px_0_-1px_rgba(3,8,20,0.8),0_1px_3px_rgba(0,0,0,0.4)] ${
            frontCard && isFaceCard(frontCard) ? "sol-face-card" : ""
          } ${red ? "text-[#d81f3a]" : "text-[#141a24]"}`}
          style={{
            transform: "rotateY(180deg)",
            backfaceVisibility: "hidden",
            WebkitBackfaceVisibility: "hidden",
          }}
        >
          {/* Rank + pip live in the TOP-LEFT corner on purpose: in a fanned
              column only the top sliver of each card is visible, so that sliver
              has to be the readable part. */}
          {frontCard && (
            <>
              <span className="flex items-center gap-[1px] pl-[10%] pt-[6%] font-black leading-none">
                <span className="text-[clamp(11px,1.35vw,15px)]">{rankLabel(frontCard.rank)}</span>
                <span className="text-[clamp(10px,1.1vw,13px)]">{suitGlyph(frontCard.suit)}</span>
              </span>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute bottom-[4%] right-[8%] text-[clamp(14px,2.6vw,30px)] leading-none opacity-70"
              >
                {suitGlyph(frontCard.suit)}
              </span>
            </>
          )}
        </span>
      </span>
    </button>
  );
}
