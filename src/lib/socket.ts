import { io, type Socket } from "socket.io-client";

export type RealtimeSocket = Socket;

let socketInstance: RealtimeSocket | null = null;

function getSocketUrl(): string | null {
  const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL;

  if (!socketUrl) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "NEXT_PUBLIC_SOCKET_URL is missing. Realtime features are disabled.",
      );
    }
    return null;
  }

  return socketUrl.trim().replace(/\/$/, "");
}

export async function createSocketConnection(
  token: string,
): Promise<RealtimeSocket | null> {
  const socketUrl = getSocketUrl();

  if (!socketUrl) {
    return null;
  }

  if (socketInstance?.connected) {
    return socketInstance;
  }

  if (socketInstance && !socketInstance.connected) {
    socketInstance.auth = { token };
    socketInstance.connect();
    return socketInstance;
  }

  socketInstance = io(socketUrl, {
    autoConnect: true,
    transports: ["websocket", "polling"],
    // Connect timeout: fail fast on a bad network node instead of hanging.
    // Real websocket handshakes complete in well under a second when healthy;
    // 10s is plenty and prevents the UI from feeling frozen while we retry.
    timeout: 10000,
    reconnection: true,
    reconnectionAttempts: 10,
    // Start small (1s) and cap the backoff so recovery is snappy: with
    // exponential growth the wait can otherwise stretch to tens of seconds
    // after a blip, which looks like "the connection died" mid-game.
    reconnectionDelay: 1000,
    reconnectionDelayMax: 4000,
    auth: {
      token,
    },
  });

  socketInstance.on("connect_error", (error) => {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[socket] connect_error:", error.message, "- retrying...");
    }
  });

  socketInstance.on("reconnect_attempt", (attempt) => {
    if (process.env.NODE_ENV !== "production") {
      console.info("[socket] reconnect attempt:", attempt);
    }
  });

  socketInstance.on("disconnect", (reason) => {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[socket] disconnected:", reason);
    }
  });

  return socketInstance;
}

export function getSocket(): RealtimeSocket | null {
  return socketInstance;
}

export function disconnectSocket(): void {
  if (!socketInstance) return;
  socketInstance.disconnect();
  socketInstance = null;
}
