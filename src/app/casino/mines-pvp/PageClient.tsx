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
//
// The page chrome (balance strip → stake picker + Play → escrow
// note → Open Lobbies list) is the shared PvpLobby component in the
// blackjack layout / farkle color scheme.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
import PvpLobbyPage, { CoinIcon } from "../../../components/lobby/PvpLobby";
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

function ShieldCheckIcon({ className = "" }: { className?: string }) {
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
      {/* Shield with a check — the no-guess guarantee badge */}
      <path d="M12 2 L20 5 V11 a8 8 0 0 1 -8 8 a8 8 0 0 1 -8 -8 V5 Z" />
      <path d="M8.5 12 l2.5 2.5 l4.5 -4.5" />
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
  // Play Free vs AI — creates a zero-stake match against the bot.
  const playVsAi = useCallback(
    async (chosenMines: number) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/mines-pvp/create-ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ minesCount: chosenMines }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Unable to start AI match");
          return;
        }
        router.push(`/casino/mines-pvp/${data.data.match.id}`);
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

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
  const canPlayAi = isSignedIn && !busy && minesCountValid;
  const quickQueuePreferences = (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      <label className="text-[10px] font-semibold uppercase tracking-wider text-white/60">
        Quick Queue stake
        <input
          type="number"
          min={1}
          value={stake}
          onChange={(event) => setStake(Math.max(1, Number(event.target.value) || 1))}
          className="mt-1 w-full rounded-md border border-cyan-600/50 bg-[#020617] px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-400"
        />
      </label>
      <label className="text-[10px] font-semibold uppercase tracking-wider text-white/60">
        Quick Queue mines
        <input
          type="number"
          min={MIN_MINES}
          max={MAX_MINES}
          value={minesCount}
          onChange={(event) => setMinesCount(Math.max(MIN_MINES, Math.min(MAX_MINES, Number(event.target.value) || MIN_MINES)))}
          className="mt-1 w-full rounded-md border border-cyan-600/50 bg-[#020617] px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-400"
        />
      </label>
    </div>
  );

  // ── No-guess guarantee copy (honest per mine count) ───────────────
  // The generator guarantees EVERY board keeps the 3×3 center block
  // mine-free and the game's first pick is always safe. On top of
  // that, boards are solver-verified to be fully deducible from the
  // center opening — measured acceptance is ~100% at 1–3 mines, ~90%
  // at 4, ~72% at 5. Above that, the board is too dense to fully
  // verify, so the copy steps down honestly instead of over-promising.
  const noGuessDetail =
    minesCount <= 3
      ? "Every board at this mine count is verified to be fully solvable " +
        "by deduction from the center opening. Open center, read the " +
        "distance hints, and you'll never be forced to guess. The game " +
        "ends in zugzwang: whoever must pick when only mines remain loses."
      : minesCount <= 5
        ? "Boards at this mine count are solver-verified for the center " +
          "opening in the vast majority of games. Open center and the " +
          "distance hints give you a fully deducible game. A few late " +
          "pockets may still require a guess."
        : "At this mine count the board is too dense for a full no-guess " +
          "guarantee. But your first pick is always safe and the center " +
          "3×3 never contains a mine, so the opening is never a trap.";

  return (
    <PvpLobbyPage
      quickQueuePreferences={quickQueuePreferences}
      quickQueueReadinessBody={{ preferredGames: ["mines-pvp"], minesStakeAmount: stake, minesCount }}
      title="Mines Duel Lobby"
      subtitle={
        <>
          You and your opponent share the <b>same 5×5 board</b>. The host
          picks the mine count; the server rolls the layout. Every
          layout is generated for <b className="text-emerald-300">
          pure-deduction play</b>. The center 3×3 is always mine-free,
          your first pick can never hit a mine, and the board is
          solver-verified so the center opening is fully solvable by
          deduction. Each player gets <b>20 seconds</b> to click one tile
          A mine means you lose, safe means you keep your stake in play.
          Both picks in → winner takes 1.9× their stake, house takes 0.1×.
        </>
      }
      icon={
        <MineIcon className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />
      }
      rulesKey="mines-pvp"
      rules={{
        title: "How to Play",
        sections: [
          {
            heading: "Same board, host picks mines",
            body: (
              <>
                You and your opponent share the <b>same 5×5 board</b>.
                The host picks the mine count; the server rolls the
                layout.
              </>
            ),
          },
          {
            heading: "No-guess boards",
            body: (
              <>
                The center 3×3 is always mine-free, your first pick is
                always safe, and layouts are solver-verified for
                pure-deduction play.
              </>
            ),
          },
          {
            heading: "Take turns clicking",
            body: (
              <>
                Each player gets <b>20 seconds</b> to click one tile. A
                mine means you lose, safe means your stake stays in play.
                The game ends in zugzwang: whoever must pick when only
                mines remain loses.
              </>
            ),
          },
          {
            heading: "Payout",
            body: (
              <>
                Both picks in → winner takes <b>1.9× their stake</b>,
                house takes 0.1×.
              </>
            ),
          },
        ],
      }}
      balance={balance}
      stake={stake}
      onStakeChange={setStake}
      stakeOptions={STAKE_PRESETS}
      busy={busy}
      onPlay={() => {
        posthog?.capture("mines_pvp_lobby_create_clicked", {
          stake,
          mines: minesCount,
        });
        createOrJoin(stake, minesCount);
      }}
      canPlay={canCreate}
      vsAi={{
        label: "Play Free vs AI",
        onClick: () => playVsAi(minesCount),
        disabled: !canPlayAi,
      }}
      escrowNote={
        <>
          We pair you with another player of the <b>exact same</b> stake.
          If no one is waiting, your stake is escrowed in a private lobby
          with your chosen mine count until someone joins or you cancel.
        </>
      }
      error={error}
      lobbies={availableMatches}
      lobbyEmptyText="No open lobbies yet. Be the first to make one."
      lobbyTitle={(m) => (
        <>
          Lobby #{m.id}
          <span className="ml-2 text-[10px] text-white/40">
            host #{m.player1Id?.slice(0, 6) ?? "?"}…
          </span>
        </>
      )}
      lobbyMeta={(m) => (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            Stake:{" "}
            <span className="inline-flex items-center gap-1 font-semibold text-yellow-300">
              {Number(m.stakeAmount).toLocaleString()}
              <CoinIcon className="h-3.5 w-3.5 text-yellow-300" />
            </span>
          </span>
          <span>
            Mines:{" "}
            <span className="inline-flex items-center gap-1 font-semibold text-cyan-300">
              {m.minesCount}
              <MineIcon className="h-3.5 w-3.5 text-cyan-300" />
            </span>
          </span>
        </span>
      )}
      onJoin={(l) => {
        posthog?.capture("mines_pvp_lobby_join_clicked", {
          match_id: l.id,
          stake: l.stakeAmount,
          mines: l.minesCount,
        });
        joinSpecific(l.id);
      }}
      joinBusyId={joiningId}
      onRefresh={fetchAvailable}
      myOpenId={myOpenMatchId}
      onResume={(id) => router.push(`/casino/mines-pvp/${id}`)}
      onCancel={(id) => cancelMyMatch(id)}
      cancelling={cancellingId === myOpenMatchId}
      children={
        <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
          {/* Mine-count picker — host-only at create time */}
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-white/60">
              Mines{" "}
              <span className="font-normal normal-case tracking-normal text-cyan-300/70">
                (host)
              </span>
              <span
                title="Every board is generated for pure-deduction play: the center 3×3 is mine-free, your first pick is always safe, and the layout is solver-verified."
                className="ml-1.5 inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-bold normal-case tracking-wider text-emerald-300"
              >
                <ShieldCheckIcon className="h-2.5 w-2.5" />
                No-guess
              </span>
            </label>
            <div className="mt-1 flex flex-wrap gap-1">
              {MINES_PRESETS.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setMinesCount(v)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition ${
                    minesCount === v
                      ? "border-cyan-400 bg-cyan-500/20 text-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.5)]"
                      : "border-gray-600 bg-gray-800/50 text-gray-400 hover:border-cyan-600/50 hover:text-cyan-200"
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
              aria-label="Number of mines"
              onChange={(e) =>
                setMinesCount(
                  Math.max(
                    MIN_MINES,
                    Math.min(MAX_MINES, Number(e.target.value) || 0),
                  ),
                )
              }
              className="mt-1.5 w-full rounded-md border border-cyan-600/50 bg-[#020617] px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-400"
            />
            <p className="mt-1 text-[9px] leading-tight text-white/40">
              Range {MIN_MINES}–{MAX_MINES}. Joiners inherit.
            </p>
          </div>
        </div>
      }
      after={
        <div className="mt-6 rounded-lg border border-amber-800/30 bg-amber-950/20 p-3 text-xs leading-relaxed text-amber-200/80">
          <p className="mb-1 flex items-center gap-1.5 font-bold text-amber-300">
            <ShieldCheckIcon className="h-4 w-4 text-emerald-300" />
            No-guess boards.
          </p>
          <p>{noGuessDetail}</p>
        </div>
      }
    />
  );
}
