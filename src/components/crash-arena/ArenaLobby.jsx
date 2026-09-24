"use client";
import React, { useState, useMemo, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { IconBook, IconRocket } from "@tabler/icons-react";
import TableList from "./TableList";
import WagerSection from "./WagerSection";
import BuyInModal from "./BuyInModal";
import CrashArenaRulesModal from "./CrashArenaRulesModal";
import AiDifficultyPicker from "../lobby/AiDifficultyPicker";
import { readStoredAiDifficulty } from "../../lib/aiDifficulty";
import { CRASH_MIN_WAGER } from "../../lib/games/crash/constants";
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
}) {
  const router = useRouter();
  const { socket } = useSocket();

  // ── Custom wager for creating a table ───────────────────────────────
  const [wager, setWager] = useState(1);
  // Private tables are hidden from the public grid — the creator plays
  // there with invited friends (and can add AI seats, poker-style).
  const [isPrivate, setIsPrivate] = useState(false);

  // The tier every AI seat added at this table starts on. Crash Arena's seats
  // store their own tier, so this is the DEFAULT the host's add-AI modal opens
  // with — carried to the table page in the URL.
  const [aiDifficulty, setAiDifficulty] = useState(() =>
    readStoredAiDifficulty("crash-arena"),
  );

  const [creating, setCreating] = useState(false);
  const [joinTarget, setJoinTarget] = useState(null); // table awaiting buy-in (join)
  const [busyTableId, setBusyTableId] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [showRules, setShowRules] = useState(false);
  // ── Join a private game with the host's invite code (poker-style) ────
  const [inviteCodeInput, setInviteCodeInput] = useState("");
  const [joiningByCode, setJoiningByCode] = useState(false);

  // AI practice + private tables are hidden from the public grid — only
  // public tables are joinable from the lobby (private ones are reachable
  // via their table URL / invites).
  const availableTables = useMemo(
    () => tables.filter((t) => !t.isAi && !t.isPrivate),
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

  // ── Create a brand-new table with custom wager + visibility ─────────
  // Poker-style: creating the game redirects straight to the table page,
  // where the creator buys in, adds AI seats (private only) and waits for
  // other players.
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
        body: JSON.stringify({ wager: wagerAmount, isPrivate }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Unable to create table");
      }
      emitLobbyUpdate({ created: true, wager: wagerAmount });
      router.push(
        `/casino/crash-arena/table/${data.data.tableId}?aiDifficulty=${aiDifficulty}`,
      );
    } catch (err) {
      fail(err.message || "Unable to create table");
    } finally {
      setCreating(false);
    }
  }, [isSignedIn, fail, emitLobbyUpdate, router, isPrivate, aiDifficulty]);

  // ── Join a private game by invite code ──────────────────────────────
  // Resolves the code to its table, then lands on the table page with the
  // code in the URL (the join route validates it again server-side).
  const handleJoinByCode = useCallback(async () => {
    const code = inviteCodeInput.trim().toUpperCase();
    if (!code) {
      setActionError("Enter an invite code");
      return;
    }
    if (!isSignedIn) {
      setActionError("Please sign in to join a private game.");
      return;
    }
    setActionError(null);
    setJoiningByCode(true);
    try {
      const res = await fetch("/api/crash-arena/join-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ joinCode: code }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setActionError(data?.error || "No private game matches that invite code");
        return;
      }
      router.push(`/casino/crash-arena/table/${data.data.tableId}?code=${code}`);
    } catch {
      setActionError("Unable to join by invite code");
    } finally {
      setJoiningByCode(false);
    }
  }, [inviteCodeInput, isSignedIn, router]);

  // ── Open the buy-in modal for a table ───────────────────────────────
  const handleJoin = useCallback((table) => {
    setActionError(null);
    if (!isSignedIn) {
      setActionError("Please sign in to join a table.");
      return;
    }
    setJoinTarget(table);
  }, [isSignedIn]);

  // ── Complete the buy-in with the chosen amount (joining an existing
  //    table from the grid) — seats the player via /api/crash-arena/join. ─
  const handleBuyIn = useCallback(async (amount) => {
    const table = joinTarget;
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
      emitLobbyUpdate({ joined: true, tableId: table.id });
      router.push(`/casino/crash-arena/table/${table.id}`);
    } catch (err) {
      setBusyTableId(null);
      fail(err.message || "Unable to join table");
    }
  }, [joinTarget, router, fail, emitLobbyUpdate]);

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
      {actionError && (
        <div className="mb-4 mx-auto max-w-xl px-4 py-2.5 rounded-xl bg-red-900/30 border border-red-400/40 text-red-300 text-sm text-center">
          {actionError}
        </div>
      )}

      {/* ═══ Create Table section ═══ */}
      <div className="mb-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Create Table with custom wager + public/private visibility */}
        <div className="lg:col-span-2">
          <WagerSection
            wager={wager}
            setWager={setWager}
            isPrivate={isPrivate}
            setIsPrivate={setIsPrivate}
            isSignedIn={isSignedIn}
            creating={creating}
            onCreate={handleCreate}
            userBalance={userBalance}
          />

          {/* AI seats are only addable at a private table, so the tier is picked
              here and carried to the table the host lands on. */}
          {isPrivate && (
            <AiDifficultyPicker
              gameKey="crash-arena"
              value={aiDifficulty}
              onChange={setAiDifficulty}
              className="mt-3"
              hint={{
                easy: "Bots fold early and rarely take the pot.",
                normal: "Bots fold around the middle of the curve.",
                hard: "Bots ride deep into the danger zone before folding.",
              }}
            />
          )}
        </div>

        {/* Join a private game with the host's invite code (poker-style) */}
        <div className="flex flex-col rounded-2xl border border-[#00e5ff]/25 bg-black/40 p-5">
          <span className="text-xs uppercase tracking-widest text-[#9dd8ff]/60">
            🔒 Join Private Game
          </span>
          <p className="text-sm font-bold text-white/90 mt-0.5 mb-3">
            Enter the invite code the host shared
          </p>
          <div className="flex items-center bg-[#020617] border border-[#00e5ff]/40 rounded-xl overflow-hidden focus-within:border-[#00e5ff] transition-all">
            <input
              type="text"
              value={inviteCodeInput}
              onChange={(e) => setInviteCodeInput(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleJoinByCode();
              }}
              placeholder="K7PM2A"
              className="flex-1 bg-transparent px-4 py-3 text-white text-base font-bold uppercase tracking-widest outline-none text-center"
            />
          </div>
          <button
            onClick={handleJoinByCode}
            disabled={!isSignedIn || joiningByCode || !inviteCodeInput.trim()}
            className={`mt-3 w-full py-2.5 rounded-xl font-bold text-sm text-center transition-all duration-300
              bg-gradient-to-r from-[#00e5ff] to-[#007cf0] text-white border border-[#00e5ff]
              hover:brightness-110 hover:scale-[1.02] hover:shadow-[0_0_20px_rgba(0,229,255,0.4)]
              disabled:opacity-60 disabled:hover:scale-100`}
          >
            {joiningByCode ? "Joining…" : "Join with Code"}
          </button>
          <p className="text-[10px] text-[#9dd8ff]/50 leading-tight mt-2">
            Private games are invite-only — you need the code from the host
            to join them.
          </p>
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
