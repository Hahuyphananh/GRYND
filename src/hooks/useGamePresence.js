"use client";

import { useEffect } from "react";

export default function useGamePresence({ gameKey, gameId, enabled = true }) {
  useEffect(() => {
    if (!enabled || !gameKey) return;

    const inGamePayload = {
      gameKey,
      gameId: Number.isFinite(Number(gameId)) ? Number(gameId) : undefined,
    };

    const setInGame = () => {
      fetch("/api/presence/game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        keepalive: true,
        body: JSON.stringify(inGamePayload),
      }).catch((error) => {
        console.error("[GAME_PRESENCE_ERROR]", error);
      });
    };

    setInGame();
    // Refresh the "in game" marker on a minute cadence. The friends
    // presence feed only needs current_game_id to be fresh enough to label
    // a friend as playing; 60s is ample and cuts these writes 4x vs.
    // the old 15s poll (a Neon UPSERT per in-game client every 15s).
    const id = setInterval(setInGame, 60000);

    return () => {
      clearInterval(id);
      fetch("/api/presence/leave-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        keepalive: true,
        body: JSON.stringify({}),
      }).catch((error) => {
        console.error("[LEAVE_GAME_PRESENCE_ERROR]", error);
      });
    };
  }, [enabled, gameId, gameKey]);
}
