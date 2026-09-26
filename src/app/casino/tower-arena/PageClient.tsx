"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useSocket } from "../../../context/SocketProvider";
import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import { CoinIcon } from "../../../components/lobby/PvpLobby";
import { IconBuildingSkyscraper } from "@tabler/icons-react";
import AiDifficultyPicker from "../../../components/lobby/AiDifficultyPicker";
import {
  type AiDifficulty,
  readStoredAiDifficulty,
} from "../../../lib/aiDifficulty";

// Any 2–6 is supported; the creator's pick decides when the lobby is full.
const PLAYER_COUNT_OPTIONS = [2, 3, 4, 5, 6];

export default function TowerArenaLobbyPage() {
  const [lobbies, setLobbies] = useState<any[]>([]);
  // STAKES ARE RETIRED (src/lib/games/stakes.js): a lobby is free to open,
  // so there is no wager to pick and no token balance to load.
  const wager = 0;
  const [maxPlayers, setMaxPlayers] = useState(6);
  // The AI tier the bots place at, chosen in this lobby and remembered per
  // game by the picker; sent with the create-ai request.
  const [aiDifficulty, setAiDifficulty] = useState<AiDifficulty>(() =>
    readStoredAiDifficulty("tower-arena"),
  );
  const [loading, setLoading] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();

  const load = async () => {
    try {
      const res = await fetch("/api/tower-arena/lobbies", { cache: "no-store" });
      const data = await res.json();
      setLobbies(data.lobbies || []);
    } catch {
      // silent
    }
  };

  // The prize pool preview is computed server-side (centralized payout config).
  const loadPreview = async () => {
    try {
      const res = await fetch(
        `/api/tower-arena/payout-preview?wager=${wager}&maxPlayers=${maxPlayers}`,
        { cache: "no-store" },
      );
      const data = await res.json();
      if (data.ok) setPreview(data.preview);
    } catch {
      // silent
    }
  };

  // Recompute preview whenever the wager or player count changes.
  useEffect(() => {
    const t = setTimeout(loadPreview, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wager, maxPlayers]);

  useEffect(() => {
    load();
    loadPreview();
    const id = setInterval(() => {
      load();
    }, 3000);
    return () => clearInterval(id);
  }, []);

  // Listen on the shared lobby grid room so open-lobby rows refresh the
  // instant one is created / filled / cancelled (three-second poll as backstop).
  useEffect(() => {
    if (!socket) return;
    const roomId = "tower-arena:lobbies";
    socket.emit("join_room", { roomId });
    const onUpdate = () => load();
    socket.on("tower-arena:lobbies:updated", onUpdate);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("tower-arena:lobbies:updated", onUpdate);
    };
  }, [socket]);

  const createLobby = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/tower-arena/create-lobby", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wager, maxPlayers }),
      });
      const data = await res.json();
      if (!data.match?.id) {
        setError(data.error || data.message || "Unable to create lobby");
        return;
      }
      posthog?.capture("tower_arena_lobby_created", {
        playerCount: maxPlayers,
        wagerTier: wager,
        lobbyType: "pvp",
      });
      router.push(`/casino/tower-arena/game/${data.match.id}`);
    } finally {
      setLoading(false);
    }
  };

  const playAI = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/tower-arena/create-ai-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxPlayers, difficulty: aiDifficulty }),
      });
      const data = await res.json();
      if (data.matchId) {
        posthog?.capture("tower_arena_lobby_created", {
          playerCount: maxPlayers,
          wagerTier: 0,
          lobbyType: "ai_freeplay",
        });
        router.push(`/casino/tower-arena/game/${data.matchId}`);
      } else {
        setError(data.message || "Unable to start free play");
      }
    } finally {
      setLoading(false);
    }
  };

  const joinLobby = async (lobby: any) => {
    setJoiningId(lobby.id);
    setError(null);
    try {
      const res = await fetch("/api/tower-arena/join-lobby", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lobbyId: lobby.id }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Unable to join lobby");
        return;
      }
      posthog?.capture("tower_arena_lobby_joined", {
        playerCount: maxPlayers,
        wagerTier: lobby.wager,
        lobbyType: "pvp",
      });
      router.push(`/casino/tower-arena/game/${data.match?.id || lobby.id}`);
    } finally {
      setJoiningId(null);
    }
  };

  return (
    <PvpLobbyPage
      title="Tower Arena"
      subtitle="Shared 2D Tower Survival — for 2 to 6 players. Drop blocks from the sky onto a tiny floating platform and outlast every rival."
      icon={
        <IconBuildingSkyscraper className="h-9 w-9 flex-shrink-0 text-cyan-400 drop-shadow-[0_0_12px_rgba(34,211,238,0.6)] sm:h-10 sm:w-10" />
      }
      rulesKey="tower-arena"
      rules={{
        title: "How to Play",
        sections: [
          {
            heading: "Drop & stack",
            body: (
              <>
                Tower Arena is a competitive survival game for{" "}
                <b>2–6 players</b>. The board is a 2D line: everyone builds
                one shared tower on a small floating platform with open sky
                around it. On your turn, pick a block (the shared pool, or
                your reserved one) and <b>drop it from the sky</b> — aim it
                at the top of the board, rotate with R, then click to let it
                fall. Blocks are slightly slippery: an off-balance landing
                slips a little before it settles.
              </>
            ),
          },
          {
            heading: "The void",
            body: (
              <>
                The platform floats in a bottomless void with <b>no side
                walls</b> — you can aim anywhere, even off the platform. A
                block only stays if enough of its base touches what’s below
                and its center of mass — plus whatever is stacked on it —
                sits over the support. A bad landing tips: it can knock
                blocks off the tower in the shock. <b>Whenever a block falls
                into the void, the player whose turn it was is eliminated</b>
                — and the game continues with whatever tower remains, even
                if that means an empty platform.
              </>
            ),
          },
          {
            heading: "Limited blocks & reserve",
            body: (
              <>
                The <b>shared pool holds a limited number of blocks</b> —
                when it runs dry or someone falls, it refills so the match
                keeps moving. Each round you may <b>reserve</b> one block
                (limited uses) so it becomes private — and it shows up as an
                option on your next drop. The tower is never reset: it always
                continues in the state the last drop left it in.
              </>
            ),
          },
          {
            heading: "Win & payout",
            body: (
              <>
                Final placement follows elimination order — the last player
                standing wins the match. Nothing is staked and no prize pool
                is paid; free play only.
              </>
            ),
          },
        ],
      }}
      busy={loading}
      onPlay={createLobby}
      playLabel="Create PvP Lobby"
      playBusyLabel="Creating lobby…"
      vsAi={{
        label: "Free Play vs Bots",
        badge: "Free",
        disabled: false,
        busy: loading,
        onClick: playAI,
      }}
      lobbies={lobbies}
      lobbyEmptyText="No open Tower Arenas yet. Be the first to start one."
      lobbyKey={(l) => l.id}
      lobbyTitle={(l) => (
        <>
          Tower Arena{" "}
          <span className="font-mono">{String(l.id).slice(-8)}</span>
        </>
      )}
      lobbyMeta={(l) => (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-semibold">
            {l.playerCount ?? 0} / {l.maxPlayers} players
          </span>
          <span>
            Entry:{" "}
            <span className="inline-flex items-center gap-1 font-semibold text-yellow-300">
              {Number(l.wager).toLocaleString()}
              <CoinIcon className="h-3.5 w-3.5 text-yellow-300" />
            </span>
          </span>
          <span className="text-white/40">
            Prize: ~{Number(l.prizePool ?? 0).toLocaleString()}
          </span>
        </span>
      )}
      onJoin={joinLobby}
      joinBusyId={joiningId}
      onRefresh={load}
      error={error}
      waitingSubtitle={`Waiting for a ${maxPlayers}-player Tower Arena to fill…`}
    >
      <AiDifficultyPicker
        gameKey="tower-arena"
        value={aiDifficulty}
        onChange={setAiDifficulty}
        hint={{
          easy: "The bots drop random shapes at random columns — expect collapses.",
          normal: "The bots place their safest available block.",
          hard: "The bots place their safest available block.",
        }}
      />
      {/* Player-count selector (2–6) — the creator pick determines when full */}
      <div className="mt-4">
        <label className="text-[10px] font-semibold uppercase tracking-wider text-white/60">
          Players
        </label>
        <div className="mt-1 flex flex-wrap gap-1">
          {PLAYER_COUNT_OPTIONS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setMaxPlayers(v)}
              className={`rounded-full border px-3 py-1 text-[11px] font-bold transition ${
                maxPlayers === v
                  ? "border-cyan-400 bg-cyan-500/20 text-cyan-200"
                  : "border-gray-600 bg-gray-800/50 text-gray-400 hover:border-cyan-600/50 hover:text-cyan-200"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
        {preview && (
          <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-cyan-700/30 bg-black/30 p-3 text-xs sm:grid-cols-4">
            <div>
              <p className="text-white/50">Total pot</p>
              <p className="font-bold text-white">
                {Number(preview.pot).toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-white/50">Platform rake</p>
              <p className="font-bold text-white/70">
                {Number(preview.houseFee).toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-white/50">Prize pool</p>
              <p className="font-bold text-cyan-300">
                {Number(preview.prizePool).toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-white/50">Payout</p>
              <p className="font-bold text-white/70">by placement</p>
            </div>
          </div>
        )}
      </div>
    </PvpLobbyPage>
  );
}