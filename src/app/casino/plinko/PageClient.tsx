"use client";

// src/app/casino/plinko/page.tsx
//
// LOBBY page for the Plinko Duel PvP match system. The
// matchmaking / launch / payout logic lives in
// `src/lib/plinko-pvp/serverStore.js`; this page is a thin client.
//
// Flow:
//   1. Pick a stake (preset chips or custom).
//   2. Hit Play → POST /api/plinko-pvp/create-or-join
//        • matches on stake equality (server-authoritative)
//        • escrow stake on success
//        • server rolls the deterministic per-ball seeds at match
//          creation so an admin can replay any ball's trajectory
//   3. Redirect to /casino/plinko/[matchId]
//
// Unlike Mines Duel there's no host-picked game param (mine count)
// — the only player input at create time is the stake. The joiner
// just consumes whatever stake the host picked.
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
  PLINKO_PVP_LOBBY_ROOM,
  PLINKO_PVP_MATCH_UPDATED,
  plinkoPvpMatchRoom,
} from "../../../lib/plinko-pvp/rooms";
import { STAKE_PRESETS } from "../../../lib/plinko-pvp/constants";

// Type for a single open-matches list entry returned by
// /api/plinko-pvp/available. Matches the API route's normalised
// shape exactly so the lobby page can render directly without a
// transform layer.
type AvailableMatch = {
  id: number;
  player1Id: string;
  stakeAmount: number;
  createdAt: string;
  // Surface host display name + avatar so the lobby shows real player
  // heads instead of clerkId truncation. Populated server-side via
  // enrichMatchesWithUsers in src/lib/plinko-pvp/serverStore.js.
  hostName?: string;
  hostProfileImageUrl?: string | null;
};

// ── Inline SVG icon (kept in-file so this lobby doesn't pull in
// other game-specific icon sets) ─────────────────────────────────────

function PlinkoIcon({ className = "" }: { className?: string }) {
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
      {/* Triangular peg grid */}
      <path d="M12 3 L4 16 L20 16 Z" opacity="0.35" />
      {/* Peg dots */}
      <circle cx="12" cy="9" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="10" cy="12" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="14" cy="12" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="8" cy="15" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="12" cy="15" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="16" cy="15" r="0.7" fill="currentColor" stroke="none" />
      {/* Ball at the bottom */}
      <circle cx="12" cy="20" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function PlinkoPvpLobbyPage() {
  const { isSignedIn, user } = useUser();
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();

  // ── Form state ────────────────────────────────────────────────────
  const [stake, setStake] = useState<number>(50);

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
      const res = await fetch("/api/plinko-pvp/available", {
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
  // avoids an /api/plinko-pvp/my-open-match route just to surface a
  // single banner.
  const myOpenMatch = useMemo<AvailableMatch | null>(() => {
    if (!user?.id) return null;
    return availableMatches.find((m) => m.player1Id === user.id) ?? null;
  }, [availableMatches, user?.id]);

  // Subscribe to lobby room updates. The realtime-server routes
  // `room_event` payloads to the matching socket.io room; the
  // generic event name is `lobby:updated` (mirrors the
  // PLINKO_PVP_MATCH_UPDATED event used by the match view).
  //
  // Note: per task 6's design decision, the broadcast helper does
  // NOT emit to PLINKO_PVP_LOBBY_ROOM (only to the per-match
  // room) — the lobby page refreshes its open-lobbies list via
  // the /available polling endpoint instead. The subscription
  // here is kept as a no-op safety net in case a future change
  // adds lobby fan-out.
  useEffect(() => {
    if (!socket) return;
    const refresh = () => fetchAvailable();
    socket.emit("join_room", { roomId: PLINKO_PVP_LOBBY_ROOM });
    socket.on(PLINKO_PVP_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId: PLINKO_PVP_LOBBY_ROOM });
      socket.off(PLINKO_PVP_MATCH_UPDATED, refresh);
    };
  }, [socket, fetchAvailable]);

  // ── Action handlers ──────────────────────────────────────────────

  // Create OR join — server's createOrJoin picks the right path
  // based on whether an open lobby with this stake already exists.
  const createOrJoin = useCallback(
    async (stakeAmount: number) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/plinko-pvp/create-or-join", {
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
        // Best-effort fan-out to the per-match room so the opponent
        // (if they're already sitting on the match view) sees the
        // status flip without waiting for the next poll. The
        // realtime-server's generic room_event handler routes the
        // payload identically to MINES_PVP / BLACKJACK_PVP.
        socket?.emit("room_event", {
          roomId: plinkoPvpMatchRoom(data.data.match.id),
          event: PLINKO_PVP_MATCH_UPDATED,
        });
        posthog?.capture("plinko_pvp_match_created_or_joined", {
          stake: stakeAmount,
          joined: Boolean(data?.data?.joined),
          match_id: data?.data?.match?.id,
        });
        router.push(`/casino/plinko/${data.data.match.id}`);
      } finally {
        setBusy(false);
      }
    },
    [posthog, router, socket],
  );

  // Join a specific lobby from the open-lobbies list. The stake is
  // read from the list payload so the joiner sees what they're
  // agreeing to before they click.
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
        const res = await fetch("/api/plinko-pvp/create-or-join", {
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
          roomId: plinkoPvpMatchRoom(data.data.match.id),
          event: PLINKO_PVP_MATCH_UPDATED,
        });
        posthog?.capture("plinko_pvp_match_joined", {
          match_id: matchId,
          stake: target.stakeAmount,
        });
        router.push(`/casino/plinko/${data.data.match.id}`);
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
          `/api/plinko-pvp/match/${matchId}/cancel`,
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
          roomId: plinkoPvpMatchRoom(matchId),
          event: PLINKO_PVP_MATCH_UPDATED,
        });
        posthog?.capture("plinko_pvp_lobby_cancelled", {
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
  // Pre-flight guards: stake > 0 and within the user's balance. The
  // server re-validates both but catching them client-side avoids a
  // 400 round-trip.
  const stakeValid = stake > 0 && (balance === null || balance >= stake);
  const canCreate =
    isSignedIn && !busy && stakeValid && myOpenMatchId === null;

  return (
    <PvpLobbyPage
      title="Plinko Duel Lobby"
      subtitle={
        <>
          You and your opponent each launch <b>3 balls</b> through the
          same 19-row peg field. Pick your <b>start x / power / angle</b>
          before each ball commits. The server runs the deterministic
          physics simulation and tallies the scores. Highest aggregate
          takes <b>1.9× their stake</b>, house takes 0.1×. AFK balls
          auto-launch with safe mid-board inputs.
        </>
      }
      icon={
        <PlinkoIcon className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />
      }
      rulesKey="plinko"
      rules={{
        title: "How to Play",
        sections: [
          {
            heading: "Launch 3 balls",
            body: (
              <>
                You and your opponent each launch <b>3 balls</b> through
                the same 19-row peg field, picking <b>start x / power /
                angle</b> before each ball commits.
              </>
            ),
          },
          {
            heading: "Same physics for both",
            body: (
              <>
                The server runs the same deterministic physics
                simulation for both players. The higher aggregate score
                wins.
              </>
            ),
          },
          {
            heading: "Payout & AFK",
            body: (
              <>
                Highest aggregate takes <b>1.9× their stake</b>, house
                takes 0.1×. AFK balls auto-launch with safe mid-board
                inputs.
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
        posthog?.capture("plinko_pvp_lobby_create_clicked", {
          stake,
        });
        createOrJoin(stake);
      }}
      canPlay={canCreate}
      escrowNote={
        <>
          We pair you with another player of the <b>exact same</b> stake.
          If no one is waiting, your stake is escrowed in a private lobby
          until someone joins or you cancel. The server rolls the
          per-ball seeds at match creation so every ball is replayable
          for audit.
        </>
      }
      error={error}
      lobbies={availableMatches}
      lobbyEmptyText="No open lobbies yet. Be the first to make one."
      lobbyTitle={(m) => (
        <span className="inline-flex items-center gap-2">
          <span>Lobby #{m.id}</span>
          <span className="text-[10px] text-white/60 inline-flex items-center gap-1.5">
            {m.hostProfileImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={m.hostProfileImageUrl}
                alt=""
                className="h-4 w-4 rounded-full border border-cyan-500/40"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            ) : (
              <span className="flex h-4 w-4 items-center justify-center rounded-full border border-cyan-500/40 bg-cyan-500/20 text-[9px] font-black uppercase">
                {(m.hostName ?? "?").slice(0, 1)}
              </span>
            )}
            <span>{m.hostName ?? m.player1Id?.slice(0, 6) + "..."}</span>
          </span>
        </span>
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
          <span className="text-white/40">· 3 balls · 20s/ball</span>
        </span>
      )}
      onJoin={(l) => {
        posthog?.capture("plinko_pvp_lobby_join_clicked", {
          match_id: l.id,
          stake: l.stakeAmount,
        });
        joinSpecific(l.id);
      }}
      joinBusyId={joiningId}
      onRefresh={fetchAvailable}
      myOpenId={myOpenMatchId}
      onResume={(id) => router.push(`/casino/plinko/${id}`)}
      onCancel={(id) => cancelMyMatch(id)}
      cancelling={cancellingId === myOpenMatchId}
    />
  );
}
