"use client";

// src/app/play/[gameKey]/[matchId]/PlayMatch.tsx
//
// A game's own MATCH screen, rendered on the portal surface.
//
// Solitaire Duel is the only exported game, so it is the only entry. The
// component reads its id from `useParams()` and works unchanged under
// /play/solitaire-duel/<id> because the id segment has the same name.
//
// Ads: a portal frame must not carry GRYND's own advertising, so the
// post-match switches are passed as off/ad-free.

import SolitaireDuelMatch from "../../../casino/solitaire-duel/[matchId]/PageClient";

export default function PlayMatch({ gameKey }: { gameKey: string }) {
  if (gameKey !== "solitaire-duel") return null;
  return <SolitaireDuelMatch />;
}
