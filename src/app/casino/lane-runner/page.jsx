"use client";

// src/app/casino/lane-runner/page.jsx
//
// LOBBY page for the "Lane Rush Duel" match system (the PvP
// replacement for the old solo tower game). The game logic lives in
// `src/lib/lane-rush-duel/*`; this page is a thin client.
//
// Flow:
//   1. Pick a stake (preset chips or custom).
//   2. Pick a difficulty (host-only — the joiner inherits whatever
//      the host chose when they created the lobby).
//   3. Hit Play → POST /api/lane-rush-duel/create-or-join
//        • matches on stake equality (server-authoritative)
//        • escrow stake on success
//        • provably-fair towers generated at match creation
//   4. Redirect to /casino/lane-runner/[matchId]

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
import { motion, AnimatePresence } from "framer-motion";
import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";
import { useSocket } from "../../../context/SocketProvider";
import {
  LANE_RUSH_DUEL_LOBBY_ROOM,
  LANE_RUSH_DUEL_MATCH_UPDATED,
  laneRushDuelMatchRoom,
} from "../../../lib/lane-rush-duel/rooms";
import {
  DIFFICULTIES,
  DIFFICULTY_POINT_MULT,
  MAX_LANES,
  STAKE_PRESETS,
} from "../../../lib/lane-rush-duel/constants";
import {
  IconTrophy,
  IconShieldCheck,
  IconRefresh,
  IconAlertTriangle,
  IconRobot,
  IconNotebook,
} from "@tabler/icons-react";

function CoinIcon({ className = "" }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <ellipse cx="12" cy="6" rx="8" ry="2.5" />
      <path d="M4 6 V18 a8 2.5 0 0 0 16 0 V6" />
      <ellipse cx="12" cy="18" rx="8" ry="2.5" />
    </svg>
  );
}

function TowerIcon({ className = "" }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M5 3 L8 21" />
      <path d="M19 3 L16 21" />
      <path d="M5 3 H19" />
      <path d="M8 21 H16" />
      <path d="M8 9 H16" />
      <path d="M7.5 15 H16.5" />
    </svg>
  );
}

function FlagIcon({ className = "" }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M5 21 V4" />
      <path d="M5 4 H19 L16 7.5 L19 11 H5" />
    </svg>
  );
}

function LoadingDotsIcon({ className = "" }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <circle cx="6" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="18" cy="12" r="2" />
    </svg>
  );
}

export default function LaneRushDuelLobbyPage() {
  const { isSignedIn, user } = useUser();
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();

  // ── Form state ────────────────────────────────────────────────────
  const [stake, setStake] = useState(50);
  const [difficulty, setDifficulty] = useState("easy");

  // ── Lobby state ───────────────────────────────────────────────────
  const [availableMatches, setAvailableMatches] = useState([]);
  const [balance, setBalance] = useState(null);
  const [busy, setBusy] = useState(false);
  const [joiningId, setJoiningId] = useState(null);
  const [cancellingId, setCancellingId] = useState(null);
  const [error, setError] = useState(null);

  // ── Fetch helpers ────────────────────────────────────────────────
  const fetchAvailable = useCallback(async () => {
    try {
      const res = await fetch("/api/lane-rush-duel/available", {
        cache: "no-store",
      });
      const data = await res.json();
      if (data?.success) {
        setAvailableMatches(data.data.matches || []);
      }
    } catch {
      // Silent — polling retries on the next tick.
    }
  }, []);

  const fetchBalance = useCallback(async () => {
    if (!isSignedIn) return;
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
  }, [isSignedIn]);

  useEffect(() => {
    fetchAvailable();
    fetchBalance();
    const interval = setInterval(() => {
      fetchAvailable();
      fetchBalance();
    }, 3000);
    return () => clearInterval(interval);
  }, [fetchAvailable, fetchBalance]);

  // Any lobby the current user owns, derived from the polled list.
  const myOpenMatch = useMemo(() => {
    if (!user?.id) return null;
    return availableMatches.find((m) => m.player1Id === user.id) ?? null;
  }, [availableMatches, user?.id]);
  const myOpenMatchId = myOpenMatch?.id ?? null;

  // Subscribe to lobby room updates.
  useEffect(() => {
    if (!socket) return;
    const refresh = () => fetchAvailable();
    socket.emit("join_room", { roomId: LANE_RUSH_DUEL_LOBBY_ROOM });
    socket.on(LANE_RUSH_DUEL_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId: LANE_RUSH_DUEL_LOBBY_ROOM });
      socket.off(LANE_RUSH_DUEL_MATCH_UPDATED, refresh);
    };
  }, [socket, fetchAvailable]);

  // ── Action handlers ──────────────────────────────────────────────

  const createOrJoin = useCallback(
    async (stakeAmount, chosenDifficulty) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/lane-rush-duel/create-or-join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            stakeAmount,
            difficulty: chosenDifficulty,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Unable to start match");
          return;
        }
        socket?.emit("room_event", {
          roomId: LANE_RUSH_DUEL_LOBBY_ROOM,
          event: LANE_RUSH_DUEL_MATCH_UPDATED,
        });
        const matchId = data?.data?.match?.id;
        if (matchId) {
          socket?.emit("room_event", {
            roomId: laneRushDuelMatchRoom(matchId),
            event: LANE_RUSH_DUEL_MATCH_UPDATED,
          });
        }
        posthog?.capture("lane_rush_duel_created_or_joined", {
          stake: stakeAmount,
          difficulty: chosenDifficulty,
          joined: Boolean(data?.data?.joined),
          match_id: matchId,
        });
        router.push(`/casino/lane-runner/${matchId}`);
      } finally {
        setBusy(false);
      }
    },
    [posthog, router, socket],
  );

  // Test vs Bot — zero-stake practice match against the server-side
  // bot. Same rules, no money: the bot climbs with the same bust odds
  // as a human and banks when its points meet its risk target.
  const createBotMatch = useCallback(
    async (chosenDifficulty) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/lane-rush-duel/create-or-join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            stakeAmount: 0,
            difficulty: chosenDifficulty,
            vsBot: true,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Unable to start practice match");
          return;
        }
        const matchId = data?.data?.match?.id;
        if (matchId) {
          socket?.emit("room_event", {
            roomId: laneRushDuelMatchRoom(matchId),
            event: LANE_RUSH_DUEL_MATCH_UPDATED,
          });
        }
        posthog?.capture("lane_rush_duel_vs_bot_started", {
          difficulty: chosenDifficulty,
          match_id: matchId,
        });
        router.push(`/casino/lane-runner/${matchId}`);
      } finally {
        setBusy(false);
      }
    },
    [posthog, router, socket],
  );

  const joinSpecific = useCallback(
    async (matchId) => {
      setJoiningId(matchId);
      setError(null);
      try {
        const target = availableMatches.find((m) => m.id === matchId);
        if (!target) {
          setError("Lobby no longer available.");
          return;
        }
        const res = await fetch("/api/lane-rush-duel/create-or-join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          // difficulty is IGNORED by the server in the join path (the
          // host's is locked at lobby creation), passed for telemetry.
          body: JSON.stringify({
            stakeAmount: target.stakeAmount,
            difficulty: target.difficulty,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Unable to join match");
          return;
        }
        socket?.emit("room_event", {
          roomId: LANE_RUSH_DUEL_LOBBY_ROOM,
          event: LANE_RUSH_DUEL_MATCH_UPDATED,
        });
        socket?.emit("room_event", {
          roomId: laneRushDuelMatchRoom(data.data.match.id),
          event: LANE_RUSH_DUEL_MATCH_UPDATED,
        });
        posthog?.capture("lane_rush_duel_joined", {
          match_id: matchId,
          stake: target.stakeAmount,
          difficulty: target.difficulty,
        });
        router.push(`/casino/lane-runner/${data.data.match.id}`);
      } finally {
        setJoiningId(null);
      }
    },
    [availableMatches, posthog, router, socket],
  );

  const cancelMyMatch = useCallback(
    async (matchId) => {
      setCancellingId(matchId);
      setError(null);
      try {
        const res = await fetch(`/api/lane-rush-duel/match/${matchId}/cancel`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Unable to cancel match");
          return;
        }
        socket?.emit("room_event", {
          roomId: LANE_RUSH_DUEL_LOBBY_ROOM,
          event: LANE_RUSH_DUEL_MATCH_UPDATED,
        });
        posthog?.capture("lane_rush_duel_lobby_cancelled", { match_id: matchId });
        fetchAvailable();
      } finally {
        setCancellingId(null);
      }
    },
    [fetchAvailable, socket, posthog],
  );

  const difficultyValid = Boolean(DIFFICULTIES[difficulty]);
  const stakeValid = stake > 0 && (balance === null || balance >= stake);
  const canCreate =
    isSignedIn && !busy && difficultyValid && stakeValid && myOpenMatchId === null;

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto mt-4 max-w-5xl sm:mt-8">
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <h1 className="flex items-center justify-center gap-3 text-center text-3xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-cyan-200 via-cyan-300 to-fuchsia-300 drop-shadow-[0_0_18px_rgba(0,229,255,0.55)] sm:text-4xl">
            <TowerIcon className="h-9 w-9 flex-shrink-0 text-cyan-300 drop-shadow-[0_0_12px_rgba(0,229,255,0.65)] sm:h-10 sm:w-10" />
            <span>Lane Rush Duel</span>
          </h1>
        </motion.div>
        <p className="mx-auto mb-7 mt-2 max-w-2xl text-center text-sm text-white/60">
          You and your opponent each race your <b>own tower</b> — same
          difficulty, same provably-fair seed. On your turn pick a tile
          in your current lane (<b className="text-emerald-300">safe</b>{" "}
          earns points, <b className="text-rose-300">bad</b> busts you) or{" "}
          <b className="text-amber-300">HOLD</b> to bank your points and
          force your opponent to climb past them. The{" "}
          <b>higher banked tower</b> takes the pot — 1.9× your stake,
          house takes 0.1×.
        </p>

        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl border border-cyan-300/30 bg-[#0b224f]/70 p-6 shadow-[0_0_30px_rgba(0,229,255,0.18)] backdrop-blur-xl"
        >
          <div className="mb-5 text-center text-sm">
            <span className="mr-2 text-[11px] uppercase tracking-widest text-white/55">
              Tokens
            </span>
            <span className="text-lg font-bold text-yellow-300">
              {balance === null
                ? "…"
                : balance.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
            </span>
          </div>

          {/* Your own open match notification */}
          <AnimatePresence>
            {myOpenMatchId !== null && (
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-cyan-300/40 bg-cyan-500/10 px-3 py-2 text-sm"
              >
                <span className="flex items-center gap-2 text-cyan-200">
                  <LoadingDotsIcon className="h-4 w-4 animate-pulse text-cyan-200" />
                  Your open lobby #{myOpenMatchId} is waiting for an
                  opponent…
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => router.push(`/casino/lane-runner/${myOpenMatchId}`)}
                    className="rounded-lg bg-cyan-400 px-3 py-1.5 text-xs font-bold text-[#001933] transition hover:bg-cyan-300"
                  >
                    Resume
                  </button>
                  <button
                    onClick={() => cancelMyMatch(myOpenMatchId)}
                    disabled={cancellingId === myOpenMatchId}
                    className="rounded-lg border border-red-500/30 bg-red-500/20 px-3 py-1.5 text-xs font-bold text-red-200 transition hover:bg-red-500/30 disabled:opacity-50"
                  >
                    {cancellingId === myOpenMatchId ? "Cancelling…" : "Cancel"}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="grid items-end gap-3 md:grid-cols-[1.1fr_auto_1fr]">
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {/* Wager (stake) picker */}
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-white/60">
                  Wager
                </label>
                <div className="mt-1 flex flex-wrap gap-1">
                  {STAKE_PRESETS.map((v) => (
                    <button
                      key={v}
                      onClick={() => setStake(v)}
                      className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition ${
                        stake === v
                          ? "border-cyan-300 bg-cyan-300 text-black shadow-[0_0_8px_rgba(0,229,255,0.7)]"
                          : "border-cyan-300/30 bg-[#08142f] text-cyan-200/80 hover:bg-cyan-300/15"
                      }`}
                    >
                      {v.toLocaleString()}
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  min={1}
                  max={balance ?? undefined}
                  value={stake}
                  onChange={(e) =>
                    setStake(Math.max(1, Number(e.target.value) || 0))
                  }
                  className="mt-1.5 w-full rounded-md border border-cyan-300/30 bg-[#020617] px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-300"
                />
              </div>
              {/* Difficulty picker — host-only at create time */}
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-white/60">
                  Difficulty{" "}
                  <span className="font-normal normal-case tracking-normal text-fuchsia-300/70">
                    (host)
                  </span>
                </label>
                <div className="mt-1 flex flex-wrap gap-1">
                  {Object.entries(DIFFICULTIES).map(([key, config]) => (
                    <button
                      key={key}
                      onClick={() => setDifficulty(key)}
                      className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition ${
                        difficulty === key
                          ? "border-fuchsia-400 bg-fuchsia-400 text-black shadow-[0_0_8px_rgba(217,70,239,0.7)]"
                          : "border-fuchsia-300/30 bg-[#08142f] text-fuchsia-200/80 hover:bg-fuchsia-300/15"
                      }`}
                    >
                      {config.label}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[9px] leading-tight text-white/40">
                  {DIFFICULTIES[difficulty]?.width} tiles per lane · full
                  climb ={" "}
                  {(
                    2400 *
                    (DIFFICULTY_POINT_MULT[difficulty] ?? 1)
                  ).toLocaleString()}{" "}
                  pts. Joiners inherit.
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  posthog?.capture("lane_rush_duel_create_clicked", {
                    stake,
                    difficulty,
                  });
                  createOrJoin(stake, difficulty);
                }}
                disabled={!canCreate}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-300 to-fuchsia-400 p-3 text-base font-extrabold text-black shadow-[0_0_22px_rgba(0,229,255,0.55)] transition hover:scale-105 active:scale-95 disabled:opacity-50 disabled:hover:scale-100"
              >
                {busy ? (
                  <>
                    <LoadingDotsIcon className="h-4 w-4 animate-pulse text-black" />
                    <span>Finding match…</span>
                  </>
                ) : (
                  <>
                    <span>{stake.toLocaleString()}</span>
                    <CoinIcon className="h-5 w-5 text-cyan-900" />
                    <span>· Play</span>
                  </>
                )}
              </button>
              <button
                onClick={() => {
                  posthog?.capture("lane_rush_duel_vs_bot_clicked", {
                    difficulty,
                  });
                  createBotMatch(difficulty);
                }}
                disabled={!isSignedIn || busy}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-300/40 bg-emerald-500/15 p-2.5 text-sm font-bold text-emerald-200 transition hover:bg-emerald-500/25 hover:brightness-110 disabled:opacity-50"
              >
                <IconRobot size={17} className="text-emerald-300" />
                {busy ? "Starting…" : "Test vs Bot"}
                <span className="rounded-full bg-emerald-400/20 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-emerald-300">
                  Free
                </span>
              </button>
            </div>

            <div className="text-xs leading-relaxed text-white/55">
              We pair you with another player of the{" "}
              <b>exact same</b> stake. If no one is waiting, your stake
              is escrowed in a private lobby with your chosen difficulty
              until someone joins or you cancel.
            </div>
          </div>

          {/* Skill mechanic explainer */}
          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-emerald-300/25 bg-emerald-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-emerald-100/85">
            <IconShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-300" />
            <p>
              <span className="font-bold text-emerald-200">Skill duel.</span>{" "}
              Every lane hides one bad tile — each lane you pick your{" "}
              <b>odds</b> (Safe / Balanced / Risky paths), choose when to
              risk another climb or bank your points, and track the{" "}
              bad-tile pattern to call it for a win. Once you HOLD, your
              opponent must climb past you or bust trying. Towers are{" "}
              <b>provably fair</b>: both derive from one shared server
              seed (hash shown before the match) + each player's own
              client seed, revealed after.
            </p>
          </div>

          {error && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-400/40 bg-red-900/30 px-3 py-2 text-sm text-red-200">
              <IconAlertTriangle className="h-4 w-4 text-red-300" />
              <span>{error}</span>
            </div>
          )}
        </motion.div>

        <div className="mt-6 rounded-2xl border border-cyan-300/30 bg-[#0b224f]/85 p-5 shadow-[0_0_22px_rgba(0,229,255,0.16)]">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-bold uppercase tracking-wider text-cyan-200">
              <IconTrophy className="h-4 w-4 text-cyan-200" />
              Open Lobbies
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => router.push("/casino/lane-runner/history")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-300/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-500/20"
              >
                <IconNotebook className="h-3.5 w-3.5 text-cyan-200" />
                History
              </button>
              <button
                onClick={fetchAvailable}
                className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-300 px-3 py-1.5 text-xs font-semibold text-[#001933] shadow-[0_0_10px_rgba(0,229,255,0.45)] transition hover:bg-cyan-200"
              >
                <IconRefresh className="h-3.5 w-3.5 text-[#001933]" />
                Refresh
              </button>
            </div>
          </div>
          {availableMatches.filter((m) => m.id !== myOpenMatchId).length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-white/60">
              <FlagIcon className="h-4 w-4 text-white/40" />
              <span>No open lobbies yet. Be the first to make one.</span>
            </div>
          ) : (
            <div className="space-y-2.5">
              {availableMatches
                .filter((m) => m.id !== myOpenMatchId)
                .map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center justify-between rounded-xl border border-cyan-300/20 bg-[#08142f]/80 p-3 transition hover:border-cyan-300/40"
                  >
                    <div>
                      <p className="text-sm font-semibold">
                        Lobby #{m.id}
                        <span className="ml-2 text-[10px] text-white/40">
                          host #{m.player1Id?.slice(0, 6) ?? "?"}…
                        </span>
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/60">
                        <span className="inline-flex items-center gap-1">
                          <span>Stake:</span>
                          <span className="inline-flex items-center gap-1 font-semibold text-yellow-300">
                            {Number(m.stakeAmount).toLocaleString()}
                            <CoinIcon className="h-3.5 w-3.5 text-yellow-300" />
                          </span>
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <span>Difficulty:</span>
                          <span className="font-semibold text-fuchsia-300">
                            {DIFFICULTIES[m.difficulty]?.label || m.difficulty}
                          </span>
                        </span>
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        posthog?.capture("lane_rush_duel_join_clicked", {
                          match_id: m.id,
                          stake: m.stakeAmount,
                          difficulty: m.difficulty,
                        });
                        joinSpecific(m.id);
                      }}
                      disabled={busy || joiningId === m.id}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-300 px-4 py-1.5 text-sm font-bold text-[#001933] transition hover:bg-cyan-200 disabled:bg-cyan-300/30 disabled:text-white/60"
                    >
                      {joiningId === m.id ? (
                        <>
                          <LoadingDotsIcon className="h-3.5 w-3.5 animate-pulse text-[#001933]" />
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
