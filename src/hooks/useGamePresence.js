'use client';

import { useEffect } from 'react';

export default function useGamePresence({ gameKey, gameId, enabled = true }) {
  useEffect(() => {
    if (!enabled || !gameKey) return;

    const inGamePayload = {
      gameKey,
      gameId: Number.isFinite(Number(gameId)) ? Number(gameId) : undefined,
    };

    const setInGame = () => {
      fetch('/api/presence/game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        keepalive: true,
        body: JSON.stringify(inGamePayload),
      }).catch((error) => {
        console.error('[GAME_PRESENCE_ERROR]', error);
      });
    };

    setInGame();
    const id = setInterval(setInGame, 15000);

    return () => {
      clearInterval(id);
      fetch('/api/presence/leave-game', {
        method: 'POST',
        credentials: 'include',
        keepalive: true,
      }).catch((error) => {
        console.error('[LEAVE_GAME_PRESENCE_ERROR]', error);
      });
    };
  }, [enabled, gameId, gameKey]);
}
