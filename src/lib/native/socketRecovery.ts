// src/lib/native/socketRecovery.ts
//
// Phase 3B — recover the EXISTING Socket.IO connection when the native app
// returns to the foreground or the device's network comes back.
//
// This module owns the decision logic only. It creates no socket, no manager,
// no listener and no timer; every collaborator is passed in, which is what
// makes the rules below testable without a device, a browser or a server.
//
// ── Why so little happens here ────────────────────────────────────────────
//
// A reconnect in GRYND already restores state, because everything that must be
// restored is bound to the socket's own `connect` event:
//
//   * `src/context/SocketProvider.tsx` re-emits `user:join` on every `connect`
//     (the realtime server derives the room from the verified Clerk subject);
//   * every game page re-emits its own room join on `connect`
//     (`socket.on("connect", join)`), so room membership — and with it the
//     server-authoritative match, turns, timers and scores — is re-established
//     by the established protocol.
//
// Therefore recovery must NOT join rooms, re-send moves/bets, or start a new
// match. It only has to make the transport connect again, with a fresh Clerk
// token, using the one existing client. Duplicating any of the above would
// double-join rooms or replay a non-idempotent action.
//
// ── Why calling connect() is safe mid-reconnect ───────────────────────────
//
// `socket.io-client`'s `Socket#connect()`:
//   - returns immediately when `connected` is true;
//   - does NOT reopen the manager while it is `_reconnecting`, so an attempt
//     already in flight is left to the existing backoff;
//   - otherwise reopens the manager, which is the only way back after the
//     configured attempt limit (`reconnectionAttempts: 10`) is exhausted and
//     Socket.IO has given up on its own.
//
// That is why a healthy socket is never disconnected here, and why the same
// instance is reused rather than replaced.

/** What woke the recovery up. Diagnostics only; it changes no behaviour. */
export type SocketRecoveryTrigger = "foreground" | "network";

/** Result of one `recover()` call. */
export type SocketRecoveryOutcome =
  /** Already connected — nothing was touched. */
  | "connected"
  /** The existing client was revived (auth refreshed, `connect()` requested). */
  | "recovered"
  /** No Clerk token (signed out, or Clerk not ready) — nothing attempted. */
  | "signed-out"
  /** Realtime is not configured in this build (`createConnection` → null). */
  | "unavailable"
  /** An attempt started less than `minIntervalMs` ago — deduped. */
  | "throttled"
  /** `getToken()`/`createConnection()` threw. */
  | "failed"
  /** The controller was disposed (component unmounted). */
  | "disposed";

/** The only socket surface recovery needs. `RealtimeSocket` satisfies it. */
export type RecoverableSocket = {
  connected: boolean;
};

export type SocketRecoveryOptions = {
  /** Current shared client, or null when none has been created yet. */
  getSocket(): RecoverableSocket | null | undefined;
  /**
   * The EXISTING connection helper (`createSocketConnection`). It must reuse
   * the shared instance, refresh its auth payload and request a connect.
   */
  createConnection(token: string): Promise<RecoverableSocket | null>;
  /** The existing Clerk accessor (`useAuth().getToken`). */
  getToken(): Promise<string | null>;
  /** Minimum gap between two attempts. Default `RECOVERY_MIN_INTERVAL_MS`. */
  minIntervalMs?: number;
  /** Clock, for tests. Default `Date.now`. */
  now?: () => number;
  /** Diagnostics. Receives the error only — never tokens or socket state. */
  onError?: (error: unknown) => void;
};

export type SocketRecoveryController = {
  recover(trigger: SocketRecoveryTrigger): Promise<SocketRecoveryOutcome>;
  /** Mark disposed, so a late async result cannot touch anything. */
  dispose(): void;
  isDisposed(): boolean;
  /** How many times `createConnection` has actually been invoked. */
  attemptCount(): number;
};

/**
 * Two seconds is longer than a foreground/network pair fires apart (both
 * commonly arrive within a few hundred ms of each other, and Android can repeat
 * `appStateChange` during a resume) and much shorter than Socket.IO's own 1–4s
 * backoff, so it collapses duplicates without masking a real recovery.
 */
export const RECOVERY_MIN_INTERVAL_MS = 2000;

/**
 * Build a recovery controller bound to one socket, one token source and one
 * connection helper.
 *
 * Guarantees:
 *  - a CONNECTED socket is never disconnected, re-created or re-authenticated;
 *  - only one recovery runs at a time (`recover()` returns the in-flight
 *    promise, so N events in a tick cost one attempt);
 *  - a burst cannot spend the token or the connect budget twice (throttle);
 *  - no token means no attempt (signed out must never connect);
 *  - after `dispose()` nothing is attempted and no result is applied.
 */
export function createSocketRecovery(
  options: SocketRecoveryOptions,
): SocketRecoveryController {
  const {
    getSocket,
    createConnection,
    getToken,
    minIntervalMs = RECOVERY_MIN_INTERVAL_MS,
    now = Date.now,
    onError,
  } = options;

  let disposed = false;
  let inFlight: Promise<SocketRecoveryOutcome> | null = null;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let attempts = 0;

  const report = (error: unknown) => {
    try {
      onError?.(error);
    } catch {
      // A broken diagnostic callback must never break recovery.
    }
  };

  async function run(): Promise<SocketRecoveryOutcome> {
    let token: string | null = null;
    try {
      // Plain `getToken()`: Clerk refreshes an expired session token itself.
      // No second auth mechanism, no storage of the token here.
      token = await getToken();
    } catch (error) {
      report(error);
      return "failed";
    }

    // Unmounted (or signed out) while the token was being fetched.
    if (disposed) return "disposed";
    if (!token) return "signed-out";

    // Counted before the await so a concurrent caller cannot see zero.
    lastAttemptAt = now();
    attempts += 1;

    try {
      const instance = await createConnection(token);
      if (disposed) return "disposed";
      return instance ? "recovered" : "unavailable";
    } catch (error) {
      report(error);
      return "failed";
    }
  }

  return {
    recover(trigger: SocketRecoveryTrigger): Promise<SocketRecoveryOutcome> {
      // The trigger is intentionally unused in the decision: a foreground and a
      // network restoration both mean "the transport may be dead, revive it".
      void trigger;

      if (disposed) return Promise.resolve("disposed");
      if (inFlight) return inFlight;

      // Fast paths, evaluated synchronously so a second event in the same tick
      // sees them rather than joining an already-resolved promise.
      if (getSocket()?.connected) return Promise.resolve("connected");
      if (now() - lastAttemptAt < minIntervalMs) {
        return Promise.resolve("throttled");
      }

      const pending = run().finally(() => {
        if (inFlight === pending) inFlight = null;
      });
      inFlight = pending;
      return pending;
    },

    dispose() {
      disposed = true;
      inFlight = null;
    },

    isDisposed() {
      return disposed;
    },

    attemptCount() {
      return attempts;
    },
  };
}
