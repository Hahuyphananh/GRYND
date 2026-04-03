'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Socket } from 'socket.io-client';
import { useAuth } from '@clerk/nextjs';
import { createSocketConnection, disconnectSocket } from '../lib/socket';

type SocketContextValue = {
  socket: Socket | null;
  isConnected: boolean;
  joinGameRoom: (gameId: string) => void;
  leaveGameRoom: (gameId: string) => void;
  emitMove: (payload: { gameId: string; move: unknown }) => void;
};

const SocketContext = createContext<SocketContextValue | undefined>(undefined);

export function SocketProvider({ children }: { children: ReactNode }) {
  const { getToken, isSignedIn } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const connectSocket = async () => {
      if (!isSignedIn) {
        disconnectSocket();
        setSocket(null);
        setIsConnected(false);
        return;
      }

      const token = await getToken();
      if (cancelled) {
        return;
      }

      const nextSocket = createSocketConnection(token ?? undefined);

      const handleConnect = () => setIsConnected(true);
      const handleDisconnect = () => setIsConnected(false);

      nextSocket.on('connect', handleConnect);
      nextSocket.on('disconnect', handleDisconnect);

      setSocket(nextSocket);
      setIsConnected(nextSocket.connected);

      return () => {
        nextSocket.off('connect', handleConnect);
        nextSocket.off('disconnect', handleDisconnect);
      };
    };

    const cleanupPromise = connectSocket();

    return () => {
      cancelled = true;
      cleanupPromise?.then((cleanup) => cleanup?.());
    };
  }, [getToken, isSignedIn]);

  const joinGameRoom = useCallback(
    (gameId: string) => {
      socket?.emit('join_game', { gameId });
    },
    [socket],
  );

  const leaveGameRoom = useCallback(
    (gameId: string) => {
      socket?.emit('leave_game', { gameId });
    },
    [socket],
  );

  const emitMove = useCallback(
    (payload: { gameId: string; move: unknown }) => {
      socket?.emit('move', payload);
    },
    [socket],
  );

  const value = useMemo(
    () => ({ socket, isConnected, joinGameRoom, leaveGameRoom, emitMove }),
    [socket, isConnected, joinGameRoom, leaveGameRoom, emitMove],
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket() {
  const context = useContext(SocketContext);

  if (!context) {
    throw new Error('useSocket must be used within SocketProvider');
  }

  return context;
}
