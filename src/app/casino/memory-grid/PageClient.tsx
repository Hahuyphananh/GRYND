"use client";

// src/app/casino/memory-grid/page.tsx
//
// LOBBY page for the Memory Grid match system. The flip / end-state /
// payout logic lives in `src/lib/memory-grid/serverStore.js`; this
// page is a thin client.
//
// Flow:
//   1. Pick a stake (preset chips or custom).
//   2. Hit Play → POST /api/memory-grid/create-or-join
//        • matches on stake equality (server-authoritative)
//        • escrow stake on success
//        • 4×4 card grid generated at match creation
//   3. Redirect to /casino/memory-grid/[matchId]
//
// The page chrome (balance strip → stake picker + Play → escrow
// note → Open Lobbies list) is the shared PvpLobby component in the
// blackjack layout / farkle color scheme — identical to the other
// PvP skill games.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import { useSocket } from "../../../context/SocketProvider";
import {
  MEMORY_GRID_LOBBY_ROOM,
  MEMORY_GRID_MATCH_UPDATED,
  memoryGridMatchRoom,
} from "../../../lib/memory-grid/rooms";
import { STAKE_PRESETS } from "../../../lib/memory-grid/constants";

// Type for a single open-matches list entry returned by
// /api/memory-grid/available. `hostName`/`hostProfileImageUrl` come
// from the server's user enrichment so rows show real player heads
// (mirrors plinko-pvp / keno-pvp lobby rows).
type AvailableMatch = {
  id: number;
  player1Id: string;
  stakeAmount: number;
  createdAt: string;
  hostName?: string | null;
  hostProfileImageUrl?: string | null;
};

// ── Inline SVG icons (kept in-file so this lobby doesn't pull in
// other game-specific icon sets) ─────────────────────────────────────

function MemoryGridIcon({ className = "" }: { className?: string }) {
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
      {/* 4×4 card grid — one card flipped face-up with a spark */}
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      {/* Face-up card content */}
      <circle cx="17.5" cy="17.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function MemoryGridLobbyPage() {
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
      const res = await fetch("/api/memory-grid/available", {
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
  // payload (which carries the player's clerkId as player1Id).
  const myOpenMatch = useMemo<AvailableMatch | null>(() => {
    if (!user?.id) return null;
    return availableMatches.find((m) => m.player1Id === user.id) ?? null;
  }, [availableMatches, user?.id]);

  // Subscribe to lobby room updates. The realtime-server routes
  // `room_event` payloads to the matching socket.io room; the
  // generic event name is `lobby:updated`.
  useEffect(() => {
    if (!socket) return;
    const refresh = () => fetchAvailable();
    socket.emit("join_room", { roomId: MEMORY_GRID_LOBBY_ROOM });
    socket.on(MEMORY_GRID_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId: MEMORY_GRID_LOBBY_ROOM });
      socket.off(MEMORY_GRID_MATCH_UPDATED, refresh);
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
        const res = await fetch("/api/memory-grid/create-or-join", {
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
          roomId: MEMORY_GRID_LOBBY_ROOM,
          event: MEMORY_GRID_MATCH_UPDATED,
        });
        const matchId = data?.data?.match?.id;
        if (matchId) {
          socket?.emit("room_event", {
            roomId: memoryGridMatchRoom(matchId),
            event: MEMORY_GRID_MATCH_UPDATED,
          });
        }
        posthog?.capture("memory_grid_match_created_or_joined", {
          stake: stakeAmount,
          joined: Boolean(data?.data?.joined),
          match_id: data?.data?.match?.id,
        });
        router.push(`/casino/memory-grid/${data.data.match.id}`);
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
        const res = await fetch("/api/memory-grid/create-or-join", {
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
          roomId: MEMORY_GRID_LOBBY_ROOM,
          event: MEMORY_GRID_MATCH_UPDATED,
        });
        socket?.emit("room_event", {
          roomId: memoryGridMatchRoom(data.data.match.id),
          event: MEMORY_GRID_MATCH_UPDATED,
        });
        posthog?.capture("memory_grid_match_joined", {
          match_id: matchId,
          stake: target.stakeAmount,
        });
        router.push(`/casino/memory-grid/${data.data.match.id}`);
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
          `/api/memory-grid/match/${matchId}/cancel`,
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
          roomId: MEMORY_GRID_LOBBY_ROOM,
          event: MEMORY_GRID_MATCH_UPDATED,
        });
        posthog?.capture("memory_grid_lobby_cancelled", {
          match_id: matchId,
        });
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
  const stakeValid = stake > 0 && (balance === null || balance >= stake);
  const canCreate = isSignedIn && !busy && stakeValid && myOpenMatchId === null;

  return (
    <PvpLobbyPage
      title="Memory Grid Lobby"
      subtitle={
        <>
          A <b>best-of-5 rounds</b> pattern duel. Pure memory, no
          symbols or tricks. Each round deals an <b>N×N grid</b>
          (growing 3×3 → 5×5) with a handful of <b>lit tiles</b>. You
          get a few seconds to memorize the pattern, then you
          reconstruct it from memory. More tiles right wins the
          round; after 5 rounds the higher <b>total score</b> wins
          the pot. <b>1.9×</b>, house takes 0.1×. Equal → full
          refund.
        </>
      }
      icon={
        <MemoryGridIcon className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />
      }
      rulesKey="memory-grid"
      rules={{
        title: "How to Play",
        sections: [
          {
            heading: "Best of 5 rounds",
            body: (
              <>
                A match is <b>exactly 5 rounds</b> and the difficulty
                grows: 3×3 grid with 3 lit tiles, 4×4 with 5, 4×4 with
                7, 5×5 with 10, and a final 5×5 with                <b>14 lit
                tiles</b>. More tiles right in a round wins it; tied
                rounds award nobody. After 5 rounds the player with
                the higher <b>total score</b> takes the pot.
              </>
            ),
          },
          {
            heading: "Phase 1: Memorize",
            body: (
              <>
                The grid deals face-down, then the round's tiles light
                up for the memorize window (2.5s in round 1, up to
                <b> 4 seconds</b> in round 5). Burn the pattern in.
                when the timer ends the tiles go dark. Both players
                memorize the <b>exact same pattern</b> at the same time.
              </>
            ),
          },
          {
            heading: "Phase 2: Reconstruct",
            body: (
              <>
                The pattern hides and you get your <b>own blank
                grid</b>. Tap a tile to flip it and reveal the logo.
                tap it again to flip it back. Your picks are{" "}
                <b>freely editable</b> and never show whether they're
                right: press <b>Submit</b> when you're done (or let
                your 15-second window auto-lock) and your picks score
                as <b>correct tiles</b>. Both players reconstruct,
                then the round resolves.
              </>
            ),
          },
          {
            heading: "Payout",
            body: (
              <>
                After 5 rounds the player with the higher{" "}
                <b>total score</b> takes <b>1.9× their stake</b>
                (stake back + 90% of the loser's), house takes 0.1×.
                Exactly equal total scores → <b>full refund</b>.
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
        posthog?.capture("memory_grid_lobby_create_clicked", { stake });
        createOrJoin(stake);
      }}
      canPlay={canCreate}
      escrowNote={
        <>
          We pair you with another player of the <b>exact same</b> stake.
          If no one is waiting, your stake is escrowed in a private
          lobby until someone joins or you cancel.
        </>
      }
      error={error}
      lobbies={availableMatches}
      lobbyEmptyText="No open lobbies yet. Be the first to make one."
      lobbyTitle={(m) => (
        <>
          Lobby #{m.id}
          <span className="ml-2 inline-flex items-center gap-1.5">
            {m.hostProfileImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={m.hostProfileImageUrl}
                alt=""
                className="h-4 w-4 rounded-full object-cover"
              />
            ) : (
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-500/20 text-[8px] font-black text-amber-300">
                {(m.hostName ?? "?")[0]?.toUpperCase()}
              </span>
            )}
            <span className="text-[10px] text-white/50">
              host {m.hostName ?? `#${m.player1Id?.slice(0, 6)}…`}
            </span>
          </span>
        </>
      )}
      lobbyMeta={(m) => (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            Stake:{" "}
            <span className="inline-flex items-center gap-1 font-semibold text-yellow-300">
              {Number(m.stakeAmount).toLocaleString()}
            </span>
          </span>
        </span>
      )}
      onJoin={(l) => {
        posthog?.capture("memory_grid_lobby_join_clicked", {
          match_id: l.id,
          stake: l.stakeAmount,
        });
        joinSpecific(l.id);
      }}
      joinBusyId={joiningId}
      onRefresh={fetchAvailable}
      myOpenId={myOpenMatchId}
      onResume={(id) => router.push(`/casino/memory-grid/${id}`)}
      onCancel={(id) => cancelMyMatch(id)}
      cancelling={cancellingId === myOpenMatchId}
    />
  );
}
