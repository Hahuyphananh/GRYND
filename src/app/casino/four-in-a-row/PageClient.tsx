"use client";

import { useEffect, useState } from "react";
import { useDefaultWager } from "../../../hooks/useDefaultWager";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { usePostHog } from "posthog-js/react";
import { useSocket } from "../../../context/SocketProvider";
import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import { CoinIcon } from "../../../components/lobby/PvpLobby";
import { IconRobot, IconGridDots } from "@tabler/icons-react";
import CreatorModeLobby from "../../../components/creator-mode/CreatorModeLobby";

const BET_OPTIONS = [10, 25, 50, 100, 250];
const TIMER_OPTIONS = [
  { value: 10, label: "10 seconds" },
  { value: 30, label: "30 seconds" },
  { value: 60, label: "60 seconds" },
  { value: 120, label: "120 seconds" },
];

export default function FourInARowLobbyPage() {
  const { isSignedIn, user } = useUser();
  const { socket } = useSocket();
  const router = useRouter();
  const posthog = usePostHog();

  const [betAmount, setBetAmount] = useDefaultWager("four-in-a-row", 10);
  const [timerSeconds, setTimerSeconds] = useState(60);
  const [balance, setBalance] = useState(0);
  const [loading, setLoading] = useState(false);
  const [availableGames, setAvailableGames] = useState<any[]>([]);
  const [joiningId, setJoiningId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      const res = await fetch("/api/four-in-a-row/available-games", {
        cache: "no-store",
      });
      const data = await res.json();
      if (data.success) setAvailableGames(data.games || []);
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
    const roomId = "lobby:four-in-a-row";
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
      const res = await fetch("/api/four-in-a-row/create-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ betAmount, timerSeconds }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Unable to create game");
        return;
      }

      socket?.emit("room_event", {
        roomId: "lobby:four-in-a-row",
        event: "lobby:updated",
      });
      router.push(`/casino/four-in-a-row/game/${data.gameId}`);
      posthog?.capture("four_in_a_row_game_started", { mode: "create", bet_amount: betAmount, game_id: data.gameId, timer_seconds: timerSeconds });
    } finally {
      setLoading(false);
    }
  };

  const playVsAi = () => {
    if (!isSignedIn) {
      setError("Please sign in to play vs AI.");
      return;
    }
    posthog?.capture("four_in_a_row_game_started", { mode: "ai" });
    router.push("/casino/four-in-a-row/play-ai");
  };

  const joinGame = async (gameId?: number) => {
    setLoading(true);
    setError(null);
    if (gameId) setJoiningId(gameId);

    try {
      const res = await fetch("/api/four-in-a-row/join-game", {
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
        roomId: "lobby:four-in-a-row",
        event: "lobby:updated",
      });
      router.push(`/casino/four-in-a-row/game/${data.gameId}`);
      posthog?.capture("four_in_a_row_game_started", { mode: gameId ? "join" : "quick_join", game_id: data.gameId });
    } finally {
      setLoading(false);
      setJoiningId(null);
    }
  };

  return (
    <>
      <PvpLobbyPage
        title="Four-In-A-Row"
        subtitle="Create, join, and wager in live multiplayer Four-In-A-Row games. Or play the AI for free."
        icon={<IconGridDots className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />}
        rulesKey="four-in-a-row"
        rules={{
          title: "How to Play",
          sections: [
            {
              heading: "Drop discs",
              body: (
                <>
                  Take turns dropping a disc into a 7×6 grid. It falls to
                  the lowest free slot in the column you pick.
                </>
              ),
            },
            {
              heading: "Align four",
              body: (
                <>
                  Be the first to line up <b>four discs</b> horizontally,
                  vertically, or diagonally to win the match.
                </>
              ),
            },
            {
              heading: "Stake",
              body: (
                <>
                  Both players stake the same amount; the winner takes the
                  pot minus the platform fee. Play vs AI free to practice.
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
        playLabel="Create Game"
        playBusyLabel="Creating…"
        vsAi={{
          label: "Play vs AI. Free, no wager",
          badge: "Free",
          disabled: !isSignedIn,
          busy: loading,
          onClick: playVsAi,
        }}
        escrowNote="We pair you with another player of the exact same bet. If no one is waiting, your bet is escrowed in a private game until someone joins or you cancel."
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
        children={
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider text-white/60">
                Turn timer
              </label>
              <select
                value={timerSeconds}
                onChange={(e) => setTimerSeconds(Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-amber-600/50 bg-[#020617] px-2 py-1.5 text-xs text-white outline-none focus:border-amber-400"
              >
                {TIMER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        }
        lobbies={availableGames}
        lobbyEmptyText="No open games right now."
        lobbyKey={(l) => l.id}
        lobbyTitle={(l) => <>Game #{l.id}</>}
        lobbyMeta={(l) => (
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>Host: {l.hostName || "Player"}</span>
            <span>
              Bet:{" "}
              <span className="inline-flex items-center gap-1 font-semibold text-yellow-300">
                {Number(l.betAmount).toFixed(2)}
                <CoinIcon className="h-3.5 w-3.5 text-yellow-300" />
              </span>
            </span>
            <span>Timer: {Number(l.timerSeconds || 60)}s</span>
          </span>
        )}
        onJoin={(l) => joinGame(l.id)}
        joinBusyId={joiningId}
        onRefresh={fetchGames}
        error={error}
      />
      {/* Creator Mode toggle (admin-only — renders nothing for other users). */}
      <div className="mb-4 flex justify-center">
        <CreatorModeLobby />
      </div>
    </>
  );
}
