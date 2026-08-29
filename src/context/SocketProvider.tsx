"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  createSocketConnection,
  disconnectSocket,
  type RealtimeSocket,
} from "../lib/socket";

type SocketContextValue = {
  socket: RealtimeSocket | null;
  userId: string | null;
};

const SocketContext = createContext<SocketContextValue>({ socket: null, userId: null });

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const { getToken, isSignedIn, isLoaded, userId } = useAuth(); // added isLoaded
  const [socket, setSocket] = useState<RealtimeSocket | null>(null);

  useEffect(() => {
    if (!isLoaded) return; // wait for Clerk hydration

    let isMounted = true;

    async function initSocket() {
      if (!isSignedIn) {
        disconnectSocket();
        setSocket(null);
        return;
      }

      const token = await getToken();
      if (!token) return;

      const instance = await createSocketConnection(token);
      if (isMounted) {
        setSocket(instance);
      }
    }

    initSocket();

    return () => {
      isMounted = false;
    };
  }, [getToken, isSignedIn, isLoaded]);

  const value = useMemo(() => ({ socket, userId: isSignedIn ? userId : null }), [socket, isSignedIn, userId]);

  return (
    <SocketContext.Provider value={value}>{children}</SocketContext.Provider>
  );
}

export function useSocket() {
  return useContext(SocketContext);
}
