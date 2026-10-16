"use client";

// ── Rock Paper Scissors lobby ──────────────────────────────────────────
// Mirrors the other casino PvP lobbies (shared PvpLobbyPage chrome):
//   * Balance + wager picker + "Create PvP Game" (escrows the wager,
//     routes to /casino/rps/game/[gameId] for the best-of-7 match).
//   * "Play vs AI — Free" routes to /casino/rps/play-ai, a self-contained
//     client-side best-of-7 sandbox (no wager, no server interaction).
//   * Live list of open lobbies (polled every 3s + realtime nudge).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { usePostHog } from "posthog-js/react";
import { useSocket } from "../../../context/SocketProvider";
import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import { CoinIcon } from "../../../components/lobby/PvpLobby";
import { RockFistIcon } from "../../../components/icons/CustomIcons";
import AiDifficultyPicker from "../../../components/lobby/AiDifficultyPicker";
import { useSocketAwarePoll } from "../../../hooks/useVisiblePoll";
import { useCoinBalance } from "../../../hooks/useCoinBalance";
import { MIN_STAKE } from "../../../lib/games/stakes";
import {
  type AiDifficulty,
  readStoredAiDifficulty,
} from "../../../lib/aiDifficulty";


export default function RPSLobbyPage() {
  // Kept so the page still tracks Clerk's session (guests included); the
  // ONLINE actions route to sign-in from the shared lobby, and free practice
  // is open to everyone.
  useUser();
  const { socket } = useSocket();
  const router = useRouter();
  const posthog = usePostHog();

  // Coin wager: the player picks the stake the lobby is opened at, and the
  // server escrows both seats when an opponent joins. A positive stake is
  // REQUIRED to enter a ranked match (PvP always plays for coins); only the
  // vs-AI sandbox is free.
  const coinBalance = useCoinBalance();
  const [stake, setStake] = useState<number>(10);
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
    readStoredAiDifficulty("rps"),
  );

  const fetchGames = async () => {
    try {
      const res = await fetch("/api/rps/pvp/available", {
        cache: "no-store",
      });
      const data = await res.json();
      if (data.success) setAvailableGames(data.data.games || []);
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
    const roomId = "lobby:rps";
    const refresh = () => fetchGames();

    socket.emit("join_room", { roomId });
    socket.on("lobby:updated", refresh);

    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("lobby:updated", refresh);
    };
  }, [socket]);

  // A ranked RPS match always plays for coins: with no stake there is nothing
  // to escrow, so the Play action is refused here (and the shared lobby
  // disables the button through `canPlay`).
  const createGame = async () => {
    if (stake < MIN_STAKE) {
      setError(`Pick a stake of at least ${MIN_STAKE} coin to open a game.`);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/rps/pvp/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ betAmount: stake }),
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
        bet_amount: stake,
        game_id: data.data.gameId,
      });
    } finally {
      setLoading(false);
    }
  };

  // FREE PRACTICE is open to signed-out guests: /casino/rps/play-ai is a
  // self-contained client-side sandbox (no server match, no wager, no reward),
  // so there is nothing to gate. Only the ONLINE actions route to sign-in.
  const playVsAi = () => {
    posthog?.capture("rps_game_started", { mode: "ai", bet_amount: 0 });
    router.push("/casino/rps/play-ai");
  };

  // Quick Join has no lobby in hand, so it takes the cheapest open game the
  // player can actually cover (the server still escrows and refuses an
  // unaffordable seat). Without a chosen lobby there is nothing to match on.
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
      const res = await fetch("/api/rps/pvp/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The stake travels with the join request so the server can prove the
        // seat is being escrowed at the amount the player actually chose — a
        // crafted request cannot drop a player into a table they never agreed
        // to.
        body: JSON.stringify({ gameId: chosen.id, betAmount: chosen.betAmount }),
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
      // Poke the waiting creator's match room: this joiner is the one who turns
      // their `active` game into `matched`, and RPS has no server push for it.
      socket?.emit("room_event", {
        roomId: `rps-pvp:match:${data.data.gameId}`,
        event: "lobby:updated",
      });
      router.push(`/casino/rps/game/${data.data.gameId}`);
      posthog?.capture("rps_game_started", {
        mode: target ? "join" : "quick_join",
        bet_amount: Number(chosen.betAmount),
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
                A ranked match plays for coins: both stakes are escrowed the
                moment an opponent joins, and the best-of-7 winner takes{" "}
                <b>1.9× their stake</b> (stake back + 90% of the loser's). Pick
                your stake above the Play button — an exact draw refunds both
                seats.
              </>
            ),
          },
        ],
      }}
      busy={loading}
      onPlay={createGame}
      playLabel="Create PvP Game"
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
      lobbiesLoading={lobbiesLoading}
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
      onJoin={(l) => joinGame({ id: l.id, betAmount: Number(l.betAmount) })}
      joinBusyId={joiningId}
      onRefresh={fetchGames}
      error={error}
    />
  );
}
