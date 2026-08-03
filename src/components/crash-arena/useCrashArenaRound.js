"use client";
import { useReducer, useCallback, useRef, useMemo } from "react";
import {
  createRoundState,
  startRound,
  playerCashout,
  crashRound,
  settleRound,
  nextRound,
  toggleSitOut,
} from "../../lib/crash-arena/roundSystem";

/**
 * useCrashArenaRound — hook managing the Crash Arena round lifecycle.
 *
 * Connects to CrashEngine by providing crashPoint/running and handling
 * cashout/crash callbacks. Calls real backend APIs for all operations.
 *
 * Params:
 *   tableId    — database ID of the crash_arena_table
 *   wager      — round wager amount
 *   roundNumber — starting round number
 *
 * Returns:
 *   roundState       — { phase, pot, crashPoint, players, results, seedHash }
 *   crashEngineRef   — ref to pass to CrashEngine
 *   crashEngineProps  — { crashPoint, running, onCashout, onCrash, onMultiplierUpdate }
 *   startNewRound()  — calls POST /api/crash-arena/start-round
 *   goToNextRound()  — proceed to next round after settling
 *   togglePlayerSitOut(name)
 *   joinTable(amount)  — calls POST /api/crash-arena/join
 *   leaveTable()       — calls POST /api/crash-arena/leave
 *   buyChips(amount)   — (future: add API)
 *   busy              — whether an API call is in flight
 *   error             — last error message
 */
export default function useCrashArenaRound({
  tableId,
  wager = 10,
  roundNumber = 1,
}) {
  const crashEngineRef = useRef(null);
  const currentRoundIdRef = useRef(null);
  const [busy, setBusy] = useReducer((_, v) => v, false);
  const [error, setError] = useReducer((_, v) => v, null);

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
      case "CRASH":
        return settleRound(crashRound(state, action.multiplier));
      case "NEXT_ROUND":
        return nextRound(state);
      case "TOGGLE_SIT_OUT":
        return toggleSitOut(state, action.playerName);
      case "SET_PLAYERS":
        return { ...state, players: action.players };
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
  }, { players: [], wager, roundNumber }, () =>
    createRoundState([], roundNumber),
  );

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
      }).catch((err) => console.warn("[crash-arena] cashout API failed:", err));
    }
  }, []);

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
      }).catch((err) => console.warn("[crash-arena] settle API failed:", err));
    }
  }, []);

  const handleMultiplierUpdate = useCallback(() => {
    // CrashEngine handles display internally
  }, []);

  // ── Round control ────────────────────────────────────────────────────

  const startNewRound = useCallback(async () => {
    if (!tableId) return;
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
        setError(data?.error || "Failed to start round");
        return;
      }
      const { roundId, crashPoint, seedHash } = data.data;
      currentRoundIdRef.current = roundId;
      dispatch({ type: "START_ROUND", crashPoint, seedHash });
    } catch (err) {
      setError("Network error starting round");
    } finally {
      setBusy(false);
    }
  }, [tableId]);

  const goToNextRound = useCallback(() => {
    dispatch({ type: "NEXT_ROUND" });
    currentRoundIdRef.current = null;
  }, []);

  const togglePlayerSitOut = useCallback((playerName) => {
    dispatch({ type: "TOGGLE_SIT_OUT", playerName });
  }, []);

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
      // Add "You" to local player list
      dispatch({
        type: "SET_PLAYERS",
        players: [
          ...roundState.players,
          {
            name: "You",
            balance: buyIn,
            isYou: true,
            isSittingOut: false,
            isPlaying: true,
            cashoutMultiplier: null,
            busted: false,
          },
        ],
      });
    } catch (err) {
      setError("Network error joining table");
    } finally {
      setBusy(false);
    }
  }, [tableId, roundState.players]);

  const leaveTable = useCallback(async () => {
    if (!tableId) return;
    setBusy(true);
    setError(null);
    try {
      await fetch("/api/crash-arena/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tableId }),
      });
      dispatch({
        type: "SET_PLAYERS",
        players: roundState.players.filter((p) => !p.isYou),
      });
    } catch (err) {
      setError("Network error leaving table");
    } finally {
      setBusy(false);
    }
  }, [tableId, roundState.players]);

  const buyChips = useCallback((playerName, amount) => {
    // TODO: Add API endpoint for buying more chips at table
    dispatch({ type: "BUY_CHIPS", playerName, amount });
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
    startNewRound,
    goToNextRound,
    togglePlayerSitOut,
    playerCashout: handleCashout,
    joinTable,
    leaveTable,
    buyChips,
    busy,
    error,
  };
}
