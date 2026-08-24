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

const BET_OPTIONS = [10, 25, 50, 100, 250];

export default function DotsAndBoxesLobbyPage() {
  const { isSignedIn, user } = useUser();
  const { socket } = useSocket();
  const router = useRouter();
  const posthog = usePostHog();
  const { t } = useTranslation();

  const [betAmount, setBetAmount] = useState(10);
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
      const res = await fetch("/api/dots-and-boxes/available-games", {
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
    if (betAmount <= 0 || betAmount > balance) {
      setError(t("games.dots_and_boxes.invalid_bet_alert"));
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dots-and-boxes/create-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ betAmount }),
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
        bet_amount: betAmount,
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
        body: JSON.stringify({}),
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

  const joinGame = async (gameId?: number) => {
    setLoading(true);
    setError(null);
    if (gameId) setJoiningId(gameId);

    try {
      const res = await fetch("/api/dots-and-boxes/join-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(gameId ? { gameId } : { quickJoin: true }),
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
        mode: gameId ? "join" : "quick_join",
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
                house fee).
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
      playLabel={t("games.dots_and_boxes.create_button")}
      playBusyLabel={t("games.dots_and_boxes.creating")}
      escrowNote={t("games.dots_and_boxes.lobby_tagline")}
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
      onJoin={(l) => joinGame(l.id)}
      joinBusyId={joiningId}
      joinLabel={t("games.dots_and_boxes.join_button")}
      onRefresh={fetchGames}
      error={error}
    />
  );
}
