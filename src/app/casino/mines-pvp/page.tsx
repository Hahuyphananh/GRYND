"use client";

// src/app/casino/mines-pvp/page.tsx
//
// LOBBY page for the Mines PvP ("Mines Duel") match system. The
// pickTile / end-state / payout logic lives in
// `src/lib/mines-pvp/serverStore.js`; this page is a thin client.
//
// Flow:
//   1. Pick a stake (preset chips or custom).
//   2. Pick a mine count (host-only — the joiner inherits whatever
//      the host chose when they created the lobby).
//   3. Hit Play → POST /api/mines-pvp/create-or-join
//        • matches on stake equality (server-authoritative)
//        • escrow stake on success
//        • board generated at match creation
//   4. Redirect to /casino/mines-pvp/[matchId]
//
// The open-lobbies list shows each waiting match with its host-
// chosen mine count so the joiner knows what they're signing up
// for. Joiners can't override the mine count — that decision is
// the host's alone.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
import { motion, AnimatePresence } from "framer-motion";
import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";
import { useSocket } from "../../../context/SocketProvider";
import {
  MINES_PVP_LOBBY_ROOM,
  MINES_PVP_MATCH_UPDATED,
  minesPvpMatchRoom,
} from "../../../lib/mines-pvp/rooms";
import {
  STAKE_PRESETS,
  MIN_MINES,
  MAX_MINES,
} from "../../../lib/mines-pvp/constants";

// Mine-count presets offered to the host in the lobby. Mirrors the
// preset chip row on the solo mines page (`src/app/casino/mines/
// page.jsx`) so players don't have to re-learn the UX.
const MINES_PRESETS = [1, 3, 5, 10, 15, 20];

// Type for a single open-matches list entry returned by
// /api/mines-pvp/available.
type AvailableMatch = {
  id: number;
  player1Id: string;
  stakeAmount: number;
  minesCount: number;
  createdAt: string;
};

// ── Inline SVG icons (kept in-file so this lobby doesn't pull in
// other game-specific icon sets) ─────────────────────────────────────

function MineIcon({ className = "" }: { className?: string }) {
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
      {/* Round bomb with fuse */}
      <circle cx="12" cy="14" r="7" />
      <path d="M14 7 L17 4" />
      <path d="M16 4 L18 4 L18 6" />
      {/* Spark on the fuse */}
      <circle cx="18" cy="4" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CoinIcon({ className = "" }: { className?: string }) {
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

function TargetIcon({ className = "" }: { className?: string }) {
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

function RefreshIcon({ className = "" }: { className?: string }) {
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

function TrophyIcon({ className = "" }: { className?: string }) {
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

function LoadingDotsIcon({ className = "" }: { className?: string }) {
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

function AlertIcon({ className = "" }: { className?: string }) {
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

export default function MinesPvpLobbyPage() {
  const { isSignedIn, user } = useUser();
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();

  // ── Form state ────────────────────────────────────────────────────
  const [stake, setStake] = useState<number>(50);
  const [minesCount, setMinesCount] = useState<number>(3);

  // ── Lobby state ───────────────────────────────────────────────────
  const [availableMatches, setAvailableMatches] = useState<AvailableMatch[]>(
    [],
  );
  const [balance, setBalance] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [joiningId, setJoiningId] = useState<number | null>(null);
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Fetch helpers ────────────────────────────────────────────────
  const fetchAvailable = useCallback(async () => {
    try {
      const res = await fetch("/api/mines-pvp/available", {
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
  // payload (which carries the player's clerkId as player1Id). This
  // avoids an /api/mines-pvp/my-open-match route just to surface a
  // single banner.
  const myOpenMatch = useMemo<AvailableMatch | null>(() => {
    if (!user?.id) return null;
    return availableMatches.find((m) => m.player1Id === user.id) ?? null;
  }, [availableMatches, user?.id]);

  // Subscribe to lobby room updates. The realtime-server routes
  // `room_event` payloads to the matching socket.io room; the
  // generic event name is `lobby:updated` (mirrors the
  // MINES_PVP_MATCH_UPDATED event used by the match view).
  useEffect(() => {
    if (!socket) return;
    const refresh = () => fetchAvailable();
    socket.emit("join_room", { roomId: MINES_PVP_LOBBY_ROOM });
    socket.on(MINES_PVP_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId: MINES_PVP_LOBBY_ROOM });
      socket.off(MINES_PVP_MATCH_UPDATED, refresh);
    };
  }, [socket, fetchAvailable]);

  // ── Action handlers ──────────────────────────────────────────────

  // Create OR join — server's createOrJoin picks the right path
  // based on whether an open lobby with this stake already exists.
  // When CREATING, minesCount is included; when JOINING, the host's
  // mine count is used (minesCount is ignored by the server in the
  // join path).
  const createOrJoin = useCallback(
    async (stakeAmount: number, chosenMines: number) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/mines-pvp/create-or-join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ stakeAmount, minesCount: chosenMines }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Unable to start match");
          return;
        }
        socket?.emit("room_event", {
          roomId: MINES_PVP_LOBBY_ROOM,
          event: MINES_PVP_MATCH_UPDATED,
        });
        const matchId = data?.data?.match?.id;
        if (matchId) {
          socket?.emit("room_event", {
            roomId: minesPvpMatchRoom(matchId),
            event: MINES_PVP_MATCH_UPDATED,
          });
        }
        posthog?.capture("mines_pvp_match_created_or_joined", {
          stake: stakeAmount,
          mines: chosenMines,
          joined: Boolean(data?.data?.joined),
          match_id: data?.data?.match?.id,
        });
        router.push(`/casino/mines-pvp/${data.data.match.id}`);
      } finally {
        setBusy(false);
      }
    },
    [posthog, router, socket],
  );

  // Join a specific lobby from the open-lobbies list. The host's
  // mine count is read from the list payload so the joiner sees what
  // they're agreeing to before they click.
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
        const res = await fetch("/api/mines-pvp/create-or-join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          // minesCount is IGNORED by the server in the join path
          // (the host's count is locked at lobby creation), but we
          // pass it through for telemetry parity.
          body: JSON.stringify({
            stakeAmount: target.stakeAmount,
            minesCount: target.minesCount,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Unable to join match");
          return;
        }
        socket?.emit("room_event", {
          roomId: MINES_PVP_LOBBY_ROOM,
          event: MINES_PVP_MATCH_UPDATED,
        });
        socket?.emit("room_event", {
          roomId: minesPvpMatchRoom(data.data.match.id),
          event: MINES_PVP_MATCH_UPDATED,
        });
        posthog?.capture("mines_pvp_match_joined", {
          match_id: matchId,
          stake: target.stakeAmount,
          mines: target.minesCount,
        });
        router.push(`/casino/mines-pvp/${data.data.match.id}`);
      } finally {
        setJoiningId(null);
      }
    },
    [availableMatches, posthog, router, socket],
  );

  // Cancel a lobby the current user owns. Only valid while the
  // match is in `waiting` — the server returns 400 otherwise.
  const cancelMyMatch = useCallback(
    async (matchId: number) => {
      setCancellingId(matchId);
      setError(null);
      try {
        const res = await fetch(
          `/api/mines-pvp/match/${matchId}/cancel`,
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
          roomId: MINES_PVP_LOBBY_ROOM,
          event: MINES_PVP_MATCH_UPDATED,
        });
        posthog?.capture("mines_pvp_lobby_cancelled", {
          match_id: matchId,
        });
        // The derived `myOpenMatchId` refreshes once `fetchAvailable`
        // returns, so no local state to clear here.
        fetchAvailable();
      } finally {
        setCancellingId(null);
      }
    },
    [fetchAvailable, socket, posthog],
  );

  // Derived from `myOpenMatch` so it's reactive to the polled lobby list.
  const myOpenMatchId = myOpenMatch?.id ?? null;

  // ── Validation ────────────────────────────────────────────────────
  // Pre-flight guards: minesCount in [1, 24] (per constants) and
  // stake within the user's balance. The server re-validates both
  // but catching them client-side avoids a 400 round-trip.
  const minesCountValid =
    Number.isInteger(minesCount) && minesCount >= MIN_MINES && minesCount <= MAX_MINES;
  const stakeValid = stake > 0 && (balance === null || balance >= stake);
  const canCreate = isSignedIn && !busy && minesCountValid && stakeValid && myOpenMatchId === null;

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
            <MineIcon className="w-9 h-9 sm:w-10 sm:h-10 text-cyan-300 drop-shadow-[0_0_12px_rgba(0,229,255,0.65)] flex-shrink-0" />
            <span>Mines Duel Lobby</span>
          </h1>
        </motion.div>
        <p className="text-center text-sm text-white/60 mt-2 mb-7 max-w-2xl mx-auto">
          You and your opponent share the <b>same 5×5 board</b>. The host
          picks the mine count; the server rolls the layout. Each player
          gets <b>20 seconds</b> to click one tile — mine means you
          lose, safe means you keep your stake in play. Both picks in
          → winner takes 1.9× their stake, house takes 0.1×.
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
                      router.push(`/casino/mines-pvp/${myOpenMatchId}`)
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

          <div className="grid md:grid-cols-[1.1fr_auto_1fr] gap-3 items-end">
            {/* Wager (stake) + Mine-count pickers side-by-side.
                Mirrors the roulette lobby's single-picker footprint
                so the overall card height matches the roulette lobby
                — the user complained the stacked layout left too much
                unused vertical space. On mobile (< sm) the two pickers
                stack vertically; from sm upward they sit side-by-side. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {/* Wager (stake) picker — host & joiner both pay this */}
              <div>
                <label className="text-[10px] uppercase tracking-wider text-white/60 font-semibold">
                  Wager
                </label>
                <div className="mt-1 flex flex-wrap gap-1">
                  {STAKE_PRESETS.map((v) => (
                    <button
                      key={v}
                      onClick={() => setStake(v)}
                      className={`px-2.5 py-1 rounded-full text-[11px] font-bold border transition ${
                        stake === v
                          ? "bg-cyan-300 text-black border-cyan-300 shadow-[0_0_8px_rgba(0,229,255,0.7)]"
                          : "bg-[#08142f] text-cyan-200/80 border-cyan-300/30 hover:bg-cyan-300/15"
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
                  className="mt-1.5 w-full rounded-md bg-[#020617] border border-cyan-300/30 focus:border-cyan-300 outline-none px-2 py-1.5 text-white text-xs"
                />
              </div>
              {/* Mine-count picker — host-only at create time */}
              <div>
                <label className="text-[10px] uppercase tracking-wider text-white/60 font-semibold">
                  Mines <span className="text-fuchsia-300/70 font-normal normal-case tracking-normal">(host)</span>
                </label>
                <div className="mt-1 flex flex-wrap gap-1">
                  {MINES_PRESETS.map((v) => (
                    <button
                      key={v}
                      onClick={() => setMinesCount(v)}
                      className={`px-2.5 py-1 rounded-full text-[11px] font-bold border transition ${
                        minesCount === v
                          ? "bg-fuchsia-400 text-black border-fuchsia-400 shadow-[0_0_8px_rgba(217,70,239,0.7)]"
                          : "bg-[#08142f] text-fuchsia-200/80 border-fuchsia-300/30 hover:bg-fuchsia-300/15"
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  min={MIN_MINES}
                  max={MAX_MINES}
                  value={minesCount}
                  onChange={(e) =>
                    setMinesCount(
                      Math.max(
                        MIN_MINES,
                        Math.min(MAX_MINES, Number(e.target.value) || 0),
                      ),
                    )
                  }
                  className="mt-1.5 w-full rounded-md bg-[#020617] border border-fuchsia-300/30 focus:border-fuchsia-300 outline-none px-2 py-1.5 text-white text-xs"
                />
                <p className="text-[9px] text-white/40 mt-1 leading-tight">
                  Range {MIN_MINES}–{MAX_MINES}. Joiners inherit.
                </p>
              </div>
            </div>

            <button
              onClick={() => {
                posthog?.capture("mines_pvp_lobby_create_clicked", {
                  stake,
                  mines: minesCount,
                });
                createOrJoin(stake, minesCount);
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
              private lobby with your chosen mine count until someone
              joins or you cancel.
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
          {availableMatches.filter((m) => m.id !== myOpenMatchId).length === 0 ? (
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
                      <p className="text-sm font-semibold">
                        Lobby #{m.id}
                        <span className="ml-2 text-[10px] text-white/40">
                          host #{m.player1Id?.slice(0, 6) ?? "?"}…
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
                        <span className="inline-flex items-center gap-1">
                          <span>Mines:</span>
                          <span className="text-fuchsia-300 font-semibold inline-flex items-center gap-1">
                            {m.minesCount}
                            <MineIcon className="w-3.5 h-3.5 text-fuchsia-300" />
                          </span>
                        </span>
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        posthog?.capture("mines_pvp_lobby_join_clicked", {
                          match_id: m.id,
                          stake: m.stakeAmount,
                          mines: m.minesCount,
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
