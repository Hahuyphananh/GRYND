"use client";

// src/hooks/useMySeatIdentity.js
//
// Resolves the CURRENT user's display identity (real username, official
// Grynd icon key, equipped name color) from /api/get-user-tokens. Used by
// the client-side (vs-AI) game pages — chess-AI, RPS vs AI, four-in-a-row
// vs AI — that have no server match payload carrying seat identity.
//
// Server-driven PvP games should use the server's getSeatIdentity /
// attachSeatIdentity plumbing instead (the match GET returns
// player1Name/player1IconKey/player1NameColor etc. per seat).
//
// Returns `null` fields until the fetch resolves (or on failure), so
// callers can render with their existing fallback labels ("You" / "AI").

import { useEffect, useState } from "react";

export default function useMySeatIdentity() {
  const [identity, setIdentity] = useState({
    name: null,
    iconKey: null,
    nameColor: null,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/get-user-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });
        const data = await res.json();
        if (cancelled) return;
        if (data?.success && data.data) {
          setIdentity({
            name: data.data.name || null,
            iconKey: data.data.selectedIcon || null,
            nameColor: data.data.nameColor || null,
          });
        }
      } catch {
        // Best-effort — callers fall back to their existing labels.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return identity;
}