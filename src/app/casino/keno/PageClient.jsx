"use client";

// src/app/casino/keno/page.jsx
//
// MULTIPLAYER LOBBY for the Keno game (1v1 "Keno Catch Duel").
//
// Keno is now a skill-based 1v1 game: both players face the SAME
// shared 10-ball draw each round and race to catch the balls on the
// server-declared release schedule — perfect-timed taps score bonus
// points. This page is the single entry point: matchmaking / scoring
// / payout logic lives in `src/lib/keno-pvp/serverStore.js` (the same
// engine powering the in-match view at /casino/keno-pvp/[matchId]).
//
// Flow:
//   1. Pick a stake (preset chips or custom).
//   2. Hit Play → POST /api/keno-pvp/create-or-join
//        • matches on stake equality (server-authoritative)
//        • escrows the stake on success
//   3. Redirect to /casino/keno-pvp/[matchId] — the live 1v1 match.
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
  KENO_PVP_LOBBY_ROOM,
  KENO_PVP_MATCH_UPDATED,
  kenoPvpMatchRoom,
} from "../../../lib/keno-pvp/rooms";
import { STAKE_PRESETS } from "../../../lib/keno-pvp/constants";

// ── Small inline SVG icons (mirror the slots-pvp lobby) ──────────────

function BallIcon({ className = "" }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <circle cx="16.5" cy="7.5" r="3" fill="white" />
    </svg>
  );
}

export default function KenoLobbyPage() {
  const { isSignedIn, user } = useUser();
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();

  const [stake, setStake] = useState(50);
  const [availableMatches, setAvailableMatches] = useState([]);
  const [balance, setBalance] = useState(null);
  const [busy, setBusy] = useState(false);
  const [joiningId, setJoiningId] = useState(null);
  const [cancellingId, setCancellingId] = useState(null);
  const [error, setError] = useState(null);

  const fetchAvailable = useCallback(async () => {
    try {
      const res = await fetch("/api/keno-pvp/available", { cache: "no-store" });
      const data = await res.json();
      if (data?.success) setAvailableMatches(data.data.matches || []);
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

  const myOpenMatch = useMemo(
    () =>
      !user?.id
        ? null
        : availableMatches.find((m) => m.player1Id === user.id) ?? null,
    [availableMatches, user?.id],
  );

  useEffect(() => {
    if (!socket) return;
    const refresh = () => fetchAvailable();
    socket.emit("join_room", { roomId: KENO_PVP_LOBBY_ROOM });
    socket.on(KENO_PVP_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId: KENO_PVP_LOBBY_ROOM });
      socket.off(KENO_PVP_MATCH_UPDATED, refresh);
    };
  }, [socket, fetchAvailable]);

  const createOrJoin = useCallback(
    async (stakeAmount) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/keno-pvp/create-or-join", {
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
          roomId: KENO_PVP_LOBBY_ROOM,
          event: "lobby:updated",
        });
        socket?.emit("room_event", {
          roomId: kenoPvpMatchRoom(data.data.match.id),
          event: KENO_PVP_MATCH_UPDATED,
        });
        posthog?.capture("keno_pvp_match_created_or_joined", {
          stake: stakeAmount,
          joined: Boolean(data?.data?.joined),
          match_id: data?.data?.match?.id,
        });
        router.push(`/casino/keno-pvp/${data.data.match.id}`);
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
        const res = await fetch("/api/keno-pvp/create-or-join", {
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
          roomId: kenoPvpMatchRoom(data.data.match.id),
          event: KENO_PVP_MATCH_UPDATED,
        });
        posthog?.capture("keno_pvp_match_joined", {
          match_id: matchId,
          stake: target.stakeAmount,
        });
        router.push(`/casino/keno-pvp/${data.data.match.id}`);
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
        const res = await fetch(`/api/keno-pvp/match/${matchId}/cancel`, {
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
          roomId: KENO_PVP_LOBBY_ROOM,
          event: "lobby:updated",
        });
        posthog?.capture("keno_pvp_lobby_cancelled", { match_id: matchId });
        fetchAvailable();
      } finally {
        setCancellingId(null);
      }
    },
    [fetchAvailable, posthog, socket],
  );

  const myOpenMatchId = myOpenMatch?.id ?? null;
  const stakeValid = stake > 0 && (balance === null || balance >= stake);
  const canCreate = isSignedIn && !busy && stakeValid && myOpenMatchId === null;

  return (
    <PvpLobbyPage
      title="Keno Lobby"
      subtitle={
        <>
          1v1 <b>Keno Catch Duel</b>. Both players face the <b>same</b>{" "}
          10-ball draw. Catch each ball as it drops (each tile glows for
          <b>1 second</b>, so timing matters but isn't brutal). Catching
          more compounds (the classic keno multiplier table: 5 balls =
          50 pts, 10 balls = 5000 pts). <b>First to 10 points</b> takes
          the pot <b>1.9× their stake</b>, house takes 0.1×. Miss the
          window and the ball is gone.
        </>
      }
      icon={
        <BallIcon className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />
      }
      rulesKey="keno"
      rules={{
        title: "How to Play",
        sections: [
          {
            heading: "Catch the glowing tile",
            body: (
              <>
                Each round <b>10 tiles</b> from the 1–40 board light up
                one at a time. Both players chase the <b>same draw</b>.
                Tap a tile while it glows (<b>1 second</b> window) to
                catch it; tap after the glow fades and it&apos;s a miss.
              </>
            ),
          },
          {
            heading: "Keno multiplier points",
            body: (
              <>
                Tiles caught → points, compounding: 5 tiles = 50 pts, all
                10 = 5,000 pts. The last tiles are worth the most.
              </>
            ),
          },
          {
            heading: "Win the match",
            body: (
              <>
                <b>First to 10 points</b> takes the pot. 1.9× their
                stake, house takes 0.1×. A 3-minute match clock with 30s
                overtime settles close games; an overtime tie refunds both
                players.
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
        posthog?.capture("keno_pvp_lobby_create_clicked", { stake });
        createOrJoin(stake);
      }}
      canPlay={canCreate}
      escrowNote={
        <>
          We pair you with another player of the <b>exact same</b> stake.
          If no one is waiting, your stake is escrowed in a private lobby
          until someone joins or you cancel. Both players catch the same
          server-side ball stream. The server grades every tap.
        </>
      }
      error={error}
      lobbies={availableMatches}
      lobbyEmptyText="No open lobbies yet. Be the first to make one. Pick a stake and hit Play."
      lobbyTitle={(m) => (
        <>
          Lobby #{m.id}
          <span className="ml-2 text-[10px] text-white/40">
            host {m.player1Id?.slice(0, 6) ?? "?"}
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
          <span className="text-[10px] text-white/40">Catch Duel</span>
        </span>
      )}
      onJoin={(l) => joinSpecific(l.id)}
      joinBusyId={joiningId}
      onRefresh={fetchAvailable}
      myOpenId={myOpenMatchId}
      onResume={(id) => router.push(`/casino/keno-pvp/${id}`)}
      onCancel={(id) => cancelMyMatch(id)}
      cancelling={cancellingId === myOpenMatchId}
    />
  );
}
