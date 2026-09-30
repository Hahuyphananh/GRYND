"use client";

// src/components/solitaire-duel/PlayingCard.tsx
//
// ONE card face, shared by the tableau, the waste, the foundations and the
// stock. Presentational only: it renders the identity it is handed and nothing
// else. A face-down card is handed `card = null` by the server's projection, so
// this component cannot display an identity the viewer has not exposed — there
// is nothing here to leak.
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
  style?: CSSProperties;
  className?: string;
  /** Accessible name; falls back to the card's own identity. */
  label?: string;
  testId?: string;
  onClick?: () => void;
};

export default function PlayingCard({
  card,
  faceUp,
  selected = false,
  highlighted = false,
  dimmed = false,
  interactive = false,
  style,
  className = "",
  label,
  testId,
  onClick,
}: PlayingCardProps) {
  const red = faceUp && card ? isRedSuit(card.suit) : false;

  // The selected card is lifted a hair; a legal target gets a warm ring. Both
  // are transform/ring only — no layout shift, so a fast player never has a
  // card move out from under the cursor mid-click.
  const stateClasses = selected
    ? "-translate-y-[3px] ring-2 ring-amber-300 shadow-[0_6px_18px_rgba(251,191,36,0.45)]"
    : highlighted
      ? "ring-2 ring-[#00e5ff]/80 shadow-[0_0_14px_rgba(0,229,255,0.4)]"
      : "ring-1 ring-black/40";
  const dim = dimmed ? "opacity-70" : "";

  if (!faceUp || !card) {
    // The back. Deliberately patterned rather than blank so a face-down stack
    // reads as cards, not as empty slots.
    return (
      <button
        type="button"
        disabled={!interactive}
        tabIndex={interactive ? 0 : -1}
        onClick={onClick}
        aria-label={label || "Face-down card"}
        data-testid={testId}
        data-face-up="false"
        style={style}
        className={`relative flex h-full w-full select-none items-center justify-center overflow-hidden rounded-[6px] border border-[#1b2a4a] bg-gradient-to-br from-[#1d3a63] via-[#16294a] to-[#0f1d36] transition ${stateClasses} ${dim} ${
          interactive ? "cursor-pointer hover:brightness-125" : "cursor-default"
        } ${className}`}
      >
        <span
          aria-hidden="true"
          className="h-[62%] w-[62%] rounded-[4px] border border-[#00e5ff]/25 bg-[repeating-linear-gradient(45deg,rgba(0,229,255,0.16)_0_3px,transparent_3px_6px)]"
        />
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={!interactive}
      tabIndex={interactive ? 0 : -1}
      onClick={onClick}
      aria-label={label || cardLabel(card)}
      data-testid={testId}
      data-face-up="true"
      data-card={`${card.suit}-${card.rank}`}
      style={style}
      className={`relative flex h-full w-full select-none flex-col overflow-hidden rounded-[6px] border border-black/30 bg-gradient-to-b from-white to-[#e8ecf3] text-left shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition ${
        red ? "text-[#d81f3a]" : "text-[#141a24]"
      } ${stateClasses} ${dim} ${
        interactive ? "cursor-pointer hover:brightness-105" : "cursor-default"
      } ${className}`}
    >
      {/* Rank + pip live in the TOP-LEFT corner on purpose: in a fanned column
          only the top sliver of each card is visible, so that sliver has to be
          the readable part. */}
      <span className="flex items-center gap-[1px] pl-[10%] pt-[6%] font-black leading-none">
        <span className="text-[clamp(9px,1.35vw,15px)]">{rankLabel(card.rank)}</span>
        <span className="text-[clamp(8px,1.1vw,13px)]">{suitGlyph(card.suit)}</span>
      </span>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-[4%] right-[8%] text-[clamp(14px,2.6vw,30px)] leading-none opacity-70"
      >
        {suitGlyph(card.suit)}
      </span>
    </button>
  );
}
