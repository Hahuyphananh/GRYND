"use client";

// src/hooks/useDominoBotReveal.ts
//
// HOLDING THE PRACTICE BOT'S REPLY FOR A BEAT.
//
// The Dominoes bot plays INSIDE the transaction that applied the viewer's move
// (see `src/lib/dominoes/serverStore.ts`), which is the right place for it: the
// reply and the move that allowed it commit together, and the row can never be
// left waiting on a bot turn. The side effect is presentational — the snapshot a
// player receives can contain THEIR move and the bot's answer at once, so the
// bot appears to have moved while the player was still looking at their own tile.
//
// This hook splits that one snapshot into two frames on screen: everything up to
// and including the player's own move is shown at once, and a TRAILING run of
// opponent tiles is withheld for `BOT_REVEAL_DELAY_MS` before it appears.
//
// WHAT IT IS NOT: it does not play, simulate, decide or delay anything on the
// server. The snapshot it holds is already authoritative; the turn, the clock,
// the legality and the result were decided before it arrived. Holding a tile
// back cannot lose a move — when the timer fires the FULL snapshot is shown, and
// a resync or refusal simply moves the chain forward.
//
// PvP IS UNTOUCHED. Only a practice snapshot (`isAi`) with trailing OPPONENT
// tiles is ever held; a human opponent's move is never delayed, and neither is
// the player's own tile.
//
// The open values during the hold are read off the SHOWN chain's own ends — the
// same two values the projection publishes — so the board can never offer a
// target that only exists in the position being held back.

import { useEffect, useMemo, useRef, useState } from "react";

/** How long the bot's reply is held back on screen. */
export const BOT_REVEAL_DELAY_MS = 700;

/** The chain fields this hook reads (a subset of the projection). */
export type RevealChainTile = {
  left?: unknown;
  right?: unknown;
  seat?: unknown;
};

/** The snapshot fields this hook reads. Everything else is passed through. */
export type RevealSnapshot = {
  matchId?: string;
  isAi?: boolean;
  opponentSeat?: "player1" | "player2" | null;
  chain?: RevealChainTile[];
  openEnds?: unknown;
  isViewerTurn?: boolean;
  turn?: "player1" | "player2" | null;
  opponentTileCount?: number;
};

/**
 * The snapshot with its newest `hidden` chain tiles withheld.
 *
 * The turn is reported as the opponent's while the reply is held, which is the
 * position the player is actually looking at; `isViewerTurn` is therefore false,
 * so no control is offered for a state that is already over.
 */
export function withChainHeldBack<T extends RevealSnapshot>(snapshot: T, hidden: number): T {
  const chain = Array.isArray(snapshot.chain) ? snapshot.chain : [];
  const shown = chain.slice(0, Math.max(0, chain.length - hidden));
  const first = shown[0];
  const last = shown[shown.length - 1];

  return {
    ...snapshot,
    chain: shown,
    openEnds: shown.length
      ? {
          left: (first?.left ?? null) as number | null,
          right: (last?.right ?? null) as number | null,
        }
      : { left: null, right: null },
    isViewerTurn: false,
    turn: snapshot.opponentSeat ?? null,
    opponentTileCount: Math.max(0, Number(snapshot.opponentTileCount ?? 0) + hidden),
  } as T;
}

/**
 * The snapshot the board should draw, with the bot's newest reply held back.
 *
 * Returns the snapshot unchanged unless a practice turn arrived with trailing
 * opponent tiles beyond the chain already on screen.
 */
export default function useDominoBotReveal<T extends RevealSnapshot>(
  snapshot: T | null,
): T | null {
  // The chain length the board has been allowed to show, so a repeated read of
  // the same position (the socket poke that follows every action) can never
  // cancel a hold that is already running.
  const revealedRef = useRef(0);
  const matchIdRef = useRef<string | null>(null);
  const [heldFrom, setHeldFrom] = useState<number | null>(null);

  useEffect(() => {
    const matchId = typeof snapshot?.matchId === "string" ? snapshot.matchId : null;
    let revealed = revealedRef.current;
    // A different match starts from nothing: its chain is drawn whole.
    if (matchIdRef.current !== matchId) {
      matchIdRef.current = matchId;
      revealed = 0;
      revealedRef.current = 0;
      setHeldFrom(null);
    }

    const full = Array.isArray(snapshot?.chain) ? (snapshot?.chain?.length ?? 0) : 0;
    let hidden = 0;

    if (snapshot?.isAi && full > revealed) {
      const chain = snapshot.chain ?? [];
      for (let index = full - 1; index >= revealed; index -= 1) {
        if (chain[index]?.seat && chain[index]?.seat === snapshot.opponentSeat) hidden += 1;
        else break;
      }
    }

    if (hidden === 0) {
      revealedRef.current = full;
      setHeldFrom(null);
      return undefined;
    }

    setHeldFrom(full - hidden);
    const timer = setTimeout(() => {
      revealedRef.current = full;
      setHeldFrom(null);
    }, BOT_REVEAL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [snapshot]);

  return useMemo(() => {
    if (heldFrom === null || !snapshot) return snapshot;
    const full = Array.isArray(snapshot.chain) ? snapshot.chain.length : 0;
    if (full <= heldFrom) return snapshot;
    return withChainHeldBack(snapshot, full - heldFrom);
  }, [snapshot, heldFrom]);
}
