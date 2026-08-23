"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import { CoinIcon } from "../../../components/lobby/PvpLobby";
import { IconDice } from "@tabler/icons-react";

const WAGER_OPTIONS = [5, 10, 25, 50, 100];

export default function DiceDuelLobbyPage() {
  const [lobbies, setLobbies] = useState<any[]>([]);
  const [wager, setWager] = useState(10);
  const [loading, setLoading] = useState(false);
  const [tokens, setTokens] = useState<number | null>(null);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const posthog = usePostHog();

  const loadTokens = async () => {
    try {
      const res = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (data.success) setTokens(Number(data.data.balance));
    } catch {
      // silent
    }
  };

  const load = async () => {
    try {
      const res = await fetch("/api/dice-duel/lobbies", { cache: "no-store" });
      const data = await res.json();
      setLobbies(data.lobbies || []);
    } catch {
      // silent
    }
  };

  useEffect(() => {
    load();
    loadTokens();
    const id = setInterval(() => {
      load();
      loadTokens();
    }, 3000);
    return () => clearInterval(id);
  }, []);

  const createLobby = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dice-duel/create-lobby", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wager }),
      });
      const data = await res.json();
      if (!data.lobbyId) {
        setError(data.error || "Unable to create lobby");
        return;
      }
      router.push(`/casino/dice-duel/game/${data.lobbyId}`);
      posthog?.capture("dice_duel_game_started", { mode: "pvp", wager, lobby_id: data.lobbyId });
    } finally {
      setLoading(false);
    }
  };

  const joinLobby = async (lobby: any) => {
    setJoiningId(lobby.id);
    setError(null);
    try {
      const res = await fetch("/api/dice-duel/join-lobby", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lobbyId: lobby.id }),
      });
      const data = await res.json();
      router.push(`/casino/dice-duel/game/${data.matchId || lobby.id}`);
      posthog?.capture("dice_duel_game_started", { mode: "pvp_join", lobby_id: lobby.id });
    } finally {
      setJoiningId(null);
    }
  };

  const playAI = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dice-duel/create-ai-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wager }),
      });
      const data = await res.json();
      if (data.matchId) {
        router.push(`/casino/dice-duel/game/${data.matchId}`);
        posthog?.capture("dice_duel_game_started", { mode: "ai", wager: 0 });
      } else {
        setError(data.message || "Unable to start game");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <PvpLobbyPage
      title="Dice Duel Arena"
      subtitle="Turn-based cyberpunk PvP with wagered tokens, or play the AI for free."
      icon={<IconDice className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />}
      rulesKey="dice-duel"
      rules={{
        title: "How to Play",
        sections: [
          {
            heading: "Dice combat",
            body: (
              <>
                Turn-based cyberpunk dice duel. Each player starts with{" "}
                <b>20 HP</b>; max 20 rounds; reach 0 HP to lose.
              </>
            ),
          },
          {
            heading: "Safe Roll (1 die)",
            body: <>1–2 → 0 damage · 3–4 → 2 damage · 5–6 → 4 damage.</>,
          },
          {
            heading: "Power Roll (2 dice)",
            body: (
              <>
                2–4 → take 3 damage · 5–7 → deal 3 · 8–10 → deal 6 ·
                11–12 → deal 8.
              </>
            ),
          },
          {
            heading: "Shield (1 die)",
            body: <>1–3 → heal 2 HP · 4–6 → heal 3 HP.</>,
          },
          {
            heading: "Double Down (2 dice)",
            body: <>2–7 → take 5 self damage · 8–12 → deal 10 damage.</>,
          },
        ],
      }}
      balance={tokens}
      stake={wager}
      onStakeChange={setWager}
      stakeOptions={WAGER_OPTIONS}
      busy={loading}
      onPlay={createLobby}
      playLabel="Create PvP Lobby"
      playBusyLabel="Creating lobby…"
      vsAi={{
        label: "Play vs AI",
        badge: "Free",
        disabled: false,
        busy: loading,
        onClick: playAI,
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
          <span className="text-white/40">Status: {l.status}</span>
        </span>
      )}
      onJoin={joinLobby}
      joinBusyId={joiningId}
      onRefresh={load}
      error={error}
    />
  );
}
