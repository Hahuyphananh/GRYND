"use client";

// src/app/casino/solitaire-duel/PageClient.tsx
//
// Solitaire Duel lobby route.
//
// The lobby itself lives in src/components/solitaire-duel/SolitaireLobby, the
// same component the homepage mounts, so `/` and this route can never drift
// apart on matchmaking, practice, queue state, resume or cancel.
//
// The match route stays where it is: `./[matchId]/PageClient` is the race —
// the server's board, the server's clock and the server's verdict.

import SolitaireLobby from "../../../components/solitaire-duel/SolitaireLobby";

export default function SolitaireDuelLobbyPage() {
  return <SolitaireLobby variant="page" />;
}
