"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import { IconTarget } from "@tabler/icons-react";
import AiDifficultyPicker from "../../../components/lobby/AiDifficultyPicker";
import { type AiDifficulty, readStoredAiDifficulty } from "../../../lib/aiDifficulty";
import { startVisibleInterval } from "../../../hooks/useVisiblePoll";


export default function PoolLobbyPage() {
  const router = useRouter();
  const [lobbies, setLobbies] = useState<any[]>([]);
  // False once the first list response lands, so the empty state never
  // flashes before the request resolves.
  const [lobbiesLoading, setLobbiesLoading] = useState(true);
  // STAKES ARE RETIRED (src/lib/games/stakes.js): a lobby is free to open.
  const wager = 0;
  const [loading, setLoading] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createdLobbyId, setCreatedLobbyId] = useState<string | null>(null);
  const [aiDifficulty, setAiDifficulty] = useState<AiDifficulty>(() =>
    readStoredAiDifficulty("pool-masters")
  );

  const load = async () => {
    try {
      const res = await fetch("/api/pool/lobbies", { cache: "no-store" });
      const data = await res.json();
      setLobbies(data.lobbies || []);
    } catch {
      // silent — poll retries next tick
    } finally {
      setLobbiesLoading(false);
    }
  };

  useEffect(() => {
    load();
    // Visibility-gated: a hidden lobby tab stops polling Postgres. This page is
    // the one lobby with no Socket.IO room to lean on, so it keeps a real poll;
    // the cadence is relaxed to 5s (it was 3s) as a floor until a lobby room is
    // added — see the runtime notes.
    return startVisibleInterval(load, 5000);
  }, []);
  useEffect(() => {
    if (!createdLobbyId) return;
    // Visibility-gated: nobody is waiting on a match from a background tab.
    // Relaxed from 1.2s to 3s: this is the match-found watch, and 3s is still
    // well inside the lobby's ready window while cutting these reads ~2.5x.
    return startVisibleInterval(async () => {
      const res = await fetch(`/api/pool/get-match?matchId=${createdLobbyId}`, {
        cache: "no-store",
      });
      const data = await res.json();
      const match = data?.match;
      if (match?.status === "active" && match?.id && match.id !== createdLobbyId) {
        router.push(`/casino/pool-masters/game/${match.id}`);
      }
    }, 3000);
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
        `/casino/pool-masters/game/${data.matchId}?ai=1&turn=${data.firstTurnSeat ?? 1}&difficulty=${aiDifficulty}`,
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <PvpLobbyPage
      title="Pool Masters Lobby"
      subtitle="Create or join a 1v1 pool match, or play the AI for free."
      icon={<IconTarget className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />}
      rulesKey="pool-masters"
      rules={{
        title: "How to Play",
        sections: [
          {
            heading: "1v1 8-ball pool",
            body: (
              <>
                Compete head-to-head over a free game of 8-ball pool.
                Take turns shooting. Pocket your group of balls, then the
                8-ball to win the match.
              </>
            ),
          },
          {
            heading: "Wager & pot",
            body: (
              <>
                Both players stake the same amount. The winner takes the
                pot minus the platform fee.
              </>
            ),
          },
          {
            heading: "Practice free",
            body: (
              <>
                Play vs AI at no cost to learn the game first.
              </>
            ),
          },
        ],
      }}
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
      children={
        <AiDifficultyPicker
          gameKey="pool-masters"
          value={aiDifficulty}
          onChange={setAiDifficulty}
          hint={{
            easy: "The bot misses badly and often shoots the wrong ball.",
            normal: "The bot aims well by default, with the occasional slip.",
            hard: "The bot always takes the nearest ball and barely misses.",
          }}
        />
      }
      lobbies={lobbies}
      lobbiesLoading={lobbiesLoading}
      lobbyEmptyText="No open lobbies yet. Be the first to make one."
      lobbyKey={(l) => l.id}
      lobbyTitle={(l) => (
        <>
          Lobby <span className="font-mono">{String(l.id).slice(-12)}</span>
        </>
      )}
      lobbyMeta={(l) => (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-semibold text-emerald-300">Free play</span>
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
