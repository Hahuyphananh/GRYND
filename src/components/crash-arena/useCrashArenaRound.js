"use client";
import { useReducer, useCallback, useRef, useMemo, useEffect, useState } from "react";
import {
  createRoundState,
  startRound,
  playerCashout,
  crashRound,
  settleRound,
  nextRound,
} from "../../lib/crash-arena/roundSystem";
import { useSocket } from "../../context/SocketProvider";
import {
  crashArenaMatchRoom,
  CRASH_ARENA_TABLE_UPDATED,
  CRASH_ARENA_READY,
} from "../../lib/crash-arena/rooms";

/**
 * Apply server-side round entries onto the local roster. Used when
 * reconciling a round that finished on the server (another player
 * settled it) so remote cashouts / busts show up for everyone.
 * Local state is preserved — a player who already cashed out locally
 * is never overwritten.
 */
function applyServerEntries(state, entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) return state;
  let changed = false;
  const players = state.players.map((p) => {
    if (p.userId == null) return p;
    const entry = entries.find((e) => e.userId === p.userId);
    if (!entry) return p;
    if (
      entry.result === "won" &&
      entry.cashoutMultiplier != null &&
      p.cashoutMultiplier === null &&
      !p.busted
    ) {
      changed = true;
      return { ...p, cashoutMultiplier: Number(entry.cashoutMultiplier) };
    }
    if (
      (entry.result === "lost" || entry.result === "pending") &&
      p.cashoutMultiplier === null &&
      !p.busted &&
      p.isPlaying &&
      !p.isSittingOut
    ) {
      changed = true;
      return { ...p, busted: true };
    }
    return p;
  });
  return changed ? { ...state, players } : state;
}

/**
 * useCrashArenaRound — hook managing the Crash Arena round lifecycle.
 *
 * Connects to CrashEngine by providing crashPoint/running and handling
 * cashout/crash callbacks. Calls real backend APIs for all operations,
 * and keeps the table in sync over the realtime socket:
 *
 *   • Joins the per-table socket room (`crash-arena:match:${tableId}`).
 *   • After successful API mutations it emits `crashArena:updated` so
 *     the other players at the table reconcile instantly.
 *   • On incoming `lobby:updated` events it reconciles round state
 *     (round start, remote cashouts, ready votes) and calls
 *     `onRoomUpdate` so the page re-fetches the table roster.
 *
 * Round-start model (all players synced):
 *   • First round: seated players press "Start Round" (a ready vote).
 *     When 2+ distinct players are ready the countdown begins, and on
 *     expiry `startNewRound()` fires — the button itself never triggers
 *     the rocket directly.
 *   • Later rounds: no button — the auto-start countdown just runs.
 *
 * Params:
 *   tableId     — database ID of the crash_arena_table
 *   wager       — round wager amount
 *   roundNumber — starting round number
 *   onRoomUpdate — () => void — called when the socket signals a table
 *                  change so the page can re-fetch the roster.
 *
 * Returns:
 *   roundState, crashEngineRef, crashEngineProps
 *   readyVotes, markReady()
 *   startNewRound(), goToNextRound()
 *   joinTable(amount), leaveTable(), exitTable(), buyChips(name, amount)
 *   syncPlayers(), syncWaitingPlayers(), syncRoundFromServer(roundInfo)
 *   applyRemoteCashout(userId, multiplier)
 *   busy, error
 */
export default function useCrashArenaRound({
  tableId,
  wager = 10,
  roundNumber = 1,
  onRoomUpdate,
}) {
  const { socket } = useSocket();
  const crashEngineRef = useRef(null);
  const currentRoundIdRef = useRef(null);
  // Id + status of the most recent round reconciled from the server
  // (poll or socket) — guards against re-applying the same round on
  // every refetch while still allowing a status flip (running → settled)
  // to re-reconcile.
  const lastSyncedRef = useRef(null);
  // Live mirror of roundState so stable callbacks (cashout/crash) can
  // read the current roster without stale closures.
  const roundStateRef = useRef(null);
  const onRoomUpdateRef = useRef(onRoomUpdate);
  onRoomUpdateRef.current = onRoomUpdate;

  const [busy, setBusy] = useReducer((_, v) => v, false);
  const [error, setError] = useReducer((_, v) => v, null);
  // User ids of seated players who pressed "Start Round" for the first
  // round. Shared across clients via socket broadcasts.
  const [readyVotes, setReadyVotes] = useState([]);

  // ── Reducer ──────────────────────────────────────────────────────────

  const [roundState, dispatch] = useReducer((state, action) => {
    switch (action.type) {
      case "START_ROUND": {
        const crashPoint = action.crashPoint;
        if (crashPoint == null || !Number.isFinite(crashPoint) || crashPoint < 1) {
          return state; // guard
        }
        const seedHash = action.seedHash ?? null;
        return startRound(state, wager, crashPoint, seedHash);
      }
      case "CASHOUT":
        return playerCashout(state, action.playerName, action.multiplier);
      case "REMOTE_CASHOUT": {
        // Cashout broadcast from another player at the table.
        if (state.phase !== "running") return state;
        const { userId, multiplier } = action;
        if (userId == null || !Number.isFinite(Number(multiplier))) return state;
        return {
          ...state,
          players: state.players.map((p) =>
            p.userId === userId && p.cashoutMultiplier === null && !p.busted
              ? { ...p, cashoutMultiplier: Number(multiplier) }
              : p,
          ),
        };
      }
      case "CRASH":
        return settleRound(crashRound(state, action.multiplier));
      case "SYNC_ROUND": {
        // Reconcile the server's latest round into local state. Covers
        // the cases where another player started / settled the round and
        // this client missed the live event (late join, socket drop).
        const sr = action.round;
        if (!sr || !sr.id) return state;

        let next = state;
        const cp = Number(sr.crashPoint);
        const hasValidCp = Number.isFinite(cp) && cp >= 1;
        const fallbackCp = hasValidCp ? cp : 2.0;

        if (sr.status === "running" && hasValidCp) {
          if (next.phase === "waiting") {
            next = startRound(next, action.wager, cp, sr.seedHash ?? null, null);
          }
        }

        if (sr.status === "settled" || sr.status === "crashed") {
          if (next.phase !== "settling") {
            if (next.phase === "waiting") {
              next = startRound(next, action.wager, fallbackCp, sr.seedHash ?? null, null);
            }
            if (next.phase === "running") {
              // Apply server-side cashouts FIRST so players who cashed
              // out (but whose broadcast this client missed) are not
              // busted by the crash pass below.
              next = applyServerEntries(next, sr.entries);
              next = crashRound(next, fallbackCp);
            }
            if (next.phase === "crashed") {
              next = settleRound(next);
            }
          }
        }

        return next;
      }
      case "NEXT_ROUND":
        return nextRound(state);
      case "SET_PLAYERS":
        return { ...state, players: action.players };
      case "SYNC_PLAYERS": {
        // Merge the server's seated roster into the local player list.
        // Local round state (cashout/busted/sit-out) is preserved; in the
        // waiting phase the roster mirrors the server exactly.
        const serverPlayers = action.serverPlayers || [];
        const localPlayers = state.players;
        const inLiveRound = state.phase !== "waiting";

        const serverByName = new Map();
        for (const sp of serverPlayers) serverByName.set(sp.name, sp);

        const mergedByName = new Map();
        for (const lp of localPlayers) mergedByName.set(lp.name, lp);

        // NOTE: players are keyed by display name (pre-existing roundSystem
        // design) — duplicate display names at one table would collapse.

        // Drop local players who are no longer seated (unless mid-round,
        // where we keep the roster stable so cashouts/busts stay visible).
        if (!inLiveRound) {
          for (const name of [...mergedByName.keys()]) {
            if (!serverByName.has(name)) mergedByName.delete(name);
          }
        }

        for (const sp of serverByName.values()) {
          const lp = mergedByName.get(sp.name);
          if (lp) {
            // Preserve local round state; refresh balance for remote players
            // only ("You"'s balance is tracked locally during rounds).
            mergedByName.set(sp.name, {
              ...lp,
              isYou: lp.isYou || Boolean(sp.isYou),
              userId: lp.userId ?? sp.userId ?? null,
              balance: lp.isYou ? lp.balance : Number(sp.balance),
            });
          } else {
            // A player first seen mid-round is seated but was not locked
            // into the running round — keep them out until the next round.
            mergedByName.set(sp.name, {
              name: sp.name,
              userId: sp.userId ?? null,
              balance: Number(sp.balance),
              isYou: Boolean(sp.isYou),
              isSittingOut: false,
              isPlaying: !inLiveRound,
              cashoutMultiplier: null,
              busted: false,
            });
          }
        }

        return { ...state, players: [...mergedByName.values()] };
      }
      case "SYNC_WAITING_PLAYERS":
        return { ...state, waitingPlayers: action.waitingPlayers || [] };
      case "BUY_CHIPS":
        return {
          ...state,
          players: state.players.map((p) =>
            p.name === action.playerName
              ? { ...p, balance: p.balance + action.amount }
              : p,
          ),
        };
      default:
        return state;
    }
  }, null, () => ({
    ...createRoundState([], roundNumber),
    waitingPlayers: [],
  }));

  // Keep a live mirror of roundState for stable callbacks.
  roundStateRef.current = roundState;

  // Prune ready votes that belong to players who are no longer seated.
  useEffect(() => {
    const seatedIds = new Set(
      (roundState.players || [])
        .map((p) => p.userId)
        .filter((id) => id != null),
    );
    setReadyVotes((prev) => {
      const kept = prev.filter((id) => seatedIds.has(id));
      return kept.length === prev.length ? prev : kept;
    });
  }, [roundState.players]);

  // ── First-round ready votes ──────────────────────────────────────────

  const markReady = useCallback(() => {
    const me = (roundStateRef.current?.players || []).find((p) => p.isYou);
    if (!me?.userId) return;
    setReadyVotes((prev) =>
      prev.includes(me.userId) ? prev : [...prev, me.userId],
    );
    if (socket) {
      socket.emit(CRASH_ARENA_READY, {
        tableId,
        ready: true,
        readyUserId: me.userId,
      });
    }
  }, [tableId, socket]);

  // ── Crash callbacks ──────────────────────────────────────────────────

  const handleCashout = useCallback((multiplier) => {
    dispatch({ type: "CASHOUT", playerName: "You", multiplier });
    // Fire-and-forget API call — server validates against real crashPoint
    const roundId = currentRoundIdRef.current;
    if (roundId) {
      fetch("/api/crash-arena/cashout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ roundId, cashoutMultiplier: multiplier }),
      })
        .catch((err) => console.warn("[crash-arena] cashout API failed:", err));
    }
    // Tell the rest of the table instantly (needs "You"'s internal id
    // from the synced roster so remote players can match the seat).
    const me = (roundStateRef.current?.players || []).find((p) => p.isYou);
    if (me?.userId && socket) {
      socket.emit(CRASH_ARENA_READY, {
        tableId,
        cashout: { userId: me.userId, multiplier },
      });
    }
  }, [tableId, socket]);

  const handleCrash = useCallback((multiplier) => {
    dispatch({ type: "CRASH", multiplier });
    // Fire-and-forget settle call
    const roundId = currentRoundIdRef.current;
    if (roundId) {
      fetch("/api/crash-arena/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ roundId }),
      })
        .catch((err) => console.warn("[crash-arena] settle API failed:", err));
    }
    // Notify the room so everyone reconciles the crash instantly.
    if (socket) {
      socket.emit(CRASH_ARENA_READY, { tableId, crashed: true, multiplier });
    }
  }, [tableId, socket]);

  const handleMultiplierUpdate = useCallback(() => {
    // CrashEngine handles display internally
  }, []);

  // ── Round control ────────────────────────────────────────────────────

  const startNewRound = useCallback(async () => {
    if (!tableId) return;
    // Only the first client whose countdown expires should create the
    // round — once anyone starts it, everyone else syncs via broadcast.
    if (roundStateRef.current?.phase !== "waiting") return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/crash-arena/start-round", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tableId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        // A concurrent start (another player's timer) is expected — ignore.
        if (!/already in progress/i.test(data?.error || "")) {
          setError(data?.error || "Failed to start round");
        }
        return;
      }
      const { roundId, crashPoint, seedHash } = data.data;
      currentRoundIdRef.current = roundId;
      lastSyncedRef.current = { id: String(roundId), status: "running" };
      setReadyVotes([]);
      dispatch({ type: "START_ROUND", crashPoint, seedHash });
      // Broadcast so the other players' CrashEngines start in sync.
      if (socket) {
        socket.emit(CRASH_ARENA_READY, {
          tableId,
          roundStarted: true,
          roundId,
          crashPoint,
          seedHash,
        });
      }
    } catch (err) {
      setError("Network error starting round");
    } finally {
      setBusy(false);
    }
  }, [tableId, socket]);

  const goToNextRound = useCallback(() => {
    dispatch({ type: "NEXT_ROUND" });
    currentRoundIdRef.current = null;
    setReadyVotes([]);
  }, []);

  // ── Round reconciliation (from poll or socket) ──────────────────────

  /**
   * Reconcile the server's latest round into local round state.
   * Safe to call on every tables fetch: rounds already processed are
   * skipped, and finished rounds are only auto-applied when they ended
   * recently (so a page reload doesn't resurrect stale results).
   */
  const syncRoundFromServer = useCallback((roundInfo) => {
    if (!roundInfo?.id) return;
    const roundId = String(roundInfo.id);
    const roundStatus = roundInfo.status;

    // Skip only when this exact round AND status were already
    // reconciled — a status flip (running → settled) must re-reconcile
    // so a client that missed the crash (throttled tab, socket blip)
    // doesn't stay stuck in "running" forever.
    const last = lastSyncedRef.current;
    if (last && last.id === roundId && last.status === roundStatus) return;

    const isActive = roundStatus === "running";
    let recent = true;
    if (roundInfo.createdAt) {
      const created = new Date(roundInfo.createdAt).getTime();
      if (Number.isFinite(created)) {
        recent = Date.now() - created < 90_000; // 90s window for finished rounds
      }
    }
    if (!isActive && !recent) return;

    lastSyncedRef.current = { id: roundId, status: roundStatus };
    // A running round is the one cashouts / settle must target.
    if (isActive) currentRoundIdRef.current = roundId;
    dispatch({ type: "SYNC_ROUND", round: roundInfo, wager });
  }, [wager]);

  /**
   * Apply a cashout broadcast from another player at the table.
   */
  const applyRemoteCashout = useCallback((userId, multiplier) => {
    if (userId == null) return;
    dispatch({ type: "REMOTE_CASHOUT", userId, multiplier });
  }, []);

  // ── Realtime room wiring ─────────────────────────────────────────────

  useEffect(() => {
    if (!tableId || !socket) return;
    const roomId = crashArenaMatchRoom(tableId);

    // (Re)join the per-table room. The server arms a disconnect grace
    // timer whenever our socket drops, and only re-joining cancels it —
    // so we must re-emit join_room on EVERY socket (re)connection,
    // including Socket.IO auto-reconnects after a network blip.
    // Otherwise a page refresh / reconnect would quietly release the
    // seat (and refund the balance) once the grace window expires.
    const joinRoom = () => socket.emit("join_room", { roomId });
    joinRoom();

    const onUpdate = (payload = {}) => {
      // Another player started a round — start ours with the same
      // server-authoritative crash point immediately.
      if (payload?.roundStarted && payload?.crashPoint != null) {
        syncRoundFromServer({
          id: payload.roundId,
          status: "running",
          crashPoint: Number(payload.crashPoint),
          seedHash: payload.seedHash ?? null,
        });
      }
      // Another player cashed out — show it in the live standings.
      if (payload?.cashout?.userId) {
        applyRemoteCashout(payload.cashout.userId, payload.cashout.multiplier);
      }
      // A seated player pressed "Start Round" (first-round ready vote).
      if (payload?.ready && payload?.readyUserId) {
        setReadyVotes((prev) =>
          prev.includes(payload.readyUserId)
            ? prev
            : [...prev, payload.readyUserId],
        );
      }
      // Anything else (joined/left/crashed/settled) → let the page
      // re-fetch the roster + latest round.
      onRoomUpdateRef.current?.();
    };

    socket.on(CRASH_ARENA_TABLE_UPDATED, onUpdate);
    socket.on("connect", joinRoom);

    return () => {
      socket.off(CRASH_ARENA_TABLE_UPDATED, onUpdate);
      socket.off("connect", joinRoom);
      socket.emit("leave_room", { roomId });
    };
  }, [tableId, socket, syncRoundFromServer, applyRemoteCashout]);

  // ── Player management (API calls) ────────────────────────────────────

  const joinTable = useCallback(async (buyIn) => {
    if (!tableId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/crash-arena/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tableId, buyInAmount: buyIn }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data?.error || "Failed to join table");
        return;
      }
      const me = {
        name: "You",
        balance: buyIn,
        isYou: true,
        isSittingOut: false,
        isPlaying: true,
        cashoutMultiplier: null,
        busted: false,
      };
      if (data.data?.status === "waiting") {
        // Joined mid-round — land on the wait list until this round ends.
        dispatch({
          type: "SYNC_WAITING_PLAYERS",
          waitingPlayers: [
            ...(roundState.waitingPlayers || []).filter((p) => !p.isYou),
            me,
          ],
        });
      } else {
        // Add/replace "You" in the local player list (roster may already
        // contain a synced copy of the seat).
        dispatch({
          type: "SET_PLAYERS",
          players: [
            ...roundState.players.filter((p) => p.name !== "You"),
            me,
          ],
        });
      }
      if (socket) socket.emit(CRASH_ARENA_READY, { tableId, joined: true });
    } catch (err) {
      setError("Network error joining table");
    } finally {
      setBusy(false);
    }
  }, [tableId, roundState.players, roundState.waitingPlayers, socket]);

  /**
   * "Leave" — step off the table onto the wait list (balance stays at the
   * table so the player can come back next round or cash out later).
   */
  const leaveTable = useCallback(async () => {
    if (!tableId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/crash-arena/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tableId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data?.error || "Failed to leave table");
        return;
      }
      const me = (roundStateRef.current?.players || []).find((p) => p.isYou);
      dispatch({
        type: "SET_PLAYERS",
        players: roundState.players.filter((p) => !p.isYou),
      });
      dispatch({
        type: "SYNC_WAITING_PLAYERS",
        waitingPlayers: me
          ? [...(roundState.waitingPlayers || []), { ...me, isSittingOut: false, cashoutMultiplier: null, busted: false }]
          : roundState.waitingPlayers || [],
      });
      if (socket) socket.emit(CRASH_ARENA_READY, { tableId, left: true });
    } catch (err) {
      setError("Network error leaving table");
    } finally {
      setBusy(false);
    }
  }, [tableId, roundState.players, roundState.waitingPlayers, socket]);

  /**
   * "Back to Lobby" — permanently leave: refund remaining balance to the
   * wallet and mark the player as left.
   */
  const exitTable = useCallback(async () => {
    if (!tableId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/crash-arena/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tableId, permanent: true }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data?.error || "Failed to leave table");
        return;
      }
      dispatch({
        type: "SET_PLAYERS",
        players: roundState.players.filter((p) => !p.isYou),
      });
      dispatch({
        type: "SYNC_WAITING_PLAYERS",
        waitingPlayers: (roundState.waitingPlayers || []).filter((p) => !p.isYou),
      });
      if (socket) socket.emit(CRASH_ARENA_READY, { tableId, left: true });
    } catch (err) {
      setError("Network error leaving table");
    } finally {
      setBusy(false);
    }
  }, [tableId, roundState.players, roundState.waitingPlayers, socket]);

  const buyChips = useCallback((playerName, amount) => {
    // TODO: Add API endpoint for buying more chips at table
    dispatch({ type: "BUY_CHIPS", playerName, amount });
  }, []);

  /**
   * Sync the server's seated roster into the local player list.
   * Used after joining from the lobby, on room load, and on periodic refresh
   * so the room shows every seated player, not just locally-known ones.
   */
  const syncPlayers = useCallback((serverPlayers) => {
    dispatch({ type: "SYNC_PLAYERS", serverPlayers });
  }, []);

  /**
   * Sync the server's wait-list roster into local state.
   */
  const syncWaitingPlayers = useCallback((serverWaiting) => {
    dispatch({ type: "SYNC_WAITING_PLAYERS", waitingPlayers: serverWaiting });
  }, []);

  // ── CrashEngine props ────────────────────────────────────────────────

  const crashEngineProps = useMemo(() => ({
    crashPoint: roundState.crashPoint || 2.0,
    running: roundState.phase === "running",
    onCashout: handleCashout,
    onCrash: handleCrash,
    onMultiplierUpdate: handleMultiplierUpdate,
  }), [roundState.crashPoint, roundState.phase, handleCashout, handleCrash, handleMultiplierUpdate]);

  return {
    roundState,
    crashEngineRef,
    crashEngineProps,
    readyVotes,
    markReady,
    startNewRound,
    goToNextRound,
    playerCashout: handleCashout,
    syncPlayers,
    syncWaitingPlayers,
    syncRoundFromServer,
    applyRemoteCashout,
    joinTable,
    leaveTable,
    exitTable,
    buyChips,
    busy,
    error,
  };
}
