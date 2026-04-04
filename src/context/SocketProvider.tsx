'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { createSocketConnection, disconnectSocket, type RealtimeSocket } from '../lib/socket';

type SocketContextValue = {
  socket: RealtimeSocket | null;
};

const SocketContext = createContext<SocketContextValue>({ socket: null });

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const { getToken, isSignedIn } = useAuth();
  const [socket, setSocket] = useState<RealtimeSocket | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function initSocket() {
      if (!isSignedIn) {
        disconnectSocket();
        setSocket(null);
        return;
      }

      const token = await getToken();
      if (!token) {
        setSocket(null);
        return;
      }

      const instance = await createSocketConnection(token);
      if (isMounted) {
        setSocket(instance);
      }
    }

    initSocket();

    return () => {
      isMounted = false;
    };
  }, [getToken, isSignedIn]);

  const value = useMemo(() => ({ socket }), [socket]);

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket() {
  return useContext(SocketContext);
}
