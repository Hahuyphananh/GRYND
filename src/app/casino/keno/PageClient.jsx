"use client";

// src/app/casino/keno/page.jsx
//
// MULTIPLAYER LOBBY for the Keno game (1v1 "Keno Survival Duel").
//
// Keno is a skill-based 1v1 survival game: both players start with 3
// lives and race for the SAME lit tile. The first tap claims the tile and
// costs the opponent a life; a tile nobody claims is a both-miss (both
// lose a life). The window tightens 100ms per claimed tile. This page is
// the single entry point: matchmaking / scoring / payout logic lives in
// `src/lib/keno-pvp/serverStore.js` (the same engine powering the
// in-match view at /casino/keno-pvp/[matchId]).
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
import { useDefaultWager } from "../../../hooks/useDefaultWager";
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

  const [stake, setStake] = useDefaultWager("keno", 50);
  const [availableMatches, setAvailableMatches] = useState([]);
  const [balance, setBalance] = useState(null);
  const [busy, setBusy] = useState(false);
  const [joiningId, setJoiningId] = useState(null);
  const [cancellingId, setCancellingId] = useState(null);
  const [error, setError] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);

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
        router.push(matchHref(data.data.match.id));
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
        router.push(matchHref(data.data.match.id));
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

  const playVsAi = useCallback(async () => {
    setAiBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/keno-pvp/create-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data?.error || "Unable to start free AI match");
        return;
      }
      const matchId = data?.data?.match?.id;
      if (matchId) {
        posthog?.capture("keno_pvp_ai_match_created", { match_id: matchId });
        socket?.emit("room_event", {
          roomId: kenoPvpMatchRoom(matchId),
          event: KENO_PVP_MATCH_UPDATED,
        });
        router.push(matchHref(matchId));
      }
    } catch {
      setError("Unable to start free AI match");
    } finally {
      setAiBusy(false);
    }
  }, [posthog, router, socket]);

  const myOpenMatchId = myOpenMatch?.id ?? null;
  const stakeValid = stake > 0 && (balance === null || balance >= stake);
  const canCreate = isSignedIn && !busy && !aiBusy && stakeValid && myOpenMatchId === null;

  // Redirect to the real Keno match page.
  const matchHref = (matchId) => `/casino/keno-pvp/${matchId}`;

  return (
    <PvpLobbyPage
      title="Keno Lobby"
      subtitle={
        <>
          1v1 <b>Keno Survival Duel</b>. Both players start with{" "}
          <b>3 lives</b> and share the <b>same lit tile</b> and the same
          window. Tap it in time and you keep your life — claiming it
          before your opponent costs them nothing. You lose a life only
          when <b>you</b> miss: if you don't tap before the window closes,
          it is yours to lose (a tile neither of you taps costs you both).
          A <b>5s</b> countdown gets you ready, then the window starts at{" "}
          <b>3s</b> and tightens <b>100ms per claimed tile</b> (floor
          <b>0.5s</b>). First to strip all 3 lives takes the pot{" "}
          <b>1.9× their stake</b>, house takes 0.1×.
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
            heading: "Race for the same lit tile",
            body: (
              <>
                <b>One tile</b> from the 1–40 board is lit for both
                players at the same time, and both of you have the same
                window to tap it. Tapping it <b>saves your life</b> — it
                does not take one off your opponent, and tapping after
                them costs you nothing. You lose a life only if you
                don't tap it in time. If neither player taps, <b>both</b>{" "}
                lose a life.
              </>
            ),
          },
          {
            heading: "Survive 3 lives",
            body: (
              <>
                You start with <b>3 lives</b>. Lose them all and you are
                eliminated — your opponent takes the pot. If a tile goes
                unclaimed while you are both on your last life, the match
                ends as a draw and both stakes are refunded.
              </>
            ),
          },
          {
            heading: "The window tightens",
            body: (
              <>
                A <b>5-second</b> countdown runs before the first tile so
                you are ready to click. The first tile then gives you{" "}
                <b>3s</b>. Every tile either player claims shaves{" "}
                <b>100ms</b> off the next window, down to a <b>0.5s</b>{" "}
                floor — later tiles are won on reaction alone. Winner
                takes 1.9× their stake; the house keeps 0.1×.
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
      vsAi={{
        label: "Play Free vs AI",
        badge: "No tokens",
        onClick: playVsAi,
        disabled: !isSignedIn || busy || aiBusy,
        busy: aiBusy,
      }}
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
          <span className="text-[10px] text-white/40">Survival Duel</span>
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
