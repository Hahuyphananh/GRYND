"use client";

// ── Server-state sync for the Precision match page ───────────────────────
//
// Owns the ONE copy of the match snapshot every view of the page reads, and
// every way it can be updated:
//
//   * the `get-match` poll (the canonical refresh path),
//   * the match-room socket broadcasts (ready-up, round-arm, round-result,
//     match-finished).
//
// Ordering is enforced in one place (`applySnapshot`): snapshots carry a
// monotonic `version`, and an older snapshot that lands after a newer one is
// dropped instead of regressing the page to a round that had already been
// decided. Nothing here interprets gameplay — it just guarantees that what the
// page renders is the newest server truth it has seen.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  AI_MATCH_POLL_INTERVAL_MS,
  MATCH_POLL_INTERVAL_MS,
  SOCKET_NAMESPACE,
} from "../lib/precision/constants";
import { isStaleSnapshot } from "../lib/precision/matchView";
import { joinMatchRoom, leaveMatchRoom } from "../lib/precision/multiplayer";
import { estimateServerClockOffset } from "../lib/precision/roundClock";
import type { PrecisionState } from "../lib/precision/types";
import type { RealtimeSocket } from "../lib/socket";

/** Server-side lookup result for THIS match id. `missing` means the store no
 *  longer holds a match (or a waiting lobby) for it — the match was
 *  finished/swept/cancelled, or the URL is stale (an old lobby a player was
 *  redirected back to). The page then says so instead of rendering a fake
 *  waiting room with placeholder seats, which read as a dead "blank" page. */
export type PrecisionLookup = "pending" | "found" | "missing";

export interface UsePrecisionMatchStateOptions {
  matchId: string;
  socket: RealtimeSocket | null;
  /** Fired after a snapshot carrying a freshly decided round was applied. */
  onRoundResult?: () => void;
  /** Fired after a snapshot that flipped a seat's Ready flag was applied. */
  onReadySnapshot?: (next: PrecisionState) => void;
}

export interface UsePrecisionMatchStateResult {
  state: PrecisionState | null;
  /** Latest snapshot, readable from async handlers without re-binding them. */
  stateRef: React.MutableRefObject<PrecisionState | null>;
  /** `deviceWallClock - serverWallClock`, estimated from the poll's own round
   *  trip (see `estimateServerClockOffset`). 0 until the first response that
   *  carries the server's clock. The round clock uses it to express the
   *  server's GO instant without inheriting the device's clock skew. */
  serverClockOffsetMs: number;
  lookup: PrecisionLookup;
  /** Apply a server snapshot if it is not older than what is on screen.
   *  Returns true when it was applied. */
  applySnapshot: (next: PrecisionState | null | undefined) => boolean;
  /** Re-read the match from the server. */
  refreshState: () => Promise<void>;
}

export function usePrecisionMatchState({
  matchId,
  socket,
  onRoundResult,
  onReadySnapshot,
}: UsePrecisionMatchStateOptions): UsePrecisionMatchStateResult {
  const [state, setState] = useState<PrecisionState | null>(null);
  const [lookup, setLookup] = useState<PrecisionLookup>("pending");
  // Device→server wall-clock offset, refreshed on every poll that carries the
  // server's own `now`. 0 (uncorrected) until the first such response.
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState(0);

  // Keep a ref of latest state so async handlers always operate on the
  // freshest copy. Matches the closure-protection pattern used elsewhere.
  const stateRef = useRef<PrecisionState | null>(null);
  stateRef.current = state;

  // Callbacks are read through a ref so the socket listeners below keep a
  // stable identity: the page passes them inline, and re-binding every
  // listener on each render would churn the room lifecycle.
  const callbacksRef = useRef({ onRoundResult, onReadySnapshot });
  callbacksRef.current = { onRoundResult, onReadySnapshot };

  // ── Snapshot application (stale-response guard) ──────────────────────
  const applySnapshot = useCallback(
    (next: PrecisionState | null | undefined): boolean => {
      if (!next || next.matchId !== matchId) return false;
      if (isStaleSnapshot(stateRef.current, next)) {
        // Stale — a newer snapshot is already on screen. Ignore it so the
        // phase / target / timer can never roll backwards.
        return false;
      }
      // Keep the ref in lockstep so two snapshots applied in the same tick are
      // still ordered correctly relative to each other.
      stateRef.current = next;
      setState(next);
      return true;
    },
    [matchId]
  );

  // ── Polling ──────────────────────────────────────────────────────────
  // The match page polls /api/precision/get-match every
  // `MATCH_POLL_INTERVAL_MS`. This IS the canonical refresh path: a hard
  // browser reload (`F5`) re-runs `refreshState` synchronously on mount and
  // the server's match state is restored. The server NEVER resets the match
  // on disconnect — `realtime-server/server.js`'s `disconnect` handler only
  // drops the user from the participation map (`forgetPrecisionUser`),
  // leaving the persisted match row intact so the next reconnect resumes
  // mid-game.
  //
  // We pull `socket?.id` into the deps so a socket RECONNECT (new socket id,
  // same matchId) tears this effect down + re-runs it, firing
  // `refreshState` synchronously instead of waiting up to one tick for the
  // next poll. Without this, a reconnecting player could see a stale local
  // state for ~2s while the broadcast lag resolves. The polling cadence is
  // otherwise unaffected.
  //
  // `refreshState` is the ONE canonical refresh, shared by that cadence and
  // the post-countdown fast poll (owned by `usePrecisionRoundClock`). Stable
  // identity (`matchId` is the only dep) so the effects scheduling it never
  // churn the interval.
  const refreshState = useCallback(async () => {
    try {
      // Audit fix: skip the HTTP refresh once the match is terminally
      // finished. After `phase === "finished"` the canonical state never
      // changes — polling would just burn a request every tick. The
      // end-popup's auto-return effect navigates away once the replay window
      // expires, so there's no UX benefit to continued polling.
      if (stateRef.current?.phase === "finished") return;
      const sentAtDeviceMs = Date.now();
      const res = await fetch(`/api/precision/get-match?matchId=${encodeURIComponent(matchId)}`, {
        cache: "no-store",
      });
      const data = await res.json();
      // Align the display clock to the server's, using this response's own
      // round trip. Without it the round timer is bridged through the device's
      // wall clock, so a skewed device shows a round that is seconds away from
      // the one the server scores — the player stops on the number they see and
      // is graded as if they never stopped at all.
      const offsetMs = estimateServerClockOffset({
        sentAtDeviceMs,
        receivedAtDeviceMs: Date.now(),
        serverNowMs: Number(data?.now),
      });
      if (offsetMs !== null) setServerClockOffsetMs(offsetMs);
      const next = data?.match as PrecisionState | null | undefined;
      // `matchId` is echoed on every snapshot — ignore a response that
      // belongs to a different match (an in-flight fetch that resolved after
      // the route param changed) rather than tearing down this page's state.
      if (next && next.matchId === matchId) {
        // Dropped internally when it is older than what is already shown.
        applySnapshot(next);
        setLookup("found");
        return;
      }
      // No match AND no waiting lobby for this id: the store no longer holds
      // anything to advance this page (finished + swept, cancelled, or a
      // stale link). Surface it explicitly instead of leaving the player on a
      // placeholder waiting room that can never progress. Polling keeps
      // running, so if the state reappears (a blip, or a match created by the
      // other seat) the `found` branch above takes over automatically.
      setLookup("missing");
    } catch {
      // Network blip — try again next tick.
    }
  }, [matchId, applySnapshot]);

  // Tighten the poll cadence ONLY while a free vs-AI round is in flight. The
  // bot's stop is applied lazily on a server read, so at the normal 2s cadence
  // its rocket could sit frozen on the wire for up to two seconds. PvP keeps
  // the normal cadence — a human opponent's stop must not become observable
  // faster than the round resolves.
  const matchPollIntervalMs =
    state?.isAiGame === true && state?.phase === "active"
      ? AI_MATCH_POLL_INTERVAL_MS
      : MATCH_POLL_INTERVAL_MS;

  useEffect(() => {
    void refreshState();
    const id = setInterval(() => {
      void refreshState();
    }, matchPollIntervalMs);
    return () => clearInterval(id);
  }, [refreshState, socket?.id, matchPollIntervalMs]);

  // ── Realtime room ────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket || !matchId) return;
    // Re-join on EVERY socket (re)connection — Socket.IO doesn't re-join
    // rooms automatically, and the realtime server's disconnect grace
    // timer is only cancelled by a re-join. Without this, a refresh or
    // network blip would forfeit the match once the grace window expires.
    const join = () => joinMatchRoom(socket, matchId);
    join();
    socket.on("connect", join);
    return () => {
      socket.off("connect", join);
      leaveMatchRoom(socket, matchId);
    };
  }, [socket, matchId]);

  // ── Ready-up socket events ─────────────────────────────────────────
  // Both players join the same matchRoom. When either clicks Ready, the
  // caller emits `playerReadyEvent` carrying the new authoritative match
  // snapshot. When both are ready, the second caller adds
  // `matchStartEvent` so the opponent flips to the active phase without
  // waiting for the next poll tick.
  useEffect(() => {
    if (!socket || !matchId) return;

    const handlePlayerReady = (payload: any) => {
      if (payload?.matchId !== matchId) return;
      if (payload?.match) {
        const next = payload.match as PrecisionState;
        applySnapshot(next);
        callbacksRef.current.onReadySnapshot?.(next);
      }
    };
    const handleMatchStart = (payload: any) => {
      if (payload?.matchId !== matchId) return;
      if (payload?.match) applySnapshot(payload.match as PrecisionState);
      else if (stateRef.current) {
        // Best-effort flip when the broadcast didn't carry a snapshot — the
        // next polling tick will reconcile anyway.
        applySnapshot({
          ...stateRef.current,
          phase: "active",
          version: stateRef.current.version + 1,
        });
      }
    };

    socket.on(SOCKET_NAMESPACE.playerReadyEvent, handlePlayerReady);
    socket.on(SOCKET_NAMESPACE.matchStartEvent, handleMatchStart);

    return () => {
      socket.off(SOCKET_NAMESPACE.playerReadyEvent, handlePlayerReady);
      socket.off(SOCKET_NAMESPACE.matchStartEvent, handleMatchStart);
    };
  }, [socket, matchId, applySnapshot]);

  // ── Round-result / match-finished socket events ─────────────────────
  // When either player's STOP is processed and BOTH have submitted, the
  // canonical `precision:roundResult` broadcast lands in the match room.
  // Polling is the source of truth; the socket event just lets the opponent
  // see the updated state within sub-second latency.
  useEffect(() => {
    if (!socket || !matchId) return;

    const handleRoundResult = (payload: any) => {
      if (payload?.matchId !== matchId) return;
      if (payload?.match) {
        applySnapshot(payload.match as PrecisionState);
        callbacksRef.current.onRoundResult?.();
      }
    };

    const handleMatchFinished = (payload: any) => {
      if (payload?.matchId !== matchId) return;
      if (payload?.match) applySnapshot(payload.match as PrecisionState);
      // Letting polling reconcile phase === "finished" is fine.
    };

    socket.on(SOCKET_NAMESPACE.roundResultEvent, handleRoundResult);
    socket.on(SOCKET_NAMESPACE.matchFinishedEvent, handleMatchFinished);

    return () => {
      socket.off(SOCKET_NAMESPACE.roundResultEvent, handleRoundResult);
      socket.off(SOCKET_NAMESPACE.matchFinishedEvent, handleMatchFinished);
    };
  }, [socket, matchId, applySnapshot]);

  // ── Round-arm-start socket events ───────────────────────────────────────
  // When the server-side transition flips from `arming` to `active`, the
  // server emits `roundArmStartEvent` carrying the live match. This removes
  // the polling lag for the input form to appear after the pre-round delay.
  // Polling is still the canonical source of truth; the socket event just
  // makes the UI feel responsive.
  useEffect(() => {
    if (!socket || !matchId) return;

    const handleRoundArmStart = (payload: any) => {
      if (payload?.matchId !== matchId) return;
      if (payload?.match) applySnapshot(payload.match as PrecisionState);
    };

    socket.on(SOCKET_NAMESPACE.roundArmStartEvent, handleRoundArmStart);

    return () => {
      socket.off(SOCKET_NAMESPACE.roundArmStartEvent, handleRoundArmStart);
    };
  }, [socket, matchId, applySnapshot]);

  return { state, stateRef, serverClockOffsetMs, lookup, applySnapshot, refreshState };
}
