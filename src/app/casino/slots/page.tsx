"use client";

// src/app/casino/slots/page.tsx
//
// MULTIPLAYER LOBBY for the Slots game (1v1 "Fruit Fortune" duels).
//
// Previously this route was a simple theme-selector for the solo slot
// machine. Slots is now a 1v1 skill game, and this page is the single
// entry point for it — the matchmaking / scoring / payout logic lives in
// `src/lib/slots-pvp/serverStore.js` (the same engine powering the
// in-match view at /casino/slots-pvp/[matchId]); this page is a thin
// client that mirrors the blackjack-pvp / roulette-pvp lobbies.
//
// Flow:
//   1. Pick a stake (preset chips or custom).
//   2. Hit Play → POST /api/slots-pvp/create-or-join
//        • matches on stake equality (server-authoritative)
//        • escrows the stake on success
//        • theme is always "fruit" (the only slot skin — the gems /
//          sevens / egyptian cosmetics were removed)
//   3. Redirect to /casino/slots-pvp/[matchId] — the live 1v1 match.
//
// Match rules: best-of-5 rounds; each round is 10 seconds; both players
// stop 3 reels each on the shared 3×3 fruit board; higher round score
// wins the round; first to 3 round wins takes the 90/10 payout.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
import { motion, AnimatePresence } from "framer-motion";
import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";
import { useSocket } from "../../../context/SocketProvider";
import {
  SLOTS_PVP_LOBBY_ROOM,
  SLOTS_PVP_MATCH_UPDATED,
  slotsPvpMatchRoom,
} from "../../../lib/slots-pvp/rooms";
import { STAKE_PRESETS } from "../../../lib/slots-pvp/constants";

// ── Inline SVG icons (kept in-file, mirrors the slots-pvp lobby) ─────

function ReelIcon({ className = "" }) {
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
      <rect x="3" y="4" width="18" height="16" rx="2" opacity="0.4" />
      <rect x="7" y="6" width="4.5" height="5" rx="0.75" />
      <rect x="13.5" y="6" width="4.5" height="5" rx="0.75" />
      <rect x="7" y="12.5" width="4.5" height="5" rx="0.75" />
      <rect x="13.5" y="12.5" width="4.5" height="5" rx="0.75" />
    </svg>
  );
}

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

function TargetIcon({ className = "" }) {
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
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function RefreshIcon({ className = "" }) {
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
      <path d="M21 12a9 9 0 0 0-15.5-6.3L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 15.5 6.3L21 16" />
      <path d="M21 21v-5h-5" />
    </svg>
  );
}

function TrophyIcon({ className = "" }) {
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
      <path d="M7 4 H17 V10 a5 5 0 0 1 -10 0 Z" />
      <path d="M7 5 H4 a2 2 0 0 0 -2 2 v2 a4 4 0 0 0 4 4" />
      <path d="M17 5 H20 a2 2 0 0 1 2 2 v2 a4 4 0 0 1 -4 4" />
      <line x1="12" y1="15" x2="12" y2="19" />
      <rect x="8" y="19" width="8" height="2.5" rx="0.5" fill="currentColor" stroke="none" />
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

function AlertIcon({ className = "" }) {
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
      <path d="M12 3 L22 20 H2 Z" />
      <line x1="12" y1="10" x2="12" y2="15" />
      <circle cx="12" cy="17.5" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

type AvailableMatch = {
  id: number;
  player1Id: string;
  stakeAmount: number;
  theme?: string;
  createdAt?: string;
};

export default function SlotsLobbyPage() {
  const { isSignedIn, user } = useUser();
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();

  // ── Form state ────────────────────────────────────────────────────
  const [stake, setStake] = useState(50);

  // ── Lobby state ───────────────────────────────────────────────────
  const [availableMatches, setAvailableMatches] = useState<AvailableMatch[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [joiningId, setJoiningId] = useState<number | null>(null);
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Fetch helpers ────────────────────────────────────────────────
  const fetchAvailable = useCallback(async () => {
    try {
      const res = await fetch("/api/slots-pvp/available", {
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

  // Derive any lobby the current user owns from the availableMatches
  // payload (which carries the player's clerkId as player1Id).
  const myOpenMatch = useMemo(
    () =>
      !user?.id
        ? null
        : availableMatches.find((m) => m.player1Id === user.id) ?? null,
    [availableMatches, user?.id],
  );

  // Subscribe to the lobby room so the open-lobbies list refreshes when
  // another player creates / joins / cancels a lobby.
  useEffect(() => {
    if (!socket) return;
    const refresh = () => fetchAvailable();
    socket.emit("join_room", { roomId: SLOTS_PVP_LOBBY_ROOM });
    socket.on(SLOTS_PVP_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId: SLOTS_PVP_LOBBY_ROOM });
      socket.off(SLOTS_PVP_MATCH_UPDATED, refresh);
    };
  }, [socket, fetchAvailable]);

  // ── Action handlers ──────────────────────────────────────────────

  // Create OR join — server's createOrJoin picks the right path based
  // on whether an open lobby with this stake already exists. The theme
  // is always "fruit": it's the only remaining slot skin.
  const createOrJoin = useCallback(
    async (stakeAmount: number) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/slots-pvp/create-or-join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ stakeAmount, theme: "fruit" }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Unable to start match");
          return;
        }
        socket?.emit("room_event", {
          roomId: SLOTS_PVP_LOBBY_ROOM,
          event: "lobby:updated",
        });
        socket?.emit("room_event", {
          roomId: slotsPvpMatchRoom(data.data.match.id),
          event: SLOTS_PVP_MATCH_UPDATED,
        });
        posthog?.capture("slots_pvp_match_created_or_joined", {
          stake: stakeAmount,
          joined: Boolean(data?.data?.joined),
          match_id: data?.data?.match?.id,
        });
        router.push(`/casino/slots-pvp/${data.data.match.id}`);
      } finally {
        setBusy(false);
      }
    },
    [posthog, router, socket],
  );

  // Join a specific lobby from the open-lobbies list.
  const joinSpecific = useCallback(
    async (matchId: number) => {
      setJoiningId(matchId);
      setError(null);
      try {
        const target = availableMatches.find((m) => m.id === matchId);
        if (!target) {
          setError("Lobby no longer available.");
          return;
        }
        const res = await fetch("/api/slots-pvp/create-or-join", {
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
          roomId: slotsPvpMatchRoom(data.data.match.id),
          event: SLOTS_PVP_MATCH_UPDATED,
        });
        posthog?.capture("slots_pvp_match_joined", {
          match_id: matchId,
          stake: target.stakeAmount,
        });
        router.push(`/casino/slots-pvp/${data.data.match.id}`);
      } finally {
        setJoiningId(null);
      }
    },
    [availableMatches, posthog, router, socket],
  );

  // Start a free-play practice match against the test bot. No stake is
  // escrowed and no payout is paid out — purely for testing the game.
  const startTest = useCallback(
    async () => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/slots-pvp/create-test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ stakeAmount: stake, theme: "fruit" }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Unable to start practice match");
          return;
        }
        posthog?.capture("slots_pvp_practice_started", {
          stake,
          match_id: data?.data?.match?.id,
        });
        router.push(`/casino/slots-pvp/${data.data.match.id}`);
      } finally {
        setBusy(false);
      }
    },
    [stake, posthog, router],
  );

  // Cancel a lobby the current user owns (only valid while `waiting`).
  const cancelMyMatch = useCallback(
    async (matchId: number) => {
      setCancellingId(matchId);
      setError(null);
      try {
        const res = await fetch(`/api/slots-pvp/match/${matchId}/cancel`, {
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
          roomId: SLOTS_PVP_LOBBY_ROOM,
          event: "lobby:updated",
        });
        posthog?.capture("slots_pvp_lobby_cancelled", {
          match_id: matchId,
        });
        fetchAvailable();
      } finally {
        setCancellingId(null);
      }
    },
    [fetchAvailable, posthog, socket],
  );

  const myOpenMatchId = myOpenMatch?.id ?? null;

  // ── Validation ────────────────────────────────────────────────────
  const stakeValid = stake > 0 && (balance === null || balance >= stake);
  const canCreate = isSignedIn && !busy && stakeValid && myOpenMatchId === null;
  // Practice is free play — no balance check needed, just a valid stake.
  const canTest = isSignedIn && !busy && stake > 0;

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto mt-4 max-w-5xl sm:mt-8">
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <h1 className="flex items-center justify-center gap-3 text-center text-3xl sm:text-4xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 via-amber-300 to-orange-400 drop-shadow-[0_0_18px_rgba(255,200,0,0.55)]">
            <ReelIcon className="w-9 h-9 sm:w-10 sm:h-10 text-amber-300 drop-shadow-[0_0_12px_rgba(255,200,0,0.65)] flex-shrink-0" />
            <span>Slots Lobby</span>
            <span className="text-2xl sm:text-3xl" aria-hidden>🍒🍋</span>
          </h1>
        </motion.div>
        <p className="text-center text-sm text-white/60 mt-2 mb-7 max-w-2xl mx-auto">
          1v1 <b>Fruit Fortune</b> duels on a <b>3×3 fruit board</b>.
          Each round lasts <b>10 seconds</b> — stop your <b>3 reels</b>{" "}
          fast for perfect-stop bonuses while the 8 winning lines score
          points. Best of <b>5 rounds</b>; first to{" "}
          <b>3 round wins</b> takes <b>1.9× their stake</b>, house takes
          0.1×. AFK reels auto-stop at the deadline.
        </p>

        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-[#0b224f]/70 backdrop-blur-xl border border-amber-300/30 shadow-[0_0_30px_rgba(255,200,0,0.18)] rounded-2xl p-6"
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
                  <LoadingDotsIcon className="w-4 h-4 text-cyan-200 animate-pulse" />
                  Your open lobby #{myOpenMatchId} is waiting for an
                  opponent…
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() =>
                      router.push(`/casino/slots-pvp/${myOpenMatchId}`)
                    }
                    className="px-3 py-1.5 rounded-lg bg-cyan-400 text-[#001933] hover:bg-cyan-300 text-xs font-bold transition"
                  >
                    Resume
                  </button>
                  <button
                    onClick={() => cancelMyMatch(myOpenMatchId)}
                    disabled={cancellingId === myOpenMatchId}
                    className="px-3 py-1.5 rounded-lg bg-red-500/20 text-red-200 hover:bg-red-500/30 text-xs font-bold border border-red-500/30 transition disabled:opacity-50"
                  >
                    {cancellingId === myOpenMatchId
                      ? "Cancelling…"
                      : "Cancel"}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

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
                        ? "bg-amber-300 text-black border-amber-300 shadow-[0_0_10px_rgba(255,200,0,0.7)]"
                        : "bg-[#08142f] text-amber-200/80 border-amber-300/30 hover:bg-amber-300/15"
                    }`}
                  >
                    {v.toLocaleString()}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={balance ?? undefined}
                  value={stake}
                  onChange={(e) =>
                    setStake(Math.max(1, Number(e.target.value) || 0))
                  }
                  className="flex-1 rounded-lg bg-[#020617] border border-amber-300/30 focus:border-amber-300 outline-none p-2 text-white text-sm"
                />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  posthog?.capture("slots_pvp_lobby_create_clicked", {
                    stake,
                    theme: "fruit",
                  });
                  createOrJoin(stake);
                }}
                disabled={!canCreate}
                className="p-3 rounded-xl text-base font-extrabold text-black bg-gradient-to-r from-yellow-300 to-amber-500 hover:scale-105 active:scale-95 transition shadow-[0_0_22px_rgba(255,200,0,0.55)] disabled:opacity-50 disabled:hover:scale-100 inline-flex items-center gap-2"
              >
                {busy ? (
                  <>
                    <LoadingDotsIcon className="w-4 h-4 text-black animate-pulse" />
                    <span>Finding match…</span>
                  </>
                ) : (
                  <>
                    <span>{stake.toLocaleString()}</span>
                    <CoinIcon className="w-5 h-5 text-amber-900" />
                    <span>· Play</span>
                  </>
                )}
              </button>
              <button
                onClick={startTest}
                disabled={!canTest}
                className="px-3 py-2 rounded-xl text-xs font-bold text-fuchsia-200 bg-fuchsia-500/10 border border-fuchsia-400/40 hover:bg-fuchsia-500/25 active:scale-95 transition disabled:opacity-50 disabled:hover:scale-100 inline-flex items-center justify-center gap-1.5"
                title="Start a free practice match against the test bot — no tokens are wagered"
              >
                {busy ? (
                  <>
                    <LoadingDotsIcon className="w-3.5 h-3.5 text-fuchsia-200 animate-pulse" />
                    <span>Starting…</span>
                  </>
                ) : (
                  <>
                    <span aria-hidden>🤖</span>
                    <span>Test vs Bot</span>
                  </>
                )}
              </button>
            </div>
            <div className="text-xs text-white/55 leading-relaxed">
              We pair you with another player of the <b>exact same</b>{" "}
              stake. If no one is waiting, your stake is escrowed in a
              private lobby until someone joins or you cancel. Both
              players stop the same 3×3 fruit board every round — the
              server decides every score.
            </div>
          </div>

          {error && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-400/40 bg-red-900/30 px-3 py-2 text-sm text-red-200">
              <AlertIcon className="w-4 h-4 text-red-300" />
              <span>{error}</span>
            </div>
          )}
        </motion.div>

        <div className="mt-6 bg-[#0b224f]/85 border border-amber-300/30 rounded-2xl p-5 shadow-[0_0_22px_rgba(255,200,0,0.16)]">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold text-amber-200 uppercase tracking-wider flex items-center gap-2">
              <TargetIcon className="w-4 h-4 text-amber-200" />
              Open Lobbies
            </h2>
            <button
              onClick={fetchAvailable}
              className="px-3 py-1.5 rounded-lg bg-amber-300 text-[#001933] hover:bg-amber-200 text-xs font-semibold shadow-[0_0_10px_rgba(255,200,0,0.45)] transition inline-flex items-center gap-1.5"
            >
              <RefreshIcon className="w-3.5 h-3.5 text-[#001933]" />
              Refresh
            </button>
          </div>
          {availableMatches.filter((m) => m.id !== myOpenMatchId).length === 0 ? (
            <div className="text-sm text-white/60 flex items-center gap-2">
              <TrophyIcon className="w-4 h-4 text-white/40" />
              <span>
                No open lobbies yet. Be the first to make one — pick a
                stake and hit Play.
              </span>
            </div>
          ) : (
            <div className="space-y-2.5">
              {availableMatches
                .filter((m) => m.id !== myOpenMatchId)
                .map((m) => {
                  const hostShort = m.player1Id?.slice(0, 6) ?? "?";
                  return (
                    <div
                      key={m.id}
                      className="flex items-center justify-between rounded-xl bg-[#08142f]/80 p-3 border border-amber-300/20 hover:border-amber-300/40 transition"
                    >
                      <div>
                        <p className="text-sm font-semibold">
                          Lobby #{m.id}
                          <span className="ml-2 text-[10px] text-white/40">
                            host {hostShort}
                          </span>
                        </p>
                        <p className="text-xs text-white/60 mt-0.5 flex items-center gap-1">
                          <span>Stake:</span>
                          <span className="text-amber-300 font-semibold inline-flex items-center gap-1">
                            {Number(m.stakeAmount).toLocaleString()}
                            <CoinIcon className="w-3.5 h-3.5 text-amber-300" />
                          </span>
                          <span className="ml-2 text-[10px] text-white/40">
                            🍒 Fruit Fortune
                          </span>
                        </p>
                      </div>
                      <button
                        onClick={() => joinSpecific(m.id)}
                        disabled={busy || joiningId === m.id}
                        className="px-4 py-1.5 rounded-lg bg-amber-300 text-[#001933] hover:bg-amber-200 text-sm font-bold disabled:bg-amber-300/30 disabled:text-white/60 transition inline-flex items-center gap-1.5"
                      >
                        {joiningId === m.id ? (
                          <>
                            <LoadingDotsIcon className="w-3.5 h-3.5 text-[#001933] animate-pulse" />
                            <span>Joining…</span>
                          </>
                        ) : (
                          "Join"
                        )}
                      </button>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
        <Footer />
      </div>
    </div>
  );
}
