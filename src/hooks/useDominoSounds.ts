"use client";

// src/hooks/useDominoSounds.ts
//
// SOUND FOR A MOVE — the viewer's own, or the opponent's.
//
// The board is server-authoritative, so "a move happened" is simply the
// snapshot advancing: `ply` counts every accepted action, `chain` grows on a
// play and `drawPileCount` shrinks on a draw. Watching those three numbers means
// one hook covers both seats and the bot, and the sound follows the SERVER's
// verdict rather than a click — a refused move stays silent.
//
// The first render never sounds (there is nothing to compare against, and a
// reload of a mid-match board would clack once for no reason), and a version
// that goes backwards is a new match rather than a move.

import { useEffect, useRef } from "react";

import { playDominoSound, unlockDominoSound } from "../lib/dominoes/sound";

/** The slice of the match snapshot this hook reads. */
export type DominoSoundSnapshot = {
  ply?: unknown;
  chain?: unknown;
  drawPileCount?: unknown;
} | null;

type Fingerprint = { ply: number; chainLength: number; pile: number };

function fingerprintOf(snapshot: DominoSoundSnapshot): Fingerprint {
  return {
    ply: Number(snapshot?.ply ?? 0) || 0,
    chainLength: Array.isArray(snapshot?.chain) ? snapshot.chain.length : 0,
    pile: Number(snapshot?.drawPileCount ?? 0) || 0,
  };
}

/**
 * Play the table sound for every accepted move as it reaches this client.
 *
 * Placement is the only sound the game needs to be legible; the draw and the
 * pass are quieter, so a player who is watching the board still hears whose turn
 * produced what.
 */
export function useDominoSounds(snapshot: DominoSoundSnapshot): void {
  const previous = useRef<Fingerprint | null>(null);
  const current = fingerprintOf(snapshot);

  // The browser only allows audio after a real gesture, and a move arrives from
  // the server rather than from a click — so the first tap or key press on the
  // page arms the table. Silent: it makes no sound itself.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const unlock = () => unlockDominoSound();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => {
    const before = previous.current;
    previous.current = { ply: current.ply, chainLength: current.chainLength, pile: current.pile };

    if (!before) return;
    // Nothing advanced (a poll that changed the clock), or a new match started.
    if (current.ply <= before.ply) return;

    if (current.chainLength > before.chainLength) {
      playDominoSound("place");
    } else if (current.pile < before.pile) {
      playDominoSound("draw");
    } else {
      playDominoSound("pass");
    }
    // The fingerprint is compared value by value inside the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.ply, current.chainLength, current.pile]);
}

export default useDominoSounds;
