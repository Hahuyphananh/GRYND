"use client";

import { useEffect, useState } from "react";
import type { RealtimeSocket } from "../lib/socket";

/**
 * Safety-net poll cadence for screens that also have a Socket.IO push path.
 *
 * Every game client already subscribes to a per-match room and re-fetches on
 * the pushed `*_MATCH_UPDATED` event, so the HTTP poll is only there to cover
 * a dropped/never-connected socket. Polling at the same 5s rate regardless of
 * socket health was the single largest source of avoidable Postgres reads —
 * a player waiting on an opponent generated a query every 5s that the push
 * path would have delivered anyway.
 */
export const SOCKET_HEALTHY_POLL_MS = 30_000;
export const SOCKET_DOWN_POLL_MS = 5_000;

/**
 * Run `callback` on an interval, but ONLY while the tab is visible.
 *
 * Why: a backgrounded tab cannot be played, yet a naive `setInterval` keeps
 * firing — browsers throttle hidden-tab timers to roughly once per minute, so
 * the old behaviour produced stale-then-bursty reads that still reached
 * Postgres. Stopping the timer entirely removes that load, and returning to
 * the tab fires one immediate catch-up refresh so the UI is never stale.
 *
 * `callback` is held in a ref, so a new function identity each render does NOT
 * restart the timer — only `intervalMs`/`enabled` do.
 *
 *   useVisiblePoll(fetchStatus, socketConnected ? SOCKET_HEALTHY_POLL_MS : SOCKET_DOWN_POLL_MS, hasMatch);
 */
export function useVisiblePoll(
  callback: () => void | Promise<void>,
  intervalMs: number,
  enabled = true,
): void {
  // Keep the latest callback without restarting the interval on every render.
  const callbackRef = useEffectEvent(callback);

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => {
        void callbackRef.current();
      }, intervalMs);
    };

    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Catch up immediately — the data went stale while we were hidden.
        void callbackRef.current();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs, enabled, callbackRef]);
}

/**
 * Imperative twin of `useVisiblePoll` for callers that live INSIDE an effect.
 *
 * Many game clients declare their poll callback inside the effect that starts
 * it, so they cannot call a hook there (hooks are forbidden inside effects).
 * This runs the same visibility gating as a plain function and returns a
 * cleanup, which keeps those call sites a two-line change:
 *
 *   const stop = startVisibleInterval(pollTurn, SOCKET_HEALTHY_POLL_MS);
 *   return () => { stop(); ... };
 *
 * Behaviour matches `useVisiblePoll`: the timer runs only while the tab is
 * visible, and returning to the tab fires one immediate catch-up tick.
 */
export function startVisibleInterval(
  tick: () => void | Promise<void>,
  intervalMs: number,
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;

  const start = () => {
    if (timer !== null) return;
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
  };

  const stop = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      void tick();
      start();
    } else {
      stop();
    }
  };

  if (document.visibilityState === "visible") start();
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    stop();
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

/**
 * Housekeeping/lobby poll: ONE immediate read on mount, then a visibility-gated
 * interval that relaxes to the socket-healthy cadence and only tightens while
 * the push path is actually down.
 *
 * Why this exists: every lobby page runs a Socket.IO room that already pushes a
 * `*_MATCH_UPDATED` event the instant a lobby is created/joined/cancelled, yet
 * each one ALSO ran a flat 3s HTTP poll as a safety net. That made the poll a
 * pure backstop that still cost a Postgres round-trip every 3s per open tab —
 * the single largest source of avoidable function invocations once a player
 * parked on a lobby. This keeps the same coverage (immediate read, catch-up on
 * tab focus, fallback if the socket dies) at a fraction of the invocations.
 *
 *   useSocketAwarePoll(fetchLobbies, socket, Boolean(isSignedIn));
 *
 * Behaviour is unchanged in the common case: the socket push still drives
 * instant updates, and the poll only matters when the socket is unavailable
 * (then it runs at `SOCKET_DOWN_POLL_MS`) or as a slow reconciliation sweep.
 */
export function useSocketAwarePoll(
  callback: () => void | Promise<void>,
  socket: RealtimeSocket | null | undefined,
  enabled = true,
): void {
  const callbackRef = useEffectEvent(callback);
  const connected = useSocketConnected(socket);

  // Immediate read on mount (and when the gate flips on), so the first paint
  // never waits a whole interval for data the page already needs.
  useEffect(() => {
    if (!enabled) return;
    void callbackRef.current();
  }, [enabled, callbackRef]);

  useVisiblePoll(
    callback,
    connected ? SOCKET_HEALTHY_POLL_MS : SOCKET_DOWN_POLL_MS,
    enabled,
  );
}

/**
 * Ref that always points at the latest callback. Kept in a small helper so the
 * assignment happens in an effect (not during render), which keeps this safe
 * under concurrent rendering.
 */
function useEffectEvent<T extends (...args: never[]) => unknown>(value: T) {
  const [ref] = useState(() => ({ current: value }));
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * Imperative, socket-aware twin of `startVisibleInterval`.
 *
 * For poll callbacks declared INSIDE an effect (where hooks are forbidden) that
 * also live alongside a Socket.IO room. It picks the healthy cadence while the
 * socket is up, tightens to `SOCKET_DOWN_POLL_MS` the moment it drops, and
 * re-reads on the socket's own `connect`/`disconnect` events so the cadence
 * tracks reality instead of being frozen at effect setup.
 *
 *   const stop = startSocketAwareInterval(poll, socket);
 *   return () => { ...; stop(); };
 */
export function startSocketAwareInterval(
  tick: () => void | Promise<void>,
  socket: RealtimeSocket | null | undefined,
): () => void {
  let stop = () => {};

  const restart = () => {
    stop();
    stop = startVisibleInterval(
      tick,
      socket?.connected ? SOCKET_HEALTHY_POLL_MS : SOCKET_DOWN_POLL_MS,
    );
  };

  restart();

  const onConnect = () => restart();
  const onDisconnect = () => restart();
  socket?.on("connect", onConnect);
  socket?.on("disconnect", onDisconnect);

  return () => {
    stop();
    socket?.off("connect", onConnect);
    socket?.off("disconnect", onDisconnect);
  };
}

/**
 * Reactive view of a socket's connection state.
 *
 * `socket.connected` is a plain property that changes without a re-render, so
 * reading it directly cannot drive a poll cadence. Subscribing to the socket's
 * own `connect`/`disconnect` events makes it a real dependency — the poll then
 * speeds up while the push path is down and relaxes once it is healthy.
 *
 * Safe to use alongside a page's own `connect`/`disconnect` listeners:
 * socket.io allows multiple listeners for the same event.
 */
export function useSocketConnected(
  socket: RealtimeSocket | null | undefined,
): boolean {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!socket) {
      setConnected(false);
      return;
    }

    setConnected(socket.connected);

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    // The socket may have connected between the initial read and subscribing.
    setConnected(socket.connected);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, [socket]);

  return connected;
}
