"use client";

// src/app/play/[gameKey]/PlayGame.tsx
//
// The mapping from an exportable game key to the game's own screen.
//
// GRYND exports exactly one game to portals: Solitaire Duel. The component is
// the app's real game screen (src/app/casino/solitaire-duel/PageClient) — no
// wrapper, no props, no fork — which is what keeps the portal build honest.

import SolitaireDuel from "../../casino/solitaire-duel/PageClient";

export default function PlayGame({ gameKey }: { gameKey: string }) {
  if (gameKey !== "solitaire-duel") return null;
  return <SolitaireDuel />;
}
