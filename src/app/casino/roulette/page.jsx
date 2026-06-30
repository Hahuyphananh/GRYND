"use client";

// src/app/casino/roulette/page.jsx
//
// Lobby page for the Roulette PvP match system. Previously this route
// hosted the solo roulette game; that game has been moved to the
// dynamic sibling `/casino/roulette/[matchId]/page.jsx` (the match
// view), and this file is now the entry-point where players pick a
// stake and either pair with an existing lobby of the same stake or
// create a fresh waiting lobby.
//
// Flow:
//   1. Pick a stake (preset chips or custom).
//   2. Hit Play → POST /api/roulette-pvp/create-or-join
//        • matches on stake equality (server-authoritative)
//        • escrow stake on success
//   3. Redirect to /casino/roulette/[matchId]
//
// Server-side canonical logic (match state machine, stake escrow,
// round resolution) lives in src/lib/roulette-pvp/serverStore.js —
// this page is a thin client.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
import { motion } from "framer-motion";
import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";
import { useSocket } from "../../../context/SocketProvider";
import {
  ROULETTE_PVP_LOBBY_ROOM,
  ROULETTE_PVP_MATCH_UPDATED,
  roulettePvpMatchRoom,
} from "../../../lib/roulette-pvp/rooms";
import {
  RouletteWheelIcon,
  CoinIcon,
  TargetIcon,
  RefreshIcon,
  LoadingDotsIcon,
  StackCoinIcon,
} from "../../../components/roulette-pvp/RouletteIcons";

const STAKE_PRESETS = [10, 25, 50, 100, 250, 500];

export default function RoulettePvpLobbyPage() {
  const { isSignedIn } = useUser();
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();

  const [stake, setStake] = useState(50);
  const [availableMatches, setAvailableMatches] = useState([]);
  const [balance, setBalance] = useState(null);
  const [busy, setBusy] = useState(false);
  const [joiningId, setJoiningId] = useState(null);
  const [error, setError] = useState(null);

  const fetchAvailable = async () => {
    try {
      const res = await fetch("/api/roulette-pvp/available", {
        cache: "no-store",
      });
      const data = await res.json();
      if (data.success) setAvailableMatches(data.data.matches || []);
    } catch {
      // Silent — polling will retry.
    }
  };

  const fetchBalance = async () => {
    try {
      const res = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (data?.success) setBalance(Number(data.data.balance));
    } catch {
      // Silent
    }
  };

  useEffect(() => {
    fetchAvailable();
    if (isSignedIn) fetchBalance();
    const interval = setInterval(() => {
      fetchAvailable();
      fetchBalance();
    }, 3000);
    return () => clearInterval(interval);
  }, [isSignedIn]);

  useEffect(() => {
    if (!socket) return;
    const refresh = () => fetchAvailable();
    socket.emit("join_room", { roomId: ROULETTE_PVP_LOBBY_ROOM });
    socket.on("lobby:updated", refresh);
    return () => {
      socket.emit("leave_room", { roomId: ROULETTE_PVP_LOBBY_ROOM });
      socket.off("lobby:updated", refresh);
    };
  }, [socket]);

  const createOrJoin = async (stakeAmount) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/roulette-pvp/create-or-join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ stakeAmount }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data?.error || "Unable to start match");
        return;
      }
      socket?.emit("room_event", {
        roomId: ROULETTE_PVP_LOBBY_ROOM,
        event: "lobby:updated",
      });
      // Live-update fanout to the freshly-created match room so the
      // opponent (already on /casino/roulette/[matchId] after joining)
      // sees the waiting → ready transition without waiting for the
      // 1.5 s poll. Both players subscribe to this room on mount;
      // `socket.to(room).emit` (server-side fanout) means they each
      // receive the other's updates.
      const matchId = data?.data?.match?.id;
      if (matchId) {
        socket?.emit("room_event", {
          roomId: roulettePvpMatchRoom(matchId),
          event: ROULETTE_PVP_MATCH_UPDATED,
        });
      }
      posthog?.capture("roulette_pvp_match_created_or_joined", {
        stake: stakeAmount,
        joined: Boolean(data?.data?.joined),
        match_id: data?.data?.match?.id,
      });
      // Newly created/joined match lives at the dynamic sibling route.
      router.push(`/casino/roulette/${data.data.match.id}`);
    } finally {
      setBusy(false);
    }
  };

  const joinSpecific = async (matchId) => {
    setJoiningId(matchId);
    setError(null);
    try {
      const target = availableMatches.find((m) => m.id === matchId);
      if (!target) {
        setError("Lobby no longer available.");
        return;
      }
      const res = await fetch("/api/roulette-pvp/create-or-join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ stakeAmount: target.stakeAmount }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data?.error || "Unable to join match");
        return;
      }
      socket?.emit("room_event", {
        roomId: ROULETTE_PVP_LOBBY_ROOM,
        event: "lobby:updated",
      });
      socket?.emit("room_event", {
        roomId: roulettePvpMatchRoom(data.data.match.id),
        event: ROULETTE_PVP_MATCH_UPDATED,
      });
      posthog?.capture("roulette_pvp_match_joined", {
        match_id: matchId,
        stake: target.stakeAmount,
      });
      router.push(`/casino/roulette/${data.data.match.id}`);
    } finally {
      setJoiningId(null);
    }
  };

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto mt-4 max-w-5xl sm:mt-8">
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <h1 className="flex items-center justify-center gap-3 text-center text-3xl sm:text-4xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 via-amber-300 to-yellow-500 drop-shadow-[0_0_18px_rgba(255,255,51,0.55)]">
            <RouletteWheelIcon
              className="w-9 h-9 sm:w-10 sm:h-10 text-yellow-300 drop-shadow-[0_0_12px_rgba(255,255,51,0.55)] flex-shrink-0"
              title="Roulette wheel"
            />
            <span>Roulette PvP Lobby</span>
          </h1>
        </motion.div>
        <p className="text-center text-sm text-white/60 mt-2 mb-7 max-w-2xl mx-auto">
          Pick a stake. We pair you with another player of the <b>exact same</b>{" "}
          token amount. Three rounds (best of 3) plus sudden-death if needed.
          Single shared spin per round; higher net payout wins the round. Match
          points (100 to start) persist round-to-round. 2% house fee.
        </p>

        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-[#0b224f]/70 backdrop-blur-xl border border-yellow-400/30 shadow-[0_0_30px_rgba(255,255,51,0.18)] rounded-2xl p-6"
        >
          <div className="text-center mb-5 text-sm">
            <span className="uppercase tracking-widest text-[11px] text-white/55 mr-2">
              Tokens
            </span>
            <span className="font-bold text-yellow-300 text-lg">
              {balance === null
                ? "…"
                : balance.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
            </span>
          </div>

          <div className="grid md:grid-cols-[1fr_auto_1fr] gap-3 items-end">
            <div>
              <label className="text-[11px] uppercase tracking-wider text-white/60">
                Stake (per player)
              </label>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {STAKE_PRESETS.map((v) => (
                  <button
                    key={v}
                    onClick={() => setStake(v)}
                    className={`px-3 py-1.5 rounded-full text-xs font-bold border transition ${
                      stake === v
                        ? "bg-yellow-300 text-black border-yellow-300 shadow-[0_0_10px_rgba(255,255,51,0.7)]"
                        : "bg-[#08142f] text-yellow-200/80 border-yellow-300/30 hover:bg-yellow-300/15"
                    }`}
                  >
                    {v.toLocaleString()}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number"
                  min="1"
                  max={balance ?? undefined}
                  value={stake}
                  onChange={(e) =>
                    setStake(Math.max(1, Number(e.target.value) || 0))
                  }
                  className="flex-1 rounded-lg bg-[#020617] border border-yellow-300/30 focus:border-yellow-300 outline-none p-2 text-white text-sm"
                />
              </div>
            </div>
            <button
              onClick={() => createOrJoin(stake)}
              disabled={busy || !isSignedIn || (balance ?? 0) < stake}
              className="p-3 rounded-xl text-base font-extrabold text-black bg-gradient-to-r from-yellow-300 to-amber-500 hover:scale-105 active:scale-95 transition shadow-[0_0_22px_rgba(255,255,51,0.55)] disabled:opacity-50 disabled:hover:scale-100 inline-flex items-center gap-2"
            >
              {busy ? (
                <>
                  <LoadingDotsIcon
                    className="w-4 h-4 text-black animate-pulse"
                    title="Loading"
                  />
                  <span>Finding match…</span>
                </>
              ) : (
                <>
                  <span>{stake.toLocaleString()}</span>
                  <CoinIcon
                    className="w-5 h-5 text-amber-900"
                    title="Tokens"
                  />
                  <span>· Play</span>
                </>
              )}
            </button>
            <div className="text-xs text-white/55 leading-relaxed">
              We pair you with another player of the <b>exact same</b> stake.
              If no one is waiting, your stake is escrowed in a private lobby
              until someone joins or you cancel.
            </div>
          </div>

          {error && (
            <div className="mt-4 rounded-lg border border-red-400/40 bg-red-900/30 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          )}
        </motion.div>

        <div className="mt-6 bg-[#0b224f]/85 border border-yellow-300/30 rounded-2xl p-5 shadow-[0_0_22px_rgba(255,255,51,0.16)]">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold text-yellow-300 uppercase tracking-wider flex items-center gap-2">
              <TargetIcon
                className="w-4 h-4 text-yellow-300"
                title="Open lobbies"
              />
              Open Lobbies
            </h2>
            <button
              onClick={fetchAvailable}
              className="px-3 py-1.5 rounded-lg bg-yellow-300 text-[#001933] hover:bg-yellow-200 text-xs font-semibold shadow-[0_0_10px_rgba(255,255,51,0.45)] transition inline-flex items-center gap-1.5"
            >
              <RefreshIcon
                className="w-3.5 h-3.5 text-[#001933]"
                title="Refresh"
              />
              Refresh
            </button>
          </div>
          {availableMatches.length === 0 ? (
            <p className="text-sm text-white/60">
              No open lobbies yet. Be the first to make one.
            </p>
          ) : (
            <div className="space-y-2.5">
              {availableMatches.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between rounded-xl bg-[#08142f]/80 p-3 border border-yellow-300/20 hover:border-yellow-300/40 transition"
                >
                  <div>
                    <p className="text-sm font-semibold">
                      Lobby #{m.id}
                      <span className="ml-2 text-[10px] text-white/40">
                        host #{m.player1Id?.slice(0, 6) ?? "?"}…
                      </span>
                    </p>
                    <p className="text-xs text-white/60 mt-0.5 flex items-center gap-1">
                      <span>Stake:</span>
                      <span className="text-yellow-300 font-semibold inline-flex items-center gap-1">
                        {Number(m.stakeAmount).toLocaleString()}
                        <CoinIcon
                          className="w-3.5 h-3.5 text-yellow-300"
                          title="Tokens"
                        />
                      </span>
                    </p>
                  </div>
                  <button
                    onClick={() => joinSpecific(m.id)}
                    disabled={busy || joiningId === m.id}
                    className="px-4 py-1.5 rounded-lg bg-yellow-300 text-[#001933] hover:bg-yellow-200 text-sm font-bold disabled:bg-yellow-300/30 disabled:text-white/60 transition inline-flex items-center gap-1.5"
                  >
                    {joiningId === m.id ? (
                      <>
                        <StackCoinIcon
                          className="w-3.5 h-3.5 text-[#001933] animate-pulse"
                          title="Joining"
                        />
                        <span>Joining…</span>
                      </>
                    ) : (
                      "Join"
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <Footer />
      </div>
    </div>
  );
}
