"use client";

// ── Rock Paper Scissors lobby ──────────────────────────────────────────
// Mirrors the other casino PvP lobbies (shared PvpLobbyPage chrome):
//   * Balance + wager picker + "Create PvP Game" (escrows the wager,
//     routes to /casino/rps/game/[gameId] for the best-of-7 match).
//   * "Play vs AI — Free" routes to /casino/rps/play-ai, a self-contained
//     client-side best-of-7 sandbox (no wager, no server interaction).
//   * Live list of open lobbies (polled every 3s + realtime nudge).

import { useEffect, useState } from "react";
import { useDefaultWager } from "../../../hooks/useDefaultWager";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { usePostHog } from "posthog-js/react";
import { useSocket } from "../../../context/SocketProvider";
import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import { CoinIcon } from "../../../components/lobby/PvpLobby";
import { RockFistIcon } from "../../../components/icons/CustomIcons";
import AiDifficultyPicker from "../../../components/lobby/AiDifficultyPicker";
import {
  type AiDifficulty,
  readStoredAiDifficulty,
} from "../../../lib/aiDifficulty";

const BET_OPTIONS = [10, 25, 50, 100, 250];

export default function RPSLobbyPage() {
  const { isSignedIn, user } = useUser();
  const { socket } = useSocket();
  const router = useRouter();
  const posthog = usePostHog();

  const [betAmount, setBetAmount] = useDefaultWager("rps", 10);
  const [balance, setBalance] = useState(0);
  const [loading, setLoading] = useState(false);
  const [availableGames, setAvailableGames] = useState<any[]>([]);
  const [joiningId, setJoiningId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The AI tier the bot plays at, chosen here and remembered per game by the
  // picker; the free-play page reads it back when it mounts.
  const [aiDifficulty, setAiDifficulty] = useState<AiDifficulty>(() =>
    readStoredAiDifficulty("rps"),
  );

  const fetchBalance = async () => {
    if (!user) return;
    const response = await fetch("/api/get-user-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    });
    const data = await response.json();
    if (data.success) setBalance(Number(data.data.balance || 0));
  };

  const fetchGames = async () => {
    try {
      const res = await fetch("/api/rps/pvp/available", {
        cache: "no-store",
      });
      const data = await res.json();
      if (data.success) setAvailableGames(data.data.games || []);
    } catch {
      // silent
    }
  };

  useEffect(() => {
    if (isSignedIn && user) fetchBalance();
    fetchGames();
    const id = setInterval(() => {
      if (isSignedIn && user) fetchBalance();
      fetchGames();
    }, 3000);
    return () => clearInterval(id);
  }, [isSignedIn, user]);

  useEffect(() => {
    if (!socket) return;
    const roomId = "lobby:rps";
    const refresh = () => fetchGames();

    socket.emit("join_room", { roomId });
    socket.on("lobby:updated", refresh);

    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("lobby:updated", refresh);
    };
  }, [socket]);

  const createGame = async () => {
    if (betAmount <= 0 || betAmount > balance) {
      setError("Invalid bet amount");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/rps/pvp/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ betAmount }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        setError(data.error || "Unable to create game");
        return;
      }

      socket?.emit("room_event", {
        roomId: "lobby:rps",
        event: "lobby:updated",
      });
      router.push(`/casino/rps/game/${data.data.gameId}`);
      posthog?.capture("rps_game_started", {
        mode: "create",
        bet_amount: betAmount,
        game_id: data.data.gameId,
      });
    } finally {
      setLoading(false);
    }
  };

  const playVsAi = () => {
    if (!isSignedIn) {
      setError("Please sign in to play vs AI.");
      return;
    }
    posthog?.capture("rps_game_started", { mode: "ai", bet_amount: 0 });
    router.push("/casino/rps/play-ai");
  };

  const joinGame = async (gameId?: number) => {
    setLoading(true);
    setError(null);
    if (gameId) setJoiningId(gameId);

    try {
      const res = await fetch("/api/rps/pvp/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(gameId ? { gameId } : { quickJoin: true }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        setError(data.error || "Unable to join game");
        return;
      }

      socket?.emit("room_event", {
        roomId: "lobby:rps",
        event: "lobby:updated",
      });
      router.push(`/casino/rps/game/${data.data.gameId}`);
      posthog?.capture("rps_game_started", {
        mode: gameId ? "join" : "quick_join",
        game_id: data.data.gameId,
      });
    } finally {
      setLoading(false);
      setJoiningId(null);
    }
  };

  return (
    <PvpLobbyPage
      title="Rock Paper Scissors"
      subtitle="Best-of-7 mind games against a live opponent. First to 4 rounds takes the pot. Or play the AI for free."
      icon={<RockFistIcon className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />}
      rulesKey="rps"
      rules={{
        title: "How to Play",
        sections: [
          {
            heading: "Best of 7",
            body: (
              <>
                You and your opponent throw Rock, Paper, or Scissors
                simultaneously. <b>First to 4 round wins</b> takes the
                match and the pot.
              </>
            ),
          },
          {
            heading: "Matchups",
            body: (
              <>
                Rock beats Scissors · Scissors beats Paper · Paper beats
                Rock. Ties are replayed. They never count as a round.
              </>
            ),
          },
          {
            heading: "Round tracker",
            body: (
              <>
                The dots above the board show the score: <b>blue</b> for
                rounds you won, <b>red</b> for rounds your opponent won.
              </>
            ),
          },
          {
            heading: "Stake",
            body: (
              <>
                Both players stake the same amount; the best-of-7 winner
                takes the pot minus the platform fee. Play vs AI for free to
                practice.
              </>
            ),
          },
        ],
      }}
      balance={balance}
      stake={betAmount}
      onStakeChange={setBetAmount}
      stakeOptions={BET_OPTIONS}
      busy={loading}
      onPlay={createGame}
      playLabel="Create PvP Game"
      playBusyLabel="Creating…"
      vsAi={{
        label: "Play vs AI. Free, no wager",
        badge: "Free",
        disabled: !isSignedIn,
        busy: loading,
        onClick: playVsAi,
      }}
      escrowNote="We pair you with another player of the exact same bet. If no one is waiting, your bet is escrowed in a private game until someone joins or you cancel."
      children={
        <AiDifficultyPicker
          gameKey="rps"
          value={aiDifficulty}
          onChange={setAiDifficulty}
          hint={{
            easy: "The bot throws completely at random.",
            normal: "The bot counters your most common throw about half the time.",
            hard: "The bot reads your pattern and counters it most rounds.",
          }}
        />
      }
      extraActions={
        <button
          type="button"
          onClick={() => joinGame()}
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 py-2 text-sm font-bold text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-50"
        >
          {loading ? "Joining…" : "Quick Join"}
        </button>
      }
      lobbies={availableGames}
      lobbyEmptyText="No open games right now. Be the first to create one."
      lobbyKey={(l) => l.id}
      lobbyTitle={(l) => <>Game #{l.id}</>}
      lobbyMeta={(l) => (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>Host: {l.player1Name || "Player"}</span>
          <span>
            Bet:{" "}
            <span className="inline-flex items-center gap-1 font-semibold text-yellow-300">
              {Number(l.betAmount).toFixed(2)}
              <CoinIcon className="h-3.5 w-3.5 text-yellow-300" />
            </span>
          </span>
        </span>
      )}
      onJoin={(l) => joinGame(l.id)}
      joinBusyId={joiningId}
      onRefresh={fetchGames}
      error={error}
    />
  );
}
