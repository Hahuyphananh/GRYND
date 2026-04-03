'use client';

import { useEffect } from 'react';
import { useSocket } from '../context/SocketProvider';

type RealtimeMovePayload = {
  gameId: string;
  move: unknown;
};

type UseRealtimeGameOptions = {
  gameId: string;
  onOpponentMove?: (payload: RealtimeMovePayload) => void;
  onPlayerDisconnected?: (payload: { socketId: string }) => void;
};

export function useRealtimeGame({ gameId, onOpponentMove, onPlayerDisconnected }: UseRealtimeGameOptions) {
  const { socket, joinGameRoom, leaveGameRoom, emitMove, isConnected } = useSocket();

  useEffect(() => {
    if (!gameId || !isConnected) {
      return;
    }

    joinGameRoom(gameId);

    return () => {
      leaveGameRoom(gameId);
    };
  }, [gameId, isConnected, joinGameRoom, leaveGameRoom]);

  useEffect(() => {
    if (!socket) {
      return;
    }

    const handleOpponentMove = (payload: RealtimeMovePayload) => {
      if (payload.gameId === gameId) {
        onOpponentMove?.(payload);
      }
    };

    const handlePlayerDisconnected = (payload: { gameId: string; socketId: string }) => {
      if (payload.gameId === gameId) {
        onPlayerDisconnected?.({ socketId: payload.socketId });
      }
    };

    socket.on('move', handleOpponentMove);
    socket.on('player_disconnected', handlePlayerDisconnected);

    return () => {
      socket.off('move', handleOpponentMove);
      socket.off('player_disconnected', handlePlayerDisconnected);
    };
  }, [socket, gameId, onOpponentMove, onPlayerDisconnected]);

  const sendMove = (move: unknown) => {
    emitMove({ gameId, move });
  };

  return {
    sendMove,
  };
}
