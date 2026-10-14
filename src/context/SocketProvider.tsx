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

  // Subscribe the socket to this user's OWN notification room.
  //
  // The realtime server derives the room id from the verified Clerk subject on
  // the socket, so naming a room here cannot subscribe anyone to another
  // player's notifications. It must be re-emitted on every reconnect (Socket.IO
  // does not restore room membership), which is why it is bound to `connect`
  // rather than sent once. Signals arriving there only mean "refetch" — the
  // room/invitation state is always read back over the authenticated session.
  useEffect(() => {
    if (!socket) return;

    const joinUserRoom = () => socket.emit("user:join");
    joinUserRoom();
    socket.on("connect", joinUserRoom);

    return () => {
      socket.off("connect", joinUserRoom);
    };
  }, [socket]);

  const value = useMemo(() => ({ socket, userId: isSignedIn ? userId : null }), [socket, isSignedIn, userId]);

  return (
    <SocketContext.Provider value={value}>{children}</SocketContext.Provider>
  );
}

export function useSocket() {
  return useContext(SocketContext);
}
