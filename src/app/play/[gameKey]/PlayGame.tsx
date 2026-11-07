"use client";

// src/app/play/[gameKey]/PlayGame.tsx
//
// The mapping from an exportable game key to the game's own screen.
//
// The components are the app's real game screens
// (src/app/casino/<game>/PageClient.tsx) — no wrapper, no props, no fork — which
// is what keeps the portal build honest when a game changes.
//
// WHY STATIC IMPORTS. `next/dynamic` with a relative specifier does not typecheck
// under this repo's `module: node16` / `moduleResolution: node16` (TS2835: a
// relative dynamic import wants an explicit extension, and the project does not
// enable `allowImportingTsExtensions`). The rest of the app therefore uses plain
// imports and lets Next split by route; this route is one page, so the five
// screens land in its chunk. That costs bundle size on the portal surface, which
// no portal we can ship to measures — and it is the difference between building
// and not building.
//
// Adding a game here is not enough to export it: lib/portal/catalog.ts is the
// closed list the page validates against, and tests/portal-surface.test.mjs
// keeps the two in step.

import type { ComponentType } from "react";

import TicTacToe from "../../casino/tic-tac-toe/PageClient";
import Dominoes from "../../casino/dominoes/PageClient";
import Battleship from "../../casino/battleship/PageClient";
import Odds from "../../casino/odds/PageClient";
import SolitaireDuel from "../../casino/solitaire-duel/PageClient";

const GAME_COMPONENTS: Record<string, ComponentType> = {
  "tic-tac-toe": TicTacToe,
  dominoes: Dominoes,
  battleship: Battleship,
  odds: Odds,
  "solitaire-duel": SolitaireDuel,
};

export default function PlayGame({ gameKey }: { gameKey: string }) {
  const Game = GAME_COMPONENTS[gameKey];
  // The page has already validated the key; this is the belt to its braces.
  if (!Game) return null;
  return <Game />;
}
