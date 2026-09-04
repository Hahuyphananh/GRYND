"use client";
import { useEffect, useState } from "react";
import { useDefaultWager } from "../../../hooks/useDefaultWager";
import { useRouter } from "next/navigation";
import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import { CoinIcon } from "../../../components/lobby/PvpLobby";
import { IconTarget } from "@tabler/icons-react";

const WAGER_OPTIONS = [10, 25, 50, 100];

export default function PoolLobbyPage() {
  const router = useRouter();
  const [lobbies, setLobbies] = useState<any[]>([]);
  const [wager, setWager] = useDefaultWager("pool-masters", 10);
  const [loading, setLoading] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createdLobbyId, setCreatedLobbyId] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/pool/lobbies", { cache: "no-store" });
      const data = await res.json();
      setLobbies(data.lobbies || []);
    } catch {
      // silent — poll retries next tick
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!createdLobbyId) return;
    const id = setInterval(async () => {
      const res = await fetch(`/api/pool/get-match?matchId=${createdLobbyId}`, {
        cache: "no-store",
      });
      const data = await res.json();
      const match = data?.match;
      if (match?.status === "active" && match?.id && match.id !== createdLobbyId) {
        router.push(`/casino/pool-masters/game/${match.id}`);
      }
    }, 1200);

    return () => clearInterval(id);
  }, [createdLobbyId, router]);

  const createLobby = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/pool/create-lobby", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wager }),
      });
      const data = await res.json();
      if (!data.lobbyId) {
        setError(data.error || "Unable to create lobby");
        return;
      }
      setCreatedLobbyId(data.lobbyId);
      router.push(`/casino/pool-masters/game/${data.lobbyId}`);
    } finally {
      setLoading(false);
    }
  };

  const joinLobby = async (lobby: any) => {
    setJoiningId(lobby.id);
    setError(null);
    try {
      const res = await fetch("/api/pool/join-lobby", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lobbyId: lobby.id }),
      });
      const data = await res.json();
      if (!data.matchId) {
        setError(data.error || "Unable to join lobby");
        return;
      }
      router.push(`/casino/pool-masters/game/${data.matchId}`);
    } finally {
      setJoiningId(null);
    }
  };

  const createAI = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/pool/create-ai-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wager }),
      });
      const data = await res.json();
      if (!data.matchId) {
        setError(data.error || "Unable to start AI match");
        return;
      }
      router.push(
        `/casino/pool-masters/game/${data.matchId}?ai=1&turn=${data.firstTurnSeat ?? 1}`,
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <PvpLobbyPage
      title="Pool Masters Lobby"
      subtitle="Create or join a wagered 1v1 pool match, or play the AI for free."
      icon={<IconTarget className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />}
      rulesKey="pool-masters"
      rules={{
        title: "How to Play",
        sections: [
          {
            heading: "1v1 8-ball pool",
            body: (
              <>
                Compete head-to-head over a wagered game of 8-ball pool.
                Take turns shooting. Pocket your group of balls, then the
                8-ball to win the match.
              </>
            ),
          },
          {
            heading: "Wager & pot",
            body: (
              <>
                Both players wager the same amount. The winner takes the
                pot minus the house fee.
              </>
            ),
          },
          {
            heading: "Practice free",
            body: (
              <>
                Play vs AI at no cost to learn the game before wagering
                real tokens.
              </>
            ),
          },
        ],
      }}
      balance={null}
      stake={wager}
      onStakeChange={setWager}
      stakeOptions={WAGER_OPTIONS}
      busy={loading}
      onPlay={createLobby}
      playLabel="Create PvP Game"
      playBusyLabel="Creating lobby…"
      vsAi={{
        label: "Play vs AI",
        badge: "Free",
        disabled: false,
        busy: loading,
        onClick: createAI,
      }}
      escrowNote="We pair you with another player of the exact same wager. If no one is waiting, your wager is escrowed in a private lobby until someone joins or you cancel."
      lobbies={lobbies}
      lobbyEmptyText="No open lobbies yet. Be the first to make one."
      lobbyKey={(l) => l.id}
      lobbyTitle={(l) => (
        <>
          Lobby <span className="font-mono">{String(l.id).slice(-12)}</span>
        </>
      )}
      lobbyMeta={(l) => (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            Wager:{" "}
            <span className="inline-flex items-center gap-1 font-semibold text-yellow-300">
              {Number(l.wager).toLocaleString()}
              <CoinIcon className="h-3.5 w-3.5 text-yellow-300" />
            </span>
          </span>
          <span className="capitalize">Mode: {l.gameMode}</span>
          <span className="text-white/40">Waiting for player</span>
        </span>
      )}
      onJoin={joinLobby}
      joinBusyId={joiningId}
      onRefresh={load}
      error={error}
    />
  );
}
