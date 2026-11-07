"use client";

// src/app/play/[gameKey]/[matchId]/PlayMatch.tsx
//
// A game's own MATCH screen, rendered on the portal surface.
//
// Each entry is the component the app already serves at /casino/<game>/<id>
// (or /casino/odds/game/<id>). They read their id from `useParams()`, so they
// work unchanged under /play/<game>/<id> — the id segment has the same name.
//
// Battleship is not here: its practice match renders inside the lobby page, so
// it has no board route to mirror (lib/portal/framing exports
// `hasPortalMatchRoute` as the single source of that rule).
//
// Ads: the tic-tac-toe board takes the server-resolved post-match ad switches,
// and a portal frame must not carry GRYND's own advertising, so they are passed
// as off/ad-free. The other boards resolve their own surface, which
// components/result/PvpResultScreen suppresses on the portal path.

import type { ComponentType } from "react";

import TicTacToeMatch from "../../../casino/tic-tac-toe/[matchId]/PageClient";
import DominoesMatch from "../../../casino/dominoes/[matchId]/PageClient";
import OddsMatch from "../../../casino/odds/game/[matchId]/PageClient";
import SolitaireDuelMatch from "../../../casino/solitaire-duel/[matchId]/PageClient";

type MatchProps = { postMatchAdsEnabled?: boolean; postMatchAdFree?: boolean };

const MATCH_COMPONENTS: Record<string, ComponentType<MatchProps>> = {
  "tic-tac-toe": TicTacToeMatch,
  dominoes: DominoesMatch,
  odds: OddsMatch,
  "solitaire-duel": SolitaireDuelMatch,
};

export default function PlayMatch({ gameKey }: { gameKey: string }) {
  const Match = MATCH_COMPONENTS[gameKey];
  // The page has already 404'd anything without a board; this is the belt.
  if (!Match) return null;
  return <Match postMatchAdsEnabled={false} postMatchAdFree />;
}
