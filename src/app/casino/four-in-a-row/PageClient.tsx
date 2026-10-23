"use client";

import { useEffect, useState } from "react";
import { useMatchRouter } from "../../../hooks/useMatchRouter";
import { useUser } from "@clerk/nextjs";
import { usePostHog } from "posthog-js/react";
import { useSocket } from "../../../context/SocketProvider";
import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import { CoinIcon } from "../../../components/lobby/PvpLobby";
import { IconRobot, IconGridDots } from "@tabler/icons-react";
import AiDifficultyPicker from "../../../components/lobby/AiDifficultyPicker";
import { useSocketAwarePoll } from "../../../hooks/useVisiblePoll";
import { useCoinBalance } from "../../../hooks/useCoinBalance";
import { MIN_STAKE } from "../../../lib/games/stakes";
import {
  type AiDifficulty,
  readStoredAiDifficulty,
} from "../../../lib/aiDifficulty";

const TIMER_OPTIONS = [
  { value: 10, label: "10 seconds" },
  { value: 30, label: "30 seconds" },
  { value: 60, label: "60 seconds" },
  { value: 120, label: "120 seconds" },
];

export default function FourInARowLobbyPage() {
  // Kept so the page still tracks Clerk's session (guests included); the
  // ONLINE actions route to sign-in from the shared lobby, and free practice
  // is open to everyone.
  useUser();
  const { socket } = useSocket();
  const router = useMatchRouter();
  const posthog = usePostHog();

  // Coin wager: the player picks the stake the lobby is opened at, and the
  // server escrows both seats the moment an opponent joins. A positive stake
  // is REQUIRED to enter a ranked match (PvP always plays for coins); the
  // vs-AI sandbox stays free.
  const coinBalance = useCoinBalance();
  const [stake, setStake] = useState<number>(10);
  const [timerSeconds, setTimerSeconds] = useState(60);
  const [loading, setLoading] = useState(false);
  const [availableGames, setAvailableGames] = useState<any[]>([]);
  // False once the first list response lands, so the empty state never
  // flashes before the request resolves.
  const [lobbiesLoading, setLobbiesLoading] = useState(true);
  const [joiningId, setJoiningId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The AI tier the bot plays at, chosen here and remembered per game by the
  // picker; the free-play page reads it back when it mounts.
  const [aiDifficulty, setAiDifficulty] = useState<AiDifficulty>(() =>
    readStoredAiDifficulty("four-in-a-row"),
  );

  const fetchGames = async () => {
    try {
      const res = await fetch("/api/four-in-a-row/available-games", {
        cache: "no-store",
      });
      const data = await res.json();
      if (data.success) setAvailableGames(data.games || []);
    } catch {
      // silent
    } finally {
      setLobbiesLoading(false);
    }
  };

  // The shared lobby room pushes an instant refresh, so the HTTP poll is only a
  // backstop: one read on mount, then the socket-aware, visibility-gated cadence
  // (30s healthy / 5s if the socket drops) instead of a flat 3s poll.
  useSocketAwarePoll(fetchGames, socket);

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
    if (stake < MIN_STAKE) {
      setError(`Pick a stake of at least ${MIN_STAKE} coin to open a game.`);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/four-in-a-row/create-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ betAmount: stake, timerSeconds }),
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
      posthog?.capture("four_in_a_row_game_started", { mode: "create", bet_amount: stake, game_id: data.gameId, timer_seconds: timerSeconds });
    } finally {
      setLoading(false);
    }
  };

  // FREE PRACTICE is open to signed-out guests: the page is a self-contained
  // client-side sandbox (no server match, no wager, no rating), so there is
  // nothing to protect. Only the ONLINE actions route to sign-in.
  const playVsAi = () => {
    posthog?.capture("four_in_a_row_game_started", { mode: "ai" });
    router.push("/casino/four-in-a-row/play-ai");
  };

  // Quick Join has no lobby in hand, so it takes the cheapest open game the
  // player can cover (the server escrows and refuses an unaffordable seat). A
  // specific lobby carries the stake the player saw in the list so the server
  // can prove the seat is funded at the agreed amount.
  const pickQuickJoinTarget = () => {
    const open = (availableGames || []).filter((g) => Number(g?.betAmount) >= MIN_STAKE);
    if (open.length === 0) return null;
    const affordable =
      coinBalance === null
        ? open
        : open.filter((g) => Number(g.betAmount) <= coinBalance);
    const pool = affordable.length > 0 ? affordable : open;
    return [...pool].sort((a, b) => Number(a.betAmount) - Number(b.betAmount))[0];
  };

  const joinGame = async (target?: { id: number; betAmount: number }) => {
    const chosen = target ?? pickQuickJoinTarget();
    if (!chosen) {
      setError("No open games right now. Be the first to create one.");
      return;
    }

    setLoading(true);
    setError(null);
    setJoiningId(chosen.id);

    try {
      const res = await fetch("/api/four-in-a-row/join-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: chosen.id, betAmount: chosen.betAmount }),
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
      posthog?.capture("four_in_a_row_game_started", { mode: target ? "join" : "quick_join", bet_amount: Number(chosen.betAmount), game_id: data.gameId });
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
                A ranked match plays for coins: both stakes are escrowed the
                moment an opponent joins, and the winner takes <b>1.8× their
                stake</b> (stake back + 80% of the loser's). Pick your stake
                above the Play button — an exact draw refunds both seats.
              </>
            ),
          },
          ],
        }}
        busy={loading}
        onPlay={createGame}
        playLabel="Create Game"
        playBusyLabel="Creating…"
        wager={{ value: stake, onChange: setStake, balance: coinBalance }}
        canPlay={stake >= MIN_STAKE}
        waitingSubtitle={`Matching you at ${stake} coins — both stakes are escrowed on match-up.`}
        vsAi={{
          label: "Play vs AI. Free, no wager",
          badge: "Free",
          disabled: false,
          busy: loading,
          onClick: playVsAi,
        }}
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
            <AiDifficultyPicker
              gameKey="four-in-a-row"
              value={aiDifficulty}
              onChange={setAiDifficulty}
              className="sm:col-span-2"
              hint={{
                easy: "The bot plays mostly at random and often misses the winning or blocking move.",
                normal: "The bot plays well, with the occasional slip.",
                hard: "The bot always takes a win, blocks yours, and picks its strongest column.",
              }}
            />
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
        lobbiesLoading={lobbiesLoading}
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
        onJoin={(l) => joinGame({ id: l.id, betAmount: Number(l.betAmount) })}
        joinBusyId={joiningId}
        onRefresh={fetchGames}
        error={error}
      />
    </>
  );
}
