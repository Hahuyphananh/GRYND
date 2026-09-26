"use client";

// src/app/casino/roulette/page.jsx
//
// Lobby page for the Roulette PvP match system. Previously this route
// hosted the solo roulette game; that game has been moved to the
// dynamic sibling `/casino/roulette/[matchId]/page.jsx` (the match
// view), and this file is now the entry-point where players pick a
// stake and either pair with an existing lobby of the same stake or
// create a fresh waiting lobby.
//
// Flow:
//   1. Pick a stake (preset chips or custom).
//   2. Hit Play → POST /api/roulette-pvp/create-or-join
//        • matches on stake equality (server-authoritative)
//        • escrow stake on success
//   3. Redirect to /casino/roulette/[matchId]
//
// Server-side canonical logic (match state machine, stake escrow,
// round resolution) lives in src/lib/roulette-pvp/serverStore.js —
// this page is a thin client.
//
// The page chrome (balance strip → stake picker + Play → escrow
// note → Open Lobbies list) is the shared PvpLobby component in the
// blackjack layout / farkle color scheme.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
import PvpLobbyPage, { CoinIcon } from "../../../components/lobby/PvpLobby";
import { useSocket } from "../../../context/SocketProvider";
import {
  ROULETTE_PVP_LOBBY_ROOM,
  ROULETTE_PVP_MATCH_UPDATED,
  roulettePvpMatchRoom,
} from "../../../lib/roulette-pvp/rooms";
import { RouletteWheelIcon } from "../../../components/roulette-pvp/RouletteIcons";
import AiDifficultyPicker from "../../../components/lobby/AiDifficultyPicker";
import { readStoredAiDifficulty } from "../../../lib/aiDifficulty";


export default function RoulettePvpLobbyPage() {
  const { isSignedIn } = useUser();
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();

  // Minimum time the full-screen "Searching for a match…" takeover stays
  // visible — enforced on EVERY play action (create, join, vs-AI).
  // Create-or-join usually resolves in one fast round-trip, so without
  // this floor the screen would flash for a frame (or not paint at all)
  // and the unified waiting UX would be invisible. 1200ms is comfortably
  // perceptible while still feeling snappy.
  const MIN_SEARCHING_MS = 1200;
  const searchStartedAtRef = useRef(0);
  const ensureMinSearching = async () => {
    const remaining = MIN_SEARCHING_MS - (Date.now() - searchStartedAtRef.current);
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
  };

  // STAKES ARE RETIRED (src/lib/games/stakes.js): a lobby is free to open,
  // so there is no stake to pick and no token balance to load.
  const stake = 0;
  const [availableMatches, setAvailableMatches] = useState([]);
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  // The AI tier the bot bets at, chosen in this lobby and remembered per
  // game by the picker; sent with the create-ai request.
  const [aiDifficulty, setAiDifficulty] = useState(() =>
    readStoredAiDifficulty("roulette"),
  );
  const [joiningId, setJoiningId] = useState(null);
  const [error, setError] = useState(null);

  const fetchAvailable = async () => {
    try {
      const res = await fetch("/api/roulette-pvp/available", {
        cache: "no-store",
      });
      const data = await res.json();
      if (data.success) setAvailableMatches(data.data.matches || []);
    } catch {
      // Silent — polling will retry.
    }
  };

  useEffect(() => {
    fetchAvailable();
    const interval = setInterval(() => {
      fetchAvailable();
    }, 3000);
    return () => clearInterval(interval);
  }, [isSignedIn]);

  useEffect(() => {
    if (!socket) return;
    const refresh = () => fetchAvailable();
    socket.emit("join_room", { roomId: ROULETTE_PVP_LOBBY_ROOM });
    socket.on("lobby:updated", refresh);
    return () => {
      socket.emit("leave_room", { roomId: ROULETTE_PVP_LOBBY_ROOM });
      socket.off("lobby:updated", refresh);
    };
  }, [socket]);

  const createOrJoin = async (stakeAmount) => {
    setBusy(true);
    searchStartedAtRef.current = Date.now();
    setError(null);
    try {
      const res = await fetch("/api/roulette-pvp/create-or-join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ stakeAmount }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data?.error || "Unable to start match");
        setBusy(false);
        return;
      }
      socket?.emit("room_event", {
        roomId: ROULETTE_PVP_LOBBY_ROOM,
        event: "lobby:updated",
      });
      // Live-update fanout to the freshly-created match room so the
      // opponent (already on /casino/roulette/[matchId] after joining)
      // sees the waiting → ready transition without waiting for the
      // 1.5 s poll. Both players subscribe to this room on mount;
      // `socket.to(room).emit` (server-side fanout) means they each
      // receive the other's updates.
      const matchId = data?.data?.match?.id;
      if (matchId) {
        socket?.emit("room_event", {
          roomId: roulettePvpMatchRoom(matchId),
          event: ROULETTE_PVP_MATCH_UPDATED,
        });
      }
      posthog?.capture("roulette_pvp_match_created_or_joined", {
        stake: stakeAmount,
        joined: Boolean(data?.data?.joined),
        match_id: data?.data?.match?.id,
      });
      // Hold the searching screen long enough to be perceived, then
      // navigate to the match room (which shows its own waiting/ready
      // takeover if an opponent isn't ready yet).
      await ensureMinSearching();
      router.push(`/casino/roulette/${data.data.match.id}`);
      // Intentionally NOT resetting `busy` on success: the component
      // unmounts as we navigate away, and resetting here would flash
      // the lobby behind the overlay for a frame.
    } catch (err) {
      console.error("[roulette] create-or-join failed", err);
      setError("Network error while starting match");
      setBusy(false);
    }
  };

  const playVsAi = async () => {
    setAiBusy(true);
    searchStartedAtRef.current = Date.now();
    setError(null);
    try {
      const res = await fetch("/api/roulette-pvp/create-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ difficulty: aiDifficulty }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(data?.error || "Unable to start free AI match");
        setAiBusy(false);
        return;
      }
      const matchId = data?.data?.match?.id;
      if (!matchId) {
        setError("AI match did not return a match id");
        setAiBusy(false);
        return;
      }
      socket?.emit("room_event", {
        roomId: roulettePvpMatchRoom(matchId),
        event: ROULETTE_PVP_MATCH_UPDATED,
      });
      posthog?.capture("roulette_pvp_ai_started", { match_id: matchId });
      // Hold the searching screen long enough to be perceived.
      await ensureMinSearching();
      router.push(`/casino/roulette/${matchId}`);
      // Not resetting `aiBusy` on success — see createOrJoin.
    } catch {
      setError("Network error while starting free AI match");
      setAiBusy(false);
    }
  };

  const joinSpecific = async (matchId) => {
    setJoiningId(matchId);
    searchStartedAtRef.current = Date.now();
    setError(null);
    try {
      const target = availableMatches.find((m) => m.id === matchId);
      if (!target) {
        setError("Lobby no longer available.");
        return;
      }
      const res = await fetch("/api/roulette-pvp/create-or-join", {
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
        roomId: ROULETTE_PVP_LOBBY_ROOM,
        event: "lobby:updated",
      });
      socket?.emit("room_event", {
        roomId: roulettePvpMatchRoom(data.data.match.id),
        event: ROULETTE_PVP_MATCH_UPDATED,
      });
      posthog?.capture("roulette_pvp_match_joined", {
        match_id: matchId,
        stake: target.stakeAmount,
      });
      // Same guaranteed-minimum beat as create / vs-AI: the joining
      // overlay must stay visible (not flash for a frame) before the
      // match page takes over with its ready/waiting takeover.
      await ensureMinSearching();
      router.push(`/casino/roulette/${data.data.match.id}`);
    } finally {
      setJoiningId(null);
    }
  };

  // The full-screen "Searching for a match…" takeover is rendered by the
  // shared PvpLobby whenever busy / vs-AI / join is in flight (see the
  // `waitingSubtitle` prop below). Keeping it in ONE place guarantees the
  // waiting page always appears first — the old code rendered a second
  // overlay here that sat underneath the shared one and was never visible.
  return (
    <PvpLobbyPage
      waitingSubtitle="Pairing you with a player on the same stake…"
      title="Roulette PvP Lobby"
      subtitle={
        <>
          Pick a stake. We pair you with another player of the <b>exact
          same</b> token amount. Always 3 rounds. The player with the
          most match points wins. Ties after Round 3 trigger sudden
          death. Single shared spin per round, but the wheel shrinks:
          Round 2 kills 13–24, Round 3 kills 13–36. Pay 10 match
          points to remove any number, and guess your opponent&apos;s
          biggest wager to steal 15 points. 2.5% platform fee.
        </>
      }
      icon={
        <RouletteWheelIcon
          className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10"
          title="Roulette wheel"
        />
      }
      rulesKey="roulette"
      rules={{
        title: "How to Play",
        sections: [
          {
            heading: "Match format",
            body: (
              <>
                Always <b>3 rounds</b>. The player with the most match
                points wins. Ties after Round 3 trigger sudden death.
              </>
            ),
          },
          {
            heading: "Shared spin",
            body: (
              <>
                A <b>single shared spin</b> per round. Match points (100
                to start) persist round-to-round.
              </>
            ),
          },
          {
            heading: "Elimination rounds",
            body: (
              <>
                The wheel <b>shrinks every round</b>. Round 2: 13–24 are
                dead. Round 3: 13–36 are dead (only 0–12 stay live). The
                spin is drawn from the live numbers only. Survivors
                become better bets as the pool shrinks.
              </>
            ),
          },
          {
            heading: "Elimination market",
            body: (
              <>
                Spend <b>10 match points</b> to remove <b>any</b> number
                from the shared wheel for the round. Visible to both
                players immediately, up to 6 removals per round. Removed
                numbers can never be spun or bet on, so removals shape
                the odds and deny your opponent&apos;s likely targets.
              </>
            ),
          },
          {
            heading: "Call their bet",
            body: (
              <>
                When you lock in, optionally guess your opponent&apos;s
                <b> biggest wager</b> (a number or colour). Guess right
                and you steal <b>15 points</b>. Both players can win
                the call in the same round.
              </>
            ),
          },
          {
            heading: "Platform fee",
            body: <>2.5% platform fee on the pot.</>,
          },
        ],
      }}
      busy={busy}
      onPlay={() => createOrJoin(stake)}
      canPlay={isSignedIn && !busy && !aiBusy}
      vsAi={{
        label: "Play Free vs AI",
        badge: "No tokens",
        onClick: playVsAi,
        disabled: !isSignedIn || busy || aiBusy,
        busy: aiBusy,
      }}
      children={
        <AiDifficultyPicker
          gameKey="roulette"
          value={aiDifficulty}
          onChange={setAiDifficulty}
          hint={{
            easy: "The bot chases single numbers and rarely predicts your biggest bet.",
            normal: "The bot spreads its bets across the whole board.",
            hard: "The bot sticks to even-money bets and usually calls your biggest wager.",
          }}
        />
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
        <span className="inline-flex items-center gap-1">
          <span>Stake:</span>
          <span className="inline-flex items-center gap-1 font-semibold text-yellow-300">
            {Number(m.stakeAmount).toLocaleString()}
            <CoinIcon className="h-3.5 w-3.5 text-yellow-300" />
          </span>
        </span>
      )}
      onJoin={(l) => joinSpecific(l.id)}
      joinBusyId={joiningId}
      onRefresh={fetchAvailable}
    />
  );
}
