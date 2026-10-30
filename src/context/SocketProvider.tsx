"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  createSocketConnection,
  disconnectSocket,
  getSocket,
  type RealtimeSocket,
} from "../lib/socket";
import {
  subscribeToAppStateChange,
  subscribeToNetworkStatusChange,
} from "../lib/native/appLifecycle";
import {
  RECOVERY_MIN_INTERVAL_MS,
  createSocketRecovery,
} from "../lib/native/socketRecovery";

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

  // ── Native lifecycle / network recovery (Phase 3B) ──────────────────────
  //
  // The native bridge (components/native/NativeLifecycleBridge) publishes
  // `grynd:app-state-change` and `grynd:network-status-change`, and ONLY on
  // Android/iOS. Neither event ever fires in a browser, so this effect is
  // inert on the web and the existing tab-visibility / `online` handling stays
  // the only recovery path there.
  //
  // Recovery is deliberately thin: refresh the Clerk token into the ONE
  // existing client and ask it to connect (see lib/native/socketRecovery).
  // Everything that has to be restored afterwards is already bound to the
  // socket's own `connect` event — `user:join` above, and each game page's own
  // room join — so nothing here re-sends a join, a move, a bet or a
  // matchmaking request.
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return undefined;

    // No `onError` handler: a failed attempt is benign — Socket.IO's own
    // `connect_error`/`disconnect` handlers in lib/socket.ts already report the
    // transport in development, and this provider reads no env directly.
    const controller = createSocketRecovery({
      getSocket,
      createConnection: createSocketConnection,
      getToken,
      minIntervalMs: RECOVERY_MIN_INTERVAL_MS,
    });

    // Only the "we are back" edges are triggers. A background/dropout edge has
    // nothing to recover, and letting the socket's own backoff finish is
    // better than racing it.
    const offAppState = subscribeToAppStateChange(({ isActive }) => {
      if (isActive) void controller.recover("foreground");
    });
    const offNetwork = subscribeToNetworkStatusChange(({ connected }) => {
      if (connected) void controller.recover("network");
    });

    return () => {
      offAppState();
      offNetwork();
      controller.dispose();
    };
  }, [getToken, isLoaded, isSignedIn]);

  const value = useMemo(() => ({ socket, userId: isSignedIn ? userId : null }), [socket, isSignedIn, userId]);

  return (
    <SocketContext.Provider value={value}>{children}</SocketContext.Provider>
  );
}

export function useSocket() {
  return useContext(SocketContext);
}
