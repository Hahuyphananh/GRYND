"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useSocket } from "../../../context/SocketProvider";
import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import { CoinIcon } from "../../../components/lobby/PvpLobby";
import { IconRobot } from "@tabler/icons-react";
import AiDifficultyPicker from "../../../components/lobby/AiDifficultyPicker";
import { readStoredAiDifficulty } from "../../../lib/aiDifficulty";


export default function UnoLobbyPage() {
  const [lobbies, setLobbies] = useState([]);
  // STAKES ARE RETIRED (src/lib/games/stakes.js): a lobby is free to open,
  // so there is no wager to pick and no token balance to load.
  const wager = 0;
  const [loading, setLoading] = useState(false);
  // The AI tier the bot plays at, chosen in this lobby and remembered per
  // game by the picker; sent with the vs-AI start request.
  const [aiDifficulty, setAiDifficulty] = useState(() =>
    readStoredAiDifficulty("uno"),
  );
  const [joiningId, setJoiningId] = useState(null);
  const [error, setError] = useState(null);
  const [myOpenGameId, setMyOpenGameId] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();

  const load = async () => {
    try {
      const res = await fetch("/api/uno/available-games", { cache: "no-store", credentials: "include" });
      const data = await res.json();
      if (data.success) {
        setLobbies(data.data || []);
        // Check if user has an open game
        const myGame = (data.data || []).find((g) => g.isMine);
        setMyOpenGameId(myGame?.id || null);
      }
    } catch {
      // silent
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(() => {
      load();
    }, 3000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!socket) return;
    const roomId = "lobby:uno";
    const handleLobbyUpdate = () => load();
    socket.emit("join_room", { roomId });
    socket.on("lobby:updated", handleLobbyUpdate);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("lobby:updated", handleLobbyUpdate);
    };
  }, [socket]);

  const createGame = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/uno/initialize-vs-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ betAmount: wager, difficulty: aiDifficulty }),
      });
      const data = await res.json();
      if (!data.success || !data.data?.id) {
        setError(data.error || "Unable to create game");
        return;
      }
      posthog?.capture("neon_flush_game_started", {
        mode: "ai",
        bet_amount: wager,
        game_id: data.data.id,
      });
      router.push(`/casino/uno/game/${data.data.id}`);
    } finally {
      setLoading(false);
    }
  };

  const playAI = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/uno/initialize-vs-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ betAmount: 0, difficulty: aiDifficulty }),
      });
      const data = await res.json();
      if (data.success && data.data?.id) {
        posthog?.capture("neon_flush_game_started", {
          mode: "ai_free",
          bet_amount: 0,
          game_id: data.data.id,
        });
        router.push(`/casino/uno/game/${data.data.id}`);
      } else {
        setError(data.error || "Unable to start free play");
      }
    } finally {
      setLoading(false);
    }
  };

  const joinGame = async (lobby) => {
    setJoiningId(lobby.id);
    setError(null);
    try {
      const res = await fetch("/api/uno/join-online", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mode: "join-specific", gameId: lobby.id }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Unable to join game");
        return;
      }
      posthog?.capture("neon_flush_game_started", {
        mode: "online",
        bet_amount: lobby.betAmount,
        game_id: data.data?.id || lobby.id,
      });
      router.push(`/casino/uno/game/${data.data?.id || lobby.id}`);
    } finally {
      setJoiningId(null);
    }
  };

  const cancelGame = async (gameId) => {
    setCancelling(true);
    try {
      const res = await fetch("/api/uno/cancel-waiting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ gameId }),
      });
      const data = await res.json();
      if (data.success) {
        setMyOpenGameId(null);
        load();
      } else {
        setError(data.error || "Failed to cancel");
      }
    } finally {
      setCancelling(false);
    }
  };

  const resumeGame = (gameId) => {
    router.push(`/casino/uno/game/${gameId}`);
  };

  return (
    <PvpLobbyPage
      title="Neon Flush"
      subtitle="Match colors and numbers in a fast strategic card game against the AI or other players."
      icon={
        <>
          <IconRobot className="h-9 w-9 flex-shrink-0 text-cyan-400 drop-shadow-[0_0_12px_rgba(34,211,238,0.6)] sm:h-10 sm:w-10" />
        </>
      }
      rulesKey="uno"
      rules={{
        title: "How to Play",
        sections: [
          {
            heading: "Match the top card",
            body: (
              <>
                Play a card matching the top card&apos;s color or number
                (or a Wild / action card). First to empty their hand
                wins the round.
              </>
            ),
          },
          {
            heading: "Action cards",
            body: (
              <>
                Skip, Reverse and Draw Two cards disrupt your
                opponent&apos;s turn; Wild and Wild Draw Four change the
                color.
              </>
            ),
          },
          {
            heading: "Modes",
            body: (
              <>
                Play vs AI for free, or go 1v1 online. The result is worth
                trophies and rating — nothing is staked and no pot is paid.
              </>
            ),
          },
        ],
      }}
      busy={loading}
      onPlay={createGame}
      playLabel="Start vs AI"
      playBusyLabel="Starting game…"
      canPlay={true}
      vsAi={{
        label: "Free Play vs AI",
        badge: "Free",
        disabled: false,
        busy: loading,
        onClick: playAI,
      }}
      lobbies={lobbies}
      lobbyEmptyText="No open Neon Flush games yet. Be the first to start one."
      lobbyKey={(l) => l.id}
      lobbyTitle={(l) => (
        <>
          Neon Flush{" "}
          <span className="font-mono">{String(l.id).slice(-8)}</span>
        </>
      )}
      lobbyMeta={(l) => (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-semibold">
            {l.hostName} • {l.playerCount ?? 0} / 2 players
          </span>
          <span>
            Entry:{" "}
            <span className="inline-flex items-center gap-1 font-semibold text-yellow-300">
              {Number(l.betAmount).toLocaleString()}
              <CoinIcon className="h-3.5 w-3.5 text-yellow-300" />
            </span>
          </span>
          <span className="text-white/40">
            Prize: ~{Number(l.prizePool ?? 0).toLocaleString()}
          </span>
        </span>
      )}
      onJoin={joinGame}
      joinBusyId={joiningId}
      onRefresh={load}
      error={error}
      myOpenId={myOpenGameId}
      onResume={resumeGame}
      onCancel={cancelGame}
      cancelling={cancelling}
      waitingSubtitle="Waiting for a 1v1 Neon Flush match…"
      children={
        <AiDifficultyPicker
          gameKey="uno"
          value={aiDifficulty}
          onChange={setAiDifficulty}
          hint={{
            easy: "The bot plays an arbitrary legal card — it will miss easy wins.",
            normal: "The bot plays its best card, with the occasional slip.",
            hard: "The bot always plays its highest-scoring legal card.",
          }}
        />
      }
    />
  );
}