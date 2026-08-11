"use client";

// src/app/casino/slots-pvp/page.jsx
//
// LOBBY page for the PvP Slots ("Skill Slots") match system. The
// matchmaking / scoring / payout logic lives in
// `src/lib/slots-pvp/serverStore.js`; this page is a thin client that
// mirrors the plinko-pvp lobby exactly.
//
// Flow:
//   1. Pick a stake (preset chips or custom) + a slot theme.
//   2. Hit Play → POST /api/slots-pvp/create-or-join
//        • matches on stake equality (server-authoritative)
//        • escrows the stake on success
//   3. Redirect to /casino/slots-pvp/[matchId]
//
// Match rules: best-of-5 rounds; each round is 10 seconds; both
// players stop 3 reels each; higher round score wins the round;
// first to 3 round wins takes the 90/10 payout.

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
import { THEME_IDS, getTheme } from "../../../lib/slotThemes";

// ── Inline SVG icons (kept in-file so this lobby doesn't pull in
// other game-specific icon sets) ─────────────────────────────────────

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

export default function SlotsPvpLobbyPage() {
  const { isSignedIn, user } = useUser();
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();

  // ── Form state ────────────────────────────────────────────────────
  const [stake, setStake] = useState(50);
  const [theme, setTheme] = useState("fruit");

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

  // Subscribe to the lobby room (no-op safety net — the lobby refreshes
  // its open-lobbies list via the /available polling endpoint, same as
  // plinko-pvp).
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
  // on whether an open lobby with this stake already exists.
  const createOrJoin = useCallback(
    async (stakeAmount, chosenTheme) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/slots-pvp/create-or-join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            stakeAmount,
            theme: chosenTheme || theme,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Unable to start match");
          return;
        }
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
    [posthog, router, socket, theme],
  );

  // Join a specific lobby from the open-lobbies list.
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

  // Cancel a lobby the current user owns (only valid while `waiting`).
  const cancelMyMatch = useCallback(
    async (matchId) => {
      setCancellingId(matchId);
      setError(null);
      try {
        const res = await fetch(
          `/api/slots-pvp/match/${matchId}/cancel`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
          },
        );
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Unable to cancel match");
          return;
        }
        socket?.emit("room_event", {
          roomId: slotsPvpMatchRoom(matchId),
          event: SLOTS_PVP_MATCH_UPDATED,
        });
        posthog?.capture("slots_pvp_lobby_cancelled", {
          match_id: matchId,
        });
        fetchAvailable();
      } finally {
        setCancellingId(null);
      }
    },
    [fetchAvailable, socket, posthog],
  );

  const myOpenMatchId = myOpenMatch?.id ?? null;

  // ── Validation ────────────────────────────────────────────────────
  const stakeValid = stake > 0 && (balance === null || balance >= stake);
  const canCreate = isSignedIn && !busy && stakeValid && myOpenMatchId === null;

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto mt-4 max-w-5xl sm:mt-8">
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <h1 className="flex items-center justify-center gap-3 text-center text-3xl sm:text-4xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-cyan-200 via-cyan-300 to-fuchsia-300 drop-shadow-[0_0_18px_rgba(0,229,255,0.55)]">
            <ReelIcon className="w-9 h-9 sm:w-10 sm:h-10 text-cyan-300 drop-shadow-[0_0_12px_rgba(0,229,255,0.65)] flex-shrink-0" />
            <span>Slots Duel Lobby</span>
          </h1>
        </motion.div>
        <p className="text-center text-sm text-white/60 mt-2 mb-7 max-w-2xl mx-auto">
          Best-of-5 skill rounds on a <b>3×3 slot board</b>. Each round
          lasts <b>10 seconds</b> — stop your <b>3 reels</b> fast for
          perfect-stop bonuses while the 8 winning lines score you
          points. First to <b>3 round wins</b> takes{" "}
          <b>1.9× their stake</b>, house takes 0.1×. AFK reels
          auto-stop at the deadline.
        </p>

        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-[#0b224f]/70 backdrop-blur-xl border border-cyan-300/30 shadow-[0_0_30px_rgba(0,229,255,0.18)] rounded-2xl p-6"
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
            <div className="space-y-3">
              {/* Stake picker */}
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
                          ? "bg-cyan-300 text-black border-cyan-300 shadow-[0_0_10px_rgba(0,229,255,0.7)]"
                          : "bg-[#08142f] text-cyan-200/80 border-cyan-300/30 hover:bg-cyan-300/15"
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
                    className="flex-1 rounded-lg bg-[#020617] border border-cyan-300/30 focus:border-cyan-300 outline-none p-2 text-white text-sm"
                  />
                </div>

                {/* Theme picker (host picks; joiner consumes the host's) */}
                <div className="mt-3">
                  <label className="text-[11px] uppercase tracking-wider text-white/60">
                    Slot theme
                  </label>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {THEME_IDS.map((t) => (
                      <button
                        key={t}
                        onClick={() => setTheme(t)}
                        className={`px-2.5 py-1.5 rounded-lg text-xs font-bold border transition ${
                          theme === t
                            ? "bg-fuchsia-400 text-black border-fuchsia-400 shadow-[0_0_10px_rgba(255,79,216,0.7)]"
                            : "bg-[#08142f] text-fuchsia-200/80 border-fuchsia-300/30 hover:bg-fuchsia-300/15"
                        }`}
                      >
                        {getTheme(t).name}
                      </button>
                    ))}
                  </div>
                </div>

                <p className="text-[10px] text-white/45 mt-2">
                  Both players pay this amount. Winner takes 1.9× back,
                  house takes 0.1×.
                </p>
              </div>
            </div>

            <button
              onClick={() => {
                posthog?.capture("slots_pvp_lobby_create_clicked", {
                  stake,
                  theme,
                });
                createOrJoin(stake, theme);
              }}
              disabled={!canCreate}
              className="p-3 rounded-xl text-base font-extrabold text-black bg-gradient-to-r from-cyan-300 to-fuchsia-400 hover:scale-105 active:scale-95 transition shadow-[0_0_22px_rgba(0,229,255,0.55)] disabled:opacity-50 disabled:hover:scale-100 inline-flex items-center gap-2"
            >
              {busy ? (
                <>
                  <LoadingDotsIcon className="w-4 h-4 text-black animate-pulse" />
                  <span>Finding match…</span>
                </>
              ) : (
                <>
                  <span>{stake.toLocaleString()}</span>
                  <CoinIcon className="w-5 h-5 text-cyan-900" />
                  <span>· Play</span>
                </>
              )}
            </button>

            <div className="text-xs text-white/55 leading-relaxed">
              We pair you with another player of the <b>exact same</b>{" "}
              stake. If no one is waiting, your stake is escrowed in a
              private lobby until someone joins or you cancel. Both
              players stop the same 3×3 board every round — the server
              decides every score.
            </div>
          </div>

          {error && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-400/40 bg-red-900/30 px-3 py-2 text-sm text-red-200">
              <AlertIcon className="w-4 h-4 text-red-300" />
              <span>{error}</span>
            </div>
          )}
        </motion.div>

        <div className="mt-6 bg-[#0b224f]/85 border border-cyan-300/30 rounded-2xl p-5 shadow-[0_0_22px_rgba(0,229,255,0.16)]">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold text-cyan-200 uppercase tracking-wider flex items-center gap-2">
              <TargetIcon className="w-4 h-4 text-cyan-200" />
              Open Lobbies
            </h2>
            <button
              onClick={fetchAvailable}
              className="px-3 py-1.5 rounded-lg bg-cyan-300 text-[#001933] hover:bg-cyan-200 text-xs font-semibold shadow-[0_0_10px_rgba(0,229,255,0.45)] transition inline-flex items-center gap-1.5"
            >
              <RefreshIcon className="w-3.5 h-3.5 text-[#001933]" />
              Refresh
            </button>
          </div>
          {availableMatches.filter((m) => m.id !== myOpenMatchId).length ===
          0 ? (
            <div className="text-sm text-white/60 flex items-center gap-2">
              <TrophyIcon className="w-4 h-4 text-white/40" />
              <span>No open lobbies yet. Be the first to make one.</span>
            </div>
          ) : (
            <div className="space-y-2.5">
              {availableMatches
                .filter((m) => m.id !== myOpenMatchId)
                .map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center justify-between rounded-xl bg-[#08142f]/80 p-3 border border-cyan-300/20 hover:border-cyan-300/40 transition"
                  >
                    <div>
                      <p className="text-sm font-semibold inline-flex items-center gap-2">
                        <span>Lobby #{m.id}</span>
                        <span className="text-[10px] text-white/60 inline-flex items-center gap-1.5">
                          {m.hostProfileImageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={m.hostProfileImageUrl}
                              alt=""
                              className="w-4 h-4 rounded-full border border-cyan-300/40"
                              onError={(e) => {
                                e.currentTarget.style.display = "none";
                              }}
                            />
                          ) : (
                            <span className="w-4 h-4 rounded-full bg-cyan-500/20 border border-cyan-300/40 flex items-center justify-center text-[9px] font-black uppercase">
                              {(m.hostName ?? "?").slice(0, 1)}
                            </span>
                          )}
                          <span>
                            {m.hostName ?? m.player1Id?.slice(0, 6) + "..."}
                          </span>
                        </span>
                      </p>
                      <p className="text-xs text-white/60 mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="inline-flex items-center gap-1">
                          <span>Stake:</span>
                          <span className="text-yellow-300 font-semibold inline-flex items-center gap-1">
                            {Number(m.stakeAmount).toLocaleString()}
                            <CoinIcon className="w-3.5 h-3.5 text-yellow-300" />
                          </span>
                        </span>
                        <span className="text-white/40">
                          · {getTheme(m.theme || "fruit").name}
                        </span>
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        posthog?.capture("slots_pvp_lobby_join_clicked", {
                          match_id: m.id,
                          stake: m.stakeAmount,
                        });
                        joinSpecific(m.id);
                      }}
                      disabled={busy || joiningId === m.id}
                      className="px-4 py-1.5 rounded-lg bg-cyan-300 text-[#001933] hover:bg-cyan-200 text-sm font-bold disabled:bg-cyan-300/30 disabled:text-white/60 transition inline-flex items-center gap-1.5"
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
                ))}
            </div>
          )}
        </div>
        <Footer />
      </div>
    </div>
  );
}
