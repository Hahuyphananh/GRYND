"use client";

import { useEffect, useRef } from "react";
import type { RealtimeSocket } from "../lib/socket";

/**
 * Event-driven match sync — the interval-free replacement for the per-match
 * `useVisiblePoll` backstop.
 *
 * A migrated match page already has:
 *
 *   * ONE authoritative GET on mount (the loader the page calls itself), and
 *   * a Socket.IO per-match room whose `*_MATCH_UPDATED` push re-fetches the
 *     authoritative snapshot the instant anything changes.
 *
 * What was left was a recurring `setInterval(fetchState, …)` used purely as a
 * safety net. This hook keeps the safety net's *coverage* without the timer:
 * it performs ONE authoritative read on the two edges where the push path can
 * genuinely have missed something —
 *
 *   1. the socket (re)connecting — Socket.IO does not replay events that were
 *      emitted while the client was away, so membership + state must be
 *      reconciled once; and
 *   2. the tab becoming visible again — browsers freeze a hidden tab, so its
 *      socket may have been parked through a burst of events.
 *
 * There is deliberately NO interval here. A recurring game-state GET is the
 * thing this hook exists to remove; if you find yourself wanting one, the
 * correct fix is another server push, not a timer.
 *
 * The callback is held in a ref so a new function identity each render does
 * not tear down and rebuild the listeners (they only depend on `socket` and
 * `enabled`). When `enabled` is false — a match that has ended, an invalid id —
 * every listener is removed, so a finished board stops syncing.
 *
 *   useMatchSync(load, socket, Boolean(matchId) && !terminal);
 */
export function useMatchSync(
  refresh: () => void | Promise<void>,
  socket: RealtimeSocket | null | undefined,
  enabled = true,
): void {
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });

  useEffect(() => {
    if (!enabled) return undefined;

    const run = () => {
      void refreshRef.current();
    };

    // Reconnect (and the rare late first connect) → exactly one read.
    const onConnect = () => run();
    socket?.on("connect", onConnect);

    // Returning to a hidden tab may have missed events → exactly one read.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      socket?.off("connect", onConnect);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [socket, enabled]);
}

/**
 * Imperative twin of `useMatchSync` for poll callbacks declared INSIDE an
 * effect (where hooks are forbidden) — the interval-free replacement for
 * `startSocketAwareInterval`.
 *
 * Same contract as the hook: reconcile ONCE when the socket reconnects and
 * once when the tab becomes visible again, and never on a timer. It returns
 * the cleanup, so an existing call site stays a one-line swap:
 *
 *   const stop = startMatchSync(poll, socket);
 *   return () => { ...; stop(); };
 */
export function startMatchSync(
  tick: () => void | Promise<void>,
  socket: RealtimeSocket | null | undefined,
): () => void {
  const onConnect = () => {
    void tick();
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") void tick();
  };

  socket?.on("connect", onConnect);
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    socket?.off("connect", onConnect);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
