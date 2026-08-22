"use client";

// src/app/casino/blackjack/page.tsx
//
// LOBBY page for the Blackjack PvP match system. Previously this route
// hosted the player-vs-dealer game; that's been split so the lobby
// sits at /casino/blackjack (entry-point where players pick a stake
// and either pair with an existing lobby of the same stake or create
// a fresh waiting lobby) and the live match view lives at the dynamic
// sibling `/casino/blackjack/[matchId]/page.tsx`.
//
// Flow:
//   1. Pick a stake (preset chips or custom).
//   2. Hit Play → POST /api/blackjack-pvp/create-or-join
//        • matches on stake equality (server-authoritative)
//        • escrow stake on success
//   3. Redirect to /casino/blackjack/[matchId]
//
// Server-side canonical logic (match state machine, stake escrow,
// round resolution, payout) lives in
// `src/lib/blackjack-pvp/serverStore.js` — this page is a thin
// client.
// ─────────────────────────────────────────────────────────────────────────
// i18n note (previous bug):
// This lobby previously had every string hardcoded in English, so users
// on a French/Spanish locale saw an English-only page. The fix below
// wraps every visible string in `t("blackjackPvp.lobby.*", "fallback")`.
// Keys live in `src/lib/appTextTranslations.js` under en/fr/es.
// ─────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
import { motion, AnimatePresence } from "framer-motion";
import { IconBook } from "@tabler/icons-react";
import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";
import { RulesModal, useFirstVisitRules } from "../../../components/lobby/PvpLobby";
import { useSocket } from "../../../context/SocketProvider";
import { useTranslation } from "../../../hooks/useTranslation";
import {
  BLACKJACK_PVP_LOBBY_ROOM,
  BLACKJACK_PVP_MATCH_UPDATED,
  blackjackPvpMatchRoom,
} from "../../../lib/blackjack-pvp/rooms";
import { STAKE_PRESETS } from "../../../lib/blackjack-pvp/constants";

// ── Inline SVG icons (avoid importing poker/roulette icon set) ──────
// Kept in-file so this lobby doesn't pull in card-game-specific deps.
function CardIcon({ className = "" }) {
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
      {/* Spade + diamond glyph in the middle, suit of choice */}
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M9 9 L15 9" />
      <path d="M9 13 L13 13" />
      <path d="M12 17 L12 17.01" />
      <path d="M7 9 L7 17" opacity="0.55" />
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

export default function BlackjackPvpLobbyPage() {
  const { isSignedIn, user } = useUser();
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();
  // `t` returns the localized string for the given key. The 2nd string
  // argument is treated as interpolation params by the underlying
  // `appTextTranslations.js` `t()` — non-object args are ignored and
  // the raw template is returned. None of the lobby strings need
  // interpolation, so we don't pass any.
  const { t } = useTranslation();

  const [stake, setStake] = useState(50);
  const [availableMatches, setAvailableMatches] = useState<{ id: number; player1Id: string; stakeAmount: number; createdAt: string }[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [joiningId, setJoiningId] = useState<number | null>(null);
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRules, setShowRules] = useState(false);
  const firstVisitRules = useFirstVisitRules("blackjack");
  useEffect(() => {
    if (firstVisitRules) setShowRules(true);
  }, [firstVisitRules]);

  const fetchAvailable = useCallback(async () => {
    try {
      const res = await fetch("/api/blackjack-pvp/available", {
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

  // Derive any lobby the current user owns FROM the availableMatches
  // payload (which already carries the player's clerkId as
  // player1Id). This avoids exposing an /api/blackjack-pvp/my-open-match
  // route just to surface a single banner.
  const myOpenMatch = useMemo(() => {
    if (!user?.id) return null;
    return availableMatches.find((m) => m.player1Id === user.id) ?? null;
  }, [availableMatches, user?.id]);

  // Subscribe to lobby room updates.
  useEffect(() => {
    if (!socket) return;
    const refresh = () => fetchAvailable();
    socket.emit("join_room", { roomId: BLACKJACK_PVP_LOBBY_ROOM });
    socket.on("lobby:updated", refresh);
    return () => {
      socket.emit("leave_room", { roomId: BLACKJACK_PVP_LOBBY_ROOM });
      socket.off("lobby:updated", refresh);
    };
  }, [socket, fetchAvailable]);

  const createOrJoin = useCallback(
    async (stakeAmount: number) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/blackjack-pvp/create-or-join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ stakeAmount }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || t("blackjackPvp.lobby.errorStart", "Unable to start match"));
          return;
        }
        socket?.emit("room_event", {
          roomId: BLACKJACK_PVP_LOBBY_ROOM,
          event: "lobby:updated",
        });
        const matchId = data?.data?.match?.id;
        if (matchId) {
          socket?.emit("room_event", {
            roomId: blackjackPvpMatchRoom(matchId),
            event: BLACKJACK_PVP_MATCH_UPDATED,
          });
        }
        posthog?.capture("blackjack_pvp_match_created_or_joined", {
          stake: stakeAmount,
          joined: Boolean(data?.data?.joined),
          match_id: data?.data?.match?.id,
        });
        router.push(`/casino/blackjack/${data.data.match.id}`);
      } finally {
        setBusy(false);
      }
    },
    [posthog, router, socket, t],
  );

  const joinSpecific = useCallback(
    async (matchId: number) => {
      setJoiningId(matchId);
      setError(null);
      try {
        const target = availableMatches.find((m) => m.id === matchId);
        if (!target) {
          setError(t("blackjackPvp.lobby.errorNotFound", "Lobby no longer available."));
          return;
        }
        const res = await fetch("/api/blackjack-pvp/create-or-join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ stakeAmount: target.stakeAmount }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || t("blackjackPvp.lobby.errorJoin", "Unable to join match"));
          return;
        }
        socket?.emit("room_event", {
          roomId: BLACKJACK_PVP_LOBBY_ROOM,
          event: "lobby:updated",
        });
        socket?.emit("room_event", {
          roomId: blackjackPvpMatchRoom(data.data.match.id),
          event: BLACKJACK_PVP_MATCH_UPDATED,
        });
        posthog?.capture("blackjack_pvp_match_joined", {
          match_id: matchId,
          stake: target.stakeAmount,
        });
        router.push(`/casino/blackjack/${data.data.match.id}`);
      } finally {
        setJoiningId(null);
      }
    },
    [availableMatches, posthog, router, socket, t],
  );

  const cancelMyMatch = useCallback(
    async (matchId: number) => {
      setCancellingId(matchId);
      setError(null);
      try {
        const res = await fetch(
          `/api/blackjack-pvp/match/${matchId}/cancel`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
          },
        );
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || t("blackjackPvp.lobby.errorCancel", "Unable to cancel match"));
          return;
        }
        socket?.emit("room_event", {
          roomId: BLACKJACK_PVP_LOBBY_ROOM,
          event: "lobby:updated",
        });
        // The derived `myOpenMatchId` refreshes once `fetchAvailable`
        // returns, so no local state to clear here.
        fetchAvailable();
      } finally {
        setCancellingId(null);
      }
    },
    [fetchAvailable, socket, t],
  );

  // Derived from `myOpenMatch` so it's reactive to the polled lobby list.
  const myOpenMatchId = myOpenMatch?.id ?? null;

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
            <CardIcon className="w-9 h-9 sm:w-10 sm:h-10 text-yellow-300 drop-shadow-[0_0_12px_rgba(255,255,51,0.55)] flex-shrink-0" />
            <span>{t("blackjackPvp.lobby.title", "Blackjack PvP Lobby")}</span>
          </h1>
        </motion.div>
        {/* How to Play — rules modal at the top of the lobby */}
        <div className="mb-6 text-center">
          <button
            onClick={() => setShowRules(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-bold text-amber-300 transition-all duration-300 hover:bg-amber-500/20 hover:scale-105 shadow-[0_0_14px_rgba(251,191,36,0.15)]"
          >
            <IconBook size={15} /> How to Play
          </button>
        </div>
        {showRules && (
          <RulesModal
            title="How to Play"
            sections={[
              {
                heading: "Best of 3 rounds",
                body: (
                  <>
                    You and your opponent play <b>simultaneously</b> with
                    hidden hands each round. Closest to 21 without
                    busting wins the round.
                  </>
                ),
              },
              {
                heading: "First to 2 round wins",
                body: (
                  <>
                    First to <b>2 round wins</b> takes the pot, minus a
                    2.5% house fee. Ties are replayed.
                  </>
                ),
              },
              {
                heading: "Pairing",
                body: (
                  <>
                    You&apos;re paired with another player of the{" "}
                    <b>exact same</b> stake. If no one is waiting, your
                    stake is escrowed in a private lobby until someone
                    joins or you cancel.
                  </>
                ),
              },
            ]}
            onClose={() => setShowRules(false)}
          />
        )}
        {/* Description is split across 5 keys so the inline <b> spans
            line up with the changed locale strings. The leading/trailing
            fragments own the surrounding whitespace. */}
        <p className="text-center text-sm text-white/60 mt-2 mb-7 max-w-2xl mx-auto">
          {t(
            "blackjackPvp.lobby.descLead",
            "Pick a stake. We pair you with another player of the",
          )}{" "}
          <b>
            {t("blackjackPvp.lobby.descExactSame", "exact same")}
          </b>{" "}
          {t(
            "blackjackPvp.lobby.descMid",
            "token amount. Best of 3 rounds: each round, you and your opponent play",
          )}{" "}
          <b>
            {t("blackjackPvp.lobby.descSimultaneously", "simultaneously")}
          </b>{" "}
          {t(
            "blackjackPvp.lobby.descTail",
            "with hidden hands. Closest to 21 without busting wins the round. First to 2 round wins takes the pot minus a 2.5% house fee.",
          )}
        </p>

        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-[#0b224f]/70 backdrop-blur-xl border border-yellow-400/30 shadow-[0_0_30px_rgba(255,255,51,0.18)] rounded-2xl p-6"
        >
          <div className="text-center mb-5 text-sm">
            <span className="uppercase tracking-widest text-[11px] text-white/55 mr-2">
              {t("blackjackPvp.lobby.tokensLabel", "Tokens")}
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
                {/* "Your open lobby #{id} is waiting for an opponent…"
                    takes the {id} interpolation token from the i18n key. */}
                <span className="flex items-center gap-2 text-cyan-200">
                  <LoadingDotsIcon className="w-4 h-4 text-cyan-200 animate-pulse" />
                  {t("blackjackPvp.lobby.waitingMatch", {
                    id: myOpenMatchId,
                  })}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() =>
                      router.push(`/casino/blackjack/${myOpenMatchId}`)
                    }
                    className="px-3 py-1.5 rounded-lg bg-cyan-400 text-[#001933] hover:bg-cyan-300 text-xs font-bold transition"
                  >
                    {t("blackjackPvp.lobby.resume", "Resume")}
                  </button>
                  <button
                    onClick={() => cancelMyMatch(myOpenMatchId)}
                    disabled={cancellingId === myOpenMatchId}
                    className="px-3 py-1.5 rounded-lg bg-red-500/20 text-red-200 hover:bg-red-500/30 text-xs font-bold border border-red-500/30 transition disabled:opacity-50"
                  >
                    {cancellingId === myOpenMatchId
                      ? t("blackjackPvp.lobby.cancelling", "Cancelling…")
                      : t("blackjackPvp.lobby.cancel", "Cancel")}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="grid md:grid-cols-[1fr_auto_1fr] gap-3 items-end">
            <div>
              <label className="text-[11px] uppercase tracking-wider text-white/60">
                {t("blackjackPvp.lobby.stakePerPlayer", "Stake (per player)")}
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
                  min={1}
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
              disabled={
                busy || !isSignedIn || (balance ?? 0) < stake || myOpenMatchId !== null
              }
              className="p-3 rounded-xl text-base font-extrabold text-black bg-gradient-to-r from-yellow-300 to-amber-500 hover:scale-105 active:scale-95 transition shadow-[0_0_22px_rgba(255,255,51,0.55)] disabled:opacity-50 disabled:hover:scale-100 inline-flex items-center gap-2"
            >
              {busy ? (
                <>
                  <LoadingDotsIcon className="w-4 h-4 text-black animate-pulse" />
                  <span>
                    {t("blackjackPvp.lobby.findingMatch", "Finding match…")}
                  </span>
                </>
              ) : (
                <>
                  <span>{stake.toLocaleString()}</span>
                  <CoinIcon className="w-5 h-5 text-amber-900" />
                  <span>
                    {" · "}
                    {t("blackjackPvp.lobby.play", "Play")}
                  </span>
                </>
              )}
            </button>
            <div className="text-xs text-white/55 leading-relaxed">
              {/* Same lead/exact-same/tail split pattern as the
                  description above so the bold anchor lines up. */}
              {t(
                "blackjackPvp.lobby.escrowLead",
                "We pair you with another player of the",
              )}{" "}
              <b>
                {t("blackjackPvp.lobby.escrowExactSame", "exact same")}
              </b>{" "}
              {t(
                "blackjackPvp.lobby.escrowTail",
                "stake. If no one is waiting, your stake is escrowed in a private lobby until someone joins or you cancel.",
              )}
            </div>
          </div>

          {error && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-400/40 bg-red-900/30 px-3 py-2 text-sm text-red-200">
              <AlertIcon className="w-4 h-4 text-red-300" />
              <span>{error}</span>
            </div>
          )}
        </motion.div>

        <div className="mt-6 bg-[#0b224f]/85 border border-yellow-300/30 rounded-2xl p-5 shadow-[0_0_22px_rgba(255,255,51,0.16)]">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold text-yellow-300 uppercase tracking-wider flex items-center gap-2">
              <TargetIcon className="w-4 h-4 text-yellow-300" />
              {t("blackjackPvp.lobby.openLobbies", "Open Lobbies")}
            </h2>
            <button
              onClick={fetchAvailable}
              className="px-3 py-1.5 rounded-lg bg-yellow-300 text-[#001933] hover:bg-yellow-200 text-xs font-semibold shadow-[0_0_10px_rgba(255,255,51,0.45)] transition inline-flex items-center gap-1.5"
            >
              <RefreshIcon className="w-3.5 h-3.5 text-[#001933]" />
              {t("blackjackPvp.lobby.refresh", "Refresh")}
            </button>
          </div>
          {availableMatches.filter((m) => m.id !== myOpenMatchId).length === 0 ? (
            <div className="text-sm text-white/60 flex items-center gap-2">
              <TrophyIcon className="w-4 h-4 text-white/40" />
              <span>
                {t(
                  "blackjackPvp.lobby.empty",
                  "No open lobbies yet. Be the first to make one.",
                )}
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
                      className="flex items-center justify-between rounded-xl bg-[#08142f]/80 p-3 border border-yellow-300/20 hover:border-yellow-300/40 transition"
                    >
                      <div>
                        <p className="text-sm font-semibold">
                          {t("blackjackPvp.lobby.lobbyId", { id: m.id })}
                          <span className="ml-2 text-[10px] text-white/40">
                            {t("blackjackPvp.lobby.hostId", { id: hostShort })}
                          </span>
                        </p>
                        <p className="text-xs text-white/60 mt-0.5 flex items-center gap-1">
                          <span>
                            {t("blackjackPvp.lobby.stakeLabel", "Stake:")}
                          </span>
                          <span className="text-yellow-300 font-semibold inline-flex items-center gap-1">
                            {Number(m.stakeAmount).toLocaleString()}
                            <CoinIcon className="w-3.5 h-3.5 text-yellow-300" />
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
                            <LoadingDotsIcon className="w-3.5 h-3.5 text-[#001933] animate-pulse" />
                            <span>
                              {t("blackjackPvp.lobby.joining", "Joining…")}
                            </span>
                          </>
                        ) : (
                          t("blackjackPvp.lobby.join", "Join")
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
