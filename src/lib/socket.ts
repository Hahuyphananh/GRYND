import { io, type Socket } from "socket.io-client";
import { resolveSocketUrl } from "./socketUrl";

export type RealtimeSocket = Socket;

let socketInstance: RealtimeSocket | null = null;

// ── Fresh Clerk token on every (re)connect ─────────────────────────────
//
// Socket.IO captures auth when the client is created. Clerk session tokens
// expire within minutes, so a reconnect after a longer dropout used to present
// the token captured at sign-in: the realtime server rejected it with
// "Invalid authentication token", and Socket.IO does NOT retry namespace-level
// auth failures on its own — realtime stayed dead until a full reload. The
// provider registers getToken here and the auth callback below runs for every
// handshake, so each attempt carries a currently valid token.
type SocketTokenProvider = () => Promise<string | null>;

let socketTokenProvider: SocketTokenProvider | null = null;
let currentToken: string | null = null;

/** Register (or clear) the Clerk token source. Called by SocketProvider. */
export function setSocketTokenProvider(
  provider: SocketTokenProvider | null,
): void {
  socketTokenProvider = provider;
}

/** Resolve a token for one handshake; never throws into Socket.IO. */
async function resolveAuthToken(): Promise<string> {
  if (!socketTokenProvider) return currentToken ?? "";
  try {
    return (await socketTokenProvider()) ?? currentToken ?? "";
  } catch {
    return currentToken ?? "";
  }
}

// Retry of an auth-level connect_error, with backoff. A permanently rejected
// session settles at one attempt per minute instead of spinning.
const AUTH_RETRY_BASE_MS = 3000;
const AUTH_RETRY_MAX_MS = 60000;
let authRetryTimer: ReturnType<typeof setTimeout> | null = null;
let authRetryDelayMs = AUTH_RETRY_BASE_MS;

function scheduleAuthRetry(): void {
  if (authRetryTimer) return;

  const delay = authRetryDelayMs;
  authRetryTimer = setTimeout(() => {
    authRetryTimer = null;
    authRetryDelayMs = Math.min(authRetryDelayMs * 2, AUTH_RETRY_MAX_MS);

    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const socket = socketInstance;
    if (!socket || socket.connected) return;
    socket.connect();
  }, delay);
}

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

  // Same-origin whenever the configured host is this page's www/apex twin.
  // The app is reachable as both, and dialing the other one turns a routine
  // handshake into a CORS decision — which is exactly what broke realtime on
  // the www host. See ./socketUrl.ts.
  const pageOrigin =
    typeof window !== "undefined" ? window.location.origin : null;

  return resolveSocketUrl(socketUrl, pageOrigin);
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
    // Keep the latest token as the fallback for environments where no token
    // provider is registered (e.g. a native recovery call).
    currentToken = token;
    socketInstance.connect();
    return socketInstance;
  }

  currentToken = token;

  socketInstance = io(socketUrl, {
    autoConnect: true,
    // Long-polling first, then the normal upgrade to a websocket.
    //
    // The service sits behind a reverse proxy, and requiring a websocket as the
    // FIRST transport made the whole connection fail — with a browser-level
    // "WebSocket connection … failed" error on every load — whenever that hop
    // did not carry the Upgrade header. Starting on polling still reaches the
    // same Socket.IO endpoint over ordinary HTTPS, and Socket.IO upgrades to
    // the websocket as soon as the handshake succeeds. A websocket-only failure
    // now costs one polling round-trip instead of the entire connection.
    transports: ["polling", "websocket"],
    // Connect timeout: fail fast on a bad network node instead of hanging.
    // Real websocket handshakes complete in well under a second when healthy;
    // 10s is plenty and prevents the UI from feeling frozen while we retry.
    timeout: 10000,
    reconnection: true,
    // Never give up. Ten attempts (~25-40s of failures) permanently disabled
    // realtime until a reload, which is exactly what a Wi-Fi blip or a laptop
    // wake looked like. The backoff cap below keeps retry traffic low.
    reconnectionAttempts: Infinity,
    // Start small (1s) and cap the backoff so recovery is snappy: with
    // exponential growth the wait can otherwise stretch to tens of seconds
    // after a blip, which looks like "the connection died" mid-game.
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    auth: (callback) => {
      // Re-evaluated for every handshake (initial connect and each reconnect),
      // so an expired Clerk token is never replayed forever.
      void resolveAuthToken().then((token) => callback({ token }));
    },
  });

  socketInstance.on("connect_error", (error) => {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[socket] connect_error:", error.message, "- retrying...");
    }

    // Transport failures are retried by Socket.IO's own (now uncapped)
    // backoff. Namespace middleware failures — an expired or invalid Clerk
    // token — are NOT, so retry those explicitly with a fresh token.
    if (!/auth|token/i.test(String(error?.message ?? ""))) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    scheduleAuthRetry();
  });

  socketInstance.on("connect", () => {
    authRetryDelayMs = AUTH_RETRY_BASE_MS;
    if (authRetryTimer) {
      clearTimeout(authRetryTimer);
      authRetryTimer = null;
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
  if (authRetryTimer) {
    clearTimeout(authRetryTimer);
    authRetryTimer = null;
  }
  authRetryDelayMs = AUTH_RETRY_BASE_MS;
  currentToken = null;

  if (!socketInstance) return;
  socketInstance.disconnect();
  socketInstance = null;
}
