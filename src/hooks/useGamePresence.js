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
    // Refresh the "in game" marker on a two-minute cadence. The friends
    // presence feed's offline window is 6 minutes, so 120s keeps a player
    // labelled in-game with room to spare (3 beats per window) and halves
    // these writes vs. the 60s poll (a Neon UPSERT per in-game client).
    // Start/leave still post immediately on mount/unmount below.
    //
    // Gated on visibility: a hidden tab issues no keep-alive writes, and the
    // moment it becomes visible again the marker is re-posted before the
    // interval resumes.
    let id = null;
    const start = () => {
      if (id !== null) return;
      id = setInterval(setInGame, 120000);
    };
    const stop = () => {
      if (id === null) return;
      clearInterval(id);
      id = null;
    };
    if (typeof document === "undefined" || !document.hidden) start();
    const onVisibilityChange = () => {
      if (typeof document === "undefined") return;
      if (document.hidden) {
        stop();
      } else {
        setInGame();
        start();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
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
