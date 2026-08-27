"use client";
import React, { useState, useMemo, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { IconBook, IconRocket } from "@tabler/icons-react";
import TableList from "./TableList";
import WagerSection from "./WagerSection";
import BuyInModal from "./BuyInModal";
import CrashArenaRulesModal from "./CrashArenaRulesModal";
import { CRASH_MIN_WAGER, CRASH_MIN_BUYIN_MULTIPLIER } from "../../lib/games/crash/constants";
import { CRASH_AI_DIFFICULTIES } from "../../lib/crash-arena/botStrategy";
import { useSocket } from "../../context/SocketProvider";
import {
  CRASH_ARENA_LOBBY_ROOM,
  CRASH_ARENA_TABLE_UPDATED,
} from "../../lib/crash-arena/rooms";

/**
 * ArenaLobby — the main Crash Arena lobby.
 *
 * Players input a custom wager to create a table, then browse and
 * join open tables. AI practice tables are private and hidden from
 * the public grid.
 *
 * Props:
 *   tables      — array of table objects from API
 *   userBalance — player's wallet balance (null = loading)
 *   loading     — whether data is still loading
 *   isSignedIn  — whether the user is authenticated
 *   onRefresh   — () => void — re-fetch lobby data (after errors)
 */
export default function ArenaLobby({
  tables = [],
  userBalance = null,
  loading = false,
  isSignedIn = false,
  onRefresh,
  onPlayAI,
  aiWager = null,
  aiError = null,
}) {
  const router = useRouter();
  const { socket } = useSocket();

  // ── Custom wager for creating a table ───────────────────────────────
  const [wager, setWager] = useState(1);
  // ── Custom wager for AI practice ────────────────────────────────────
  const [aiWagerInput, setAiWagerInput] = useState(1);

  const [creating, setCreating] = useState(false);
  const [joinTarget, setJoinTarget] = useState(null); // table awaiting buy-in (join)
  const [createTarget, setCreateTarget] = useState(null); // freshly created table awaiting buy-in
  const [busyTableId, setBusyTableId] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [showRules, setShowRules] = useState(false);
  // AI practice difficulty (easy/medium/hard)
  const [aiDifficulty, setAiDifficulty] = useState("medium");

  // AI practice tables are private — never show in the public grid
  const availableTables = useMemo(
    () => tables.filter((t) => !t.isAi),
    [tables],
  );

  const fail = useCallback((msg) => {
    setActionError(msg);
    onRefresh?.();
  }, [onRefresh]);

  // ── Realtime lobby refresh ──────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;
    const refresh = () => onRefresh?.();
    socket.emit("join_room", { roomId: CRASH_ARENA_LOBBY_ROOM });
    socket.on(CRASH_ARENA_TABLE_UPDATED, refresh);
    return () => {
      socket.off(CRASH_ARENA_TABLE_UPDATED, refresh);
      socket.emit("leave_room", { roomId: CRASH_ARENA_LOBBY_ROOM });
    };
  }, [socket, onRefresh]);

  const emitLobbyUpdate = useCallback((payload) => {
    if (!socket) return;
    socket.emit("room_event", {
      roomId: CRASH_ARENA_LOBBY_ROOM,
      event: CRASH_ARENA_TABLE_UPDATED,
      payload: payload || {},
    });
  }, [socket]);

  // ── Play vs AI ──────────────────────────────────────────────────────
  const handlePlayAi = useCallback(() => {
    onPlayAI?.(aiWagerInput, aiDifficulty);
  }, [onPlayAI, aiWagerInput, aiDifficulty]);

  // ── Create a brand-new table with custom wager ──────────────────────
  const handleCreate = useCallback(async (wagerAmount) => {
    setActionError(null);
    if (!isSignedIn) {
      setActionError("Please sign in to create a table.");
      return;
    }
    if (!Number.isFinite(wagerAmount) || wagerAmount < CRASH_MIN_WAGER) {
      setActionError(`Minimum wager is $${CRASH_MIN_WAGER}`);
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/crash-arena/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ wager: wagerAmount }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Unable to create table");
      }
      emitLobbyUpdate({ created: true, wager: wagerAmount });
      // Don't navigate yet — open the buy-in modal so the creator places
      // their buy-in (poker-style) before entering the table.
      setCreateTarget({
        id: data.data.tableId,
        wager: data.data.wager,
        minBuyIn: data.data.minBuyIn,
      });
    } catch (err) {
      fail(err.message || "Unable to create table");
    } finally {
      setCreating(false);
    }
  }, [isSignedIn, fail, emitLobbyUpdate]);

  // ── Open the buy-in modal for a table ───────────────────────────────
  const handleJoin = useCallback((table) => {
    setActionError(null);
    if (!isSignedIn) {
      setActionError("Please sign in to join a table.");
      return;
    }
    setJoinTarget(table);
  }, [isSignedIn]);

  // ── Complete the buy-in with the chosen amount ──────────────────────
  // Works for both paths: joining an existing table (joinTarget) and
  // buying in to a freshly created table (createTarget). Both seat the
  // player via /api/crash-arena/join.
  const handleBuyIn = useCallback(async (amount) => {
    const table = createTarget || joinTarget;
    const fromCreate = Boolean(createTarget);
    setCreateTarget(null);
    setJoinTarget(null);
    if (!table) return;

    setBusyTableId(table.id);
    setActionError(null);
    try {
      const res = await fetch("/api/crash-arena/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tableId: table.id, buyInAmount: amount }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Unable to join table");
      }
      if (fromCreate) {
        emitLobbyUpdate({ created: true, tableId: table.id });
      } else {
        emitLobbyUpdate({ joined: true, tableId: table.id });
      }
      router.push(`/casino/crash-arena/table/${table.id}`);
    } catch (err) {
      setBusyTableId(null);
      fail(err.message || "Unable to join table");
    }
  }, [createTarget, joinTarget, router, fail, emitLobbyUpdate]);

  return (
    <div className="relative w-full">
      {/* Header */}
      <div className="mb-6 text-center">
        <h1 className="text-3xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-amber-300 via-amber-400 to-yellow-500 drop-shadow-[0_0_18px_rgba(251,191,36,0.5)] sm:text-4xl">
          <IconRocket size={30} className="mb-1.5 mr-2 inline" /> Crash Arena
        </h1>
        <p className="mt-2 text-sm text-white/60">
          Set your wager, take a seat, and bet blinds against the crash curve.
          Last player standing takes the pot.
        </p>
        {/* Rules popup button */}
        <button
          onClick={() => setShowRules(true)}
          className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 hover:scale-105 transition-all duration-300 shadow-[0_0_14px_rgba(251,191,36,0.15)]"
        >
          <IconBook size={15} /> How to Play
        </button>
      </div>

      {/* Balance bar */}
      <div className="mb-6 flex items-center justify-center gap-3 px-4 py-3 rounded-2xl border border-amber-700/60 bg-black/40 backdrop-blur-sm max-w-sm mx-auto">
        <span className="text-white/55 text-sm">Your Balance</span>
        <span className="text-xl font-black text-yellow-300 drop-shadow-[0_0_10px_rgba(251,191,36,0.5)]">
          {loading && userBalance === null
            ? "..."
            : `$${(userBalance ?? 0).toLocaleString()}`}
        </span>
      </div>

      {/* Action error banner */}
      {(actionError || aiError) && (
        <div className="mb-4 mx-auto max-w-xl px-4 py-2.5 rounded-xl bg-red-900/30 border border-red-400/40 text-red-300 text-sm text-center">
          {actionError || aiError}
        </div>
      )}

      {/* ═══ Create Table section ═══ */}
      <div className="mb-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Create Table with custom wager */}
        <WagerSection
          wager={wager}
          setWager={setWager}
          isSignedIn={isSignedIn}
          creating={creating}
          onCreate={handleCreate}
          userBalance={userBalance}
        />

        {/* Play vs AI */}
        <div className="flex flex-col overflow-hidden rounded-2xl border border-[#00e5ff]/25 bg-black/40 transition-all duration-300 hover:border-[#00e5ff]/40 hover:shadow-[0_0_30px_rgba(0,229,255,0.15)]">
          <div className="relative p-5 flex flex-col gap-3">
            {/* Top accent line */}
            <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent opacity-70" />

            {/* Header */}
            <div>
              <span className="text-xs uppercase tracking-widest text-[#9dd8ff]/60">
                🤖 AI Practice
              </span>
              <div className="text-sm font-bold text-white/90 mt-0.5">
                Free play against the GRYND AI
              </div>
            </div>

            {/* AI wager input */}
            <div>
              <label className="text-xs text-white/55 uppercase tracking-wider">Practice Wager</label>
              <div className="flex items-center mt-1 bg-[#020617] border border-[#00e5ff]/40 rounded-xl overflow-hidden focus-within:border-[#00e5ff] focus-within:shadow-[0_0_15px_rgba(0,229,255,0.25)] transition-all">
                <span className="pl-4 text-[#00e5ff] font-bold text-lg">$</span>
                <input
                  type="number"
                  value={aiWagerInput}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === "" || val === "0") {
                      setAiWagerInput(val);
                    } else {
                      setAiWagerInput(Math.max(CRASH_MIN_WAGER, parseFloat(val) || CRASH_MIN_WAGER));
                    }
                  }}
                  min={CRASH_MIN_WAGER}
                  step="0.01"
                  className="flex-1 bg-transparent px-2 py-3 text-white text-lg font-bold outline-none text-center"
                  placeholder={`${CRASH_MIN_WAGER}`}
                />
              </div>
            </div>

            {/* Quick presets for AI wager */}
            <div className="flex flex-wrap gap-2 justify-center">
              {[1, 5, 10, 25].map((val) => (
                <button
                  key={val}
                  onClick={() => setAiWagerInput(val)}
                  className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all duration-150
                    ${Number(aiWagerInput) === val
                      ? "bg-[#00e5ff] text-black border-[#00e5ff] shadow-[0_0_10px_rgba(0,229,255,0.5)]"
                      : "bg-slate-900/80 text-[#9dd8ff]/80 border-[#00e5ff]/30 hover:bg-[#00e5ff]/15 hover:border-[#00e5ff]/50"
                    }`}
                >
                  ${val}
                </button>
              ))}
            </div>

            {/* Difficulty picker */}
            <div>
              <label className="text-xs text-white/55 uppercase tracking-wider mb-1 block">Difficulty</label>
              <div className="flex gap-1.5">
                {CRASH_AI_DIFFICULTIES.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setAiDifficulty(d)}
                    className={`flex-1 rounded-full border px-3 py-1.5 text-xs font-bold capitalize transition-all duration-200 ${
                      aiDifficulty === d
                        ? "border-[#00e5ff] bg-[#00e5ff]/20 text-[#00e5ff] shadow-[0_0_10px_rgba(0,229,255,0.35)]"
                        : "border-gray-600/50 bg-gray-800/40 text-gray-400 hover:border-[#00e5ff]/60 hover:text-[#00e5ff]/80"
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>

            <p className="text-[10px] text-[#9dd8ff]/50 leading-tight">
              Easy bots fold to pressure · Hard bots raise and call relentlessly.
              Free play — no real tokens.
            </p>

            {/* Play vs AI button */}
            <button
              onClick={handlePlayAi}
              disabled={!isSignedIn || aiWager != null || !Number.isFinite(Number(aiWagerInput)) || Number(aiWagerInput) < CRASH_MIN_WAGER}
              className={`mt-1 w-full py-2.5 rounded-xl font-bold text-sm text-center transition-all duration-300
                bg-gradient-to-r from-[#00e5ff] to-[#007cf0] text-white border border-[#00e5ff]
                hover:brightness-110 hover:scale-[1.02] hover:shadow-[0_0_20px_rgba(0,229,255,0.4)]
                disabled:opacity-60 disabled:hover:scale-100`}
            >
              {aiWager != null ? "Starting…" : "🤖 Play vs AI"}
              {" "}
              <span className="ml-1 rounded-full bg-black/25 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide capitalize">
                {aiDifficulty}
              </span>
              <span className="ml-1 rounded-full bg-black/25 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide">
                Free
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* ═══ Available Games ═══ */}
      {loading && availableTables.length === 0 ? (
        <div className="flex items-center justify-center py-16">
          <span className="inline-block w-10 h-10 border-3 border-amber-400 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <TableList
          tables={availableTables}
          isSignedIn={isSignedIn}
          busyTableId={busyTableId}
          onJoin={handleJoin}
        />
      )}

      {/* Buy-in modal for a freshly created table (creator places their
          buy-in before entering the table) */}
      {createTarget && (
        <BuyInModal
          table={{ wager: createTarget.wager, minBuyIn: createTarget.minBuyIn }}
          maxBalance={userBalance}
          onBuyIn={handleBuyIn}
          onClose={() => setCreateTarget(null)}
        />
      )}

      {/* Buy-in modal for joining from the available games list */}
      {joinTarget && (
        <BuyInModal
          table={{ wager: joinTarget.wager, minBuyIn: joinTarget.minBuyIn }}
          maxBalance={userBalance}
          onBuyIn={handleBuyIn}
          onClose={() => setJoinTarget(null)}
        />
      )}

      {/* Rules popup */}
      {showRules && <CrashArenaRulesModal onClose={() => setShowRules(false)} />}
    </div>
  );
}
