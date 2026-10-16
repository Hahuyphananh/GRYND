"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { usePostHog } from "posthog-js/react";
import { useSocket } from "../../../context/SocketProvider";
import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import { CoinIcon } from "../../../components/lobby/PvpLobby";
import { IconRuler } from "@tabler/icons-react";
import { useTranslation } from "../../../hooks/useTranslation";
import AiDifficultyPicker from "../../../components/lobby/AiDifficultyPicker";
import { useSocketAwarePoll } from "../../../hooks/useVisiblePoll";
import { useCoinBalance } from "../../../hooks/useCoinBalance";
import { MIN_STAKE } from "../../../lib/games/stakes";
import {
  type AiDifficulty,
  readStoredAiDifficulty,
} from "../../../lib/aiDifficulty";


export default function DotsAndBoxesLobbyPage() {
  const { isSignedIn, user } = useUser();
  const { socket } = useSocket();
  const router = useRouter();
  const posthog = usePostHog();
  const { t } = useTranslation();

  // Coin wager: the player picks the stake the lobby is opened at, and the
  // server escrows both seats the moment an opponent joins. A positive stake
  // is REQUIRED to enter a ranked match (PvP always plays for coins); the
  // vs-AI game stays free.
  const coinBalance = useCoinBalance();
  const [stake, setStake] = useState<number>(10);
  const [loading, setLoading] = useState(false);
  const [availableGames, setAvailableGames] = useState<any[]>([]);
  // False once the first list response lands, so the empty state never
  // flashes before the request resolves.
  const [lobbiesLoading, setLobbiesLoading] = useState(true);
  const [joiningId, setJoiningId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The AI tier the bot plays at, chosen in this lobby and remembered per
  // game by the picker; sent with the create-ai request.
  const [aiDifficulty, setAiDifficulty] = useState<AiDifficulty>(() =>
    readStoredAiDifficulty("dots-and-boxes"),
  );

  const fetchGames = async () => {
    try {
      const res = await fetch("/api/dots-and-boxes/available-games", {
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
    const roomId = "lobby:dots-and-boxes";
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
      const res = await fetch("/api/dots-and-boxes/create-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ betAmount: stake }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || t("games.dots_and_boxes.unable_to_create_alert"));
        return;
      }

      socket?.emit("room_event", {
        roomId: "lobby:dots-and-boxes",
        event: "lobby:updated",
      });
      router.push(`/casino/dots-and-boxes/game/${data.gameId}`);
      posthog?.capture("dots_and_boxes_game_started", {
        mode: "create",
        bet_amount: stake,
        game_id: data.gameId,
      });
    } finally {
      setLoading(false);
    }
  };

  const playAi = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dots-and-boxes/create-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ difficulty: aiDifficulty }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || "Unable to start AI game");
        return;
      }
      router.push(`/casino/dots-and-boxes/game/${data.gameId}`);
    } finally {
      setLoading(false);
    }
  };

  // Quick Join has no lobby in hand, so it takes the cheapest open game the
  // player can cover (the server escrows and refuses an unaffordable seat with
  // "Insufficient coins"). A specific lobby carries the stake the player saw in
  // the list so the server can prove the seat is funded at the agreed amount.
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
      setError(t("games.dots_and_boxes.no_open_games"));
      return;
    }

    setLoading(true);
    setError(null);
    setJoiningId(chosen.id);

    try {
      const res = await fetch("/api/dots-and-boxes/join-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: chosen.id, betAmount: chosen.betAmount }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        setError(data.error || t("games.dots_and_boxes.unable_to_join_alert"));
        return;
      }

      socket?.emit("room_event", {
        roomId: "lobby:dots-and-boxes",
        event: "lobby:updated",
      });
      router.push(`/casino/dots-and-boxes/game/${data.gameId}`);
      posthog?.capture("dots_and_boxes_game_started", {
        mode: target ? "join" : "quick_join",
        bet_amount: Number(chosen.betAmount),
        game_id: data.gameId,
      });
    } finally {
      setLoading(false);
      setJoiningId(null);
    }
  };

  return (
    <PvpLobbyPage
      title={t("games.dots_and_boxes_name")}
      subtitle={t("games.dots_and_boxes.lobby_subtitle")}
      icon={<IconRuler className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />}
      rulesKey="dots-and-boxes"
      rules={{
        title: "How to Play",
        sections: [
          {
            heading: "Classic pencil-and-paper game",
            body: (
              <>
                Take turns drawing lines between adjacent dots on the
                grid.
              </>
            ),
          },
          {
            heading: "Complete a box",
            body: (
              <>
                Complete the fourth side of a box to score a point and
                earn <b>another turn</b>.
              </>
            ),
          },
          {
            heading: "Win condition",
            body: (
              <>
                When every line is drawn, the player with the most
                completed boxes wins the match and the pot (minus the
                platform fee).
              </>
            ),
          },
        ],
      }}
      busy={loading}
      onPlay={createGame}
      playLabel={t("games.dots_and_boxes.create_button")}
      playBusyLabel={t("games.dots_and_boxes.creating")}
      wager={{ value: stake, onChange: setStake, balance: coinBalance }}
      canPlay={stake >= MIN_STAKE}
      waitingSubtitle={`Matching you at ${stake} coins — both stakes are escrowed on match-up.`}
      children={
        <AiDifficultyPicker
          gameKey="dots-and-boxes"
          value={aiDifficulty}
          onChange={setAiDifficulty}
          hint={{
            easy: "The bot draws a random legal line and ignores boxes entirely.",
            normal: "The bot completes boxes when it can, otherwise plays at random.",
            hard: "The bot completes boxes and never hands you a free one.",
          }}
        />
      }
      extraActions={
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={playAi}
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-cyan-400/40 bg-cyan-400/10 py-2 text-sm font-bold text-cyan-200 transition hover:bg-cyan-400/20 disabled:opacity-50"
          >
            Play Free vs AI
          </button>
          <button
          type="button"
          onClick={() => joinGame()}
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 py-2 text-sm font-bold text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-50"
        >
          {loading ? t("games.dots_and_boxes.joining") : t("games.dots_and_boxes.quick_join_button")}
          </button>
        </div>
      }
      lobbies={availableGames}
      lobbiesLoading={lobbiesLoading}
      lobbyEmptyText={t("games.dots_and_boxes.no_open_games")}
      lobbyKey={(l) => l.id}
      lobbyTitle={(l) => t("games.dots_and_boxes.game_row_label", { gameId: l.id })}
      lobbyMeta={(l) => (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            {t("games.dots_and_boxes.host_field")}: {l.hostName || t("games.dots_and_boxes.host_fallback")}
          </span>
          <span>
            {t("games.dots_and_boxes.bet_field")}:{" "}
            <span className="inline-flex items-center gap-1 font-semibold text-yellow-300">
              {Number(l.betAmount).toFixed(2)}
              <CoinIcon className="h-3.5 w-3.5 text-yellow-300" />
            </span>
          </span>
        </span>
      )}
      onJoin={(l) => joinGame({ id: l.id, betAmount: Number(l.betAmount) })}
      joinBusyId={joiningId}
      joinLabel={t("games.dots_and_boxes.join_button")}
      onRefresh={fetchGames}
      error={error}
    />
  );
}
