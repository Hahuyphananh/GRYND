"use client";

import { useEffect, useRef, useState } from "react";
import PlayerTank from "../../../../../components/PlayerTank";
import { useParams, useRouter } from "next/navigation";
import WaitingRoom from "./components/WaitingRoom";
import { useSocket } from "../../../../../context/SocketProvider";
import { useUser } from "@clerk/nextjs";

function showGameAlert(message: string) {
  const overlay = document.createElement("div");
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.background = "rgba(0,0,0,0.65)";
  overlay.style.display = "flex";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.zIndex = "999999";

  const box = document.createElement("div");
  box.style.background = "#111";
  box.style.border = "2px solid #eab308";
  box.style.padding = "28px";
  box.style.borderRadius = "16px";
  box.style.color = "white";
  box.style.fontFamily = "sans-serif";
  box.style.textAlign = "center";
  box.style.boxShadow = "0 10px 40px rgba(0,0,0,0.6)";
  box.style.maxWidth = "360px";

  const text = document.createElement("div");
  text.style.fontSize = "18px";
  text.style.marginBottom = "18px";
  text.innerText = message;

  const btn = document.createElement("button");
  btn.innerText = "OK";
  btn.style.background = "#eab308";
  btn.style.border = "none";
  btn.style.padding = "10px 18px";
  btn.style.borderRadius = "10px";
  btn.style.fontWeight = "bold";
  btn.style.cursor = "pointer";

  btn.onclick = () => {
    document.body.removeChild(overlay);
  };

  box.appendChild(text);
  box.appendChild(btn);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function CashOutButton({ bountyRef, setBounty, setCashOutCountdown, routeMatchId }) {
  const [countdown, setCountdown] = useState(0);
  const countdownRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const router = useRouter();

  const handleCashOut = () => {
    if (countdownRef.current > 0) return;

    const duration = 5;
    const startTime = performance.now();
    countdownRef.current = duration;
    setCountdown(duration);
    setCashOutCountdown(duration);

    const animate = (time: number) => {
      const elapsed = (time - startTime) / 1000;
      const remaining = Math.max(0, duration - elapsed);

      countdownRef.current = remaining;
      setCountdown(remaining);
      setCashOutCountdown(remaining);

      if (remaining > 0) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        countdownRef.current = 0;
        setCountdown(0);
        setCashOutCountdown(0);

        (async () => {
          try {
            const res = await fetch("/api/tanks/cashout", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ matchId: routeMatchId }),
            });
            const data = await res.json();

            if (res.ok) {
             showGameAlert(`💰 Cashout successful!\nYou received ${bountyRef.current * 0.9} tokens`);
              setBounty(0);
              bountyRef.current = 0;
              router.push("/casino/tanks");
            } else {
              showGameAlert(data.error || "Failed to cash out");
            }
          } catch (err) {
            console.error("Cashout error:", err);
            showGameAlert("Server error while cashing out");
          }
        })();
      }
    };

    rafRef.current = requestAnimationFrame(animate);
  };

  return (
    <button
      style={{ pointerEvents: "auto" }}
      onClick={handleCashOut}
      disabled={countdown > 0}
      className={`mt-2 w-full p-2 rounded-xl font-bold text-white ${
        countdown > 0 ? "bg-gray-600 cursor-not-allowed" : "bg-yellow-600 hover:bg-yellow-700"
      }`}
    >
      {countdown > 0 ? `Cashing out in ${Math.ceil(countdown)}s` : "Cash Out"}
    </button>
  );
}

type BulletState = {
  id?: number;
  x: number;
  y: number;
  angle: number;
};

type RockState = {
  id: number;
  x: number;
  y: number;
  size: number;
};

type PlayerState = {
  x: number;
  y: number;
  rotation: number;
  health: number;
  ammo?: number;
  bullets?: BulletState[];
  updatedAt?: number;
};

const BATTLE_ROYALE_TANK_COLORS = [
  "#16a34a", // green
  "#dc2626", // red
  "#2563eb", // blue
  "#f59e0b", // amber
  "#9333ea", // purple
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
  "#f97316", // orange
  "#6b7280", // gray
];

const MAP_PROFILES = {
  classic: {
    width: 3000,
    height: 3000,
    rockCount: 52,
  },
  duel_small: {
    width: 2200,
    height: 2200,
    rockCount: 30,
  },
} as const;

export default function TanksGamePage() {
  const router = useRouter();
  const params = useParams<{ matchId: string }>();
  const routeMatchId = params?.matchId;
  const { socket } = useSocket();
  const { user } = useUser();

  const [mapProfile, setMapProfile] = useState<keyof typeof MAP_PROFILES>("classic");
  const [minPlayersToStart, setMinPlayersToStart] = useState(2);
  const [maxPlayers, setMaxPlayers] = useState(2);
  const [gameMode, setGameMode] = useState<"duel" | "battle_royale">("duel");
  const MAP_WIDTH = MAP_PROFILES[mapProfile].width;
  const MAP_HEIGHT = MAP_PROFILES[mapProfile].height;
  const [serverMap, setServerMap] = useState<{ width: number; height: number; rocks: RockState[] } | null>(null);
  const worldWidth = serverMap?.width ?? MAP_WIDTH;
  const worldHeight = serverMap?.height ?? MAP_HEIGHT;
  const rocks = serverMap?.rocks ?? [];

  const [pos, setPos] = useState({ x: 1500, y: 1500 });
  const posRef = useRef(pos);
  posRef.current = pos;
  const positionInitializedRef = useRef(false);

  const MAX_HEALTH = 5;
  const [health, setHealth] = useState(MAX_HEALTH);
  const healthRef = useRef(health);
  healthRef.current = health;

  const [cashOutCountdown, setCashOutCountdown] = useState(0);
  const [tokenBalance, setTokenBalance] = useState<number | null>(null);

  const [bounty, setBounty] = useState(0);
  const bountyRef = useRef(bounty);
  bountyRef.current = bounty;

  const MAX_AMMO = 5;
  const [ammo, setAmmo] = useState(MAX_AMMO);
  const ammoRef = useRef(ammo);
  ammoRef.current = ammo;

  const [isMatchReady, setIsMatchReady] = useState(false);
  const [matchId, setMatchId] = useState<string | null>(routeMatchId ?? null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const selfIdRef = useRef<string | null>(null);
  selfIdRef.current = selfId;
  const [remotePlayers, setRemotePlayers] = useState<Record<string, PlayerState>>({});
  const remotePlayersRef = useRef(remotePlayers);
  remotePlayersRef.current = remotePlayers;

  const [renderRemotePlayers, setRenderRemotePlayers] = useState<Record<string, PlayerState>>({});
  const renderRemotePlayersRef = useRef(renderRemotePlayers);
  renderRemotePlayersRef.current = renderRemotePlayers;

  const pendingHitsRef = useRef<string[]>([]);
  const gameFinishedRef = useRef(false);
  const immediateSyncRef = useRef<(() => Promise<void>) | null>(null);

  const [mapSeed, setMapSeed] = useState<number>(12345);
  const [playerNames, setPlayerNames] = useState<Record<string, string>>({});
  const [playerJoinOrder, setPlayerJoinOrder] = useState<string[]>([]);

  const [rotation, setRotation] = useState(0);
  const rotationRef = useRef(rotation);
  rotationRef.current = rotation;

  const [serverBullets, setServerBullets] = useState<BulletState[]>([]);
  const targetBulletsRef = useRef<BulletState[]>([]);
  const [duelResult, setDuelResult] = useState<{ didWin: boolean; amount: number } | null>(null);

  const keys = useRef<{ [key: string]: boolean }>({});
  const INPUT_TICK_MS = 33;
  const WATER_Y = worldHeight * 0.67;
  const SHORE_TRANSITION = 130;

  const hitSoundCtxRef = useRef<AudioContext | null>(null);
  const selfHitUntilRef = useRef(0);
  const [selfHitIntensity, setSelfHitIntensity] = useState(0);
  const remoteHitUntilRef = useRef<Record<string, number>>({});
  const [remoteHitIntensity, setRemoteHitIntensity] = useState<Record<string, number>>({});
  const rafLoopRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);

  const isWaterTile = (y: number) => y >= WATER_Y;


  const playHitSound = () => {
    if (typeof window === "undefined") return;
    try {
      const ctx = hitSoundCtxRef.current ?? new window.AudioContext();
      hitSoundCtxRef.current = ctx;
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(210, now);
      osc.frequency.exponentialRampToValueAtTime(120, now + 0.12);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.09, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.19);
    } catch (err) {
      console.warn("Unable to play hit sound", err);
    }
  };

  useEffect(() => {
    if (!user?.id) return;
    setSelfId((prev) => prev ?? user.id);
    setPlayerNames((prev) => {
      if (prev[user.id]) return prev;
      const displayName =
        user.username ||
        [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
        user.primaryEmailAddress?.emailAddress?.split("@")[0] ||
        "You";
      return { ...prev, [user.id]: displayName };
    });
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const fetchTokens = async () => {
      try {
        const res = await fetch("/api/get-user-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });
        const data = await res.json();
        if (res.ok && data?.success) {
          setTokenBalance(Number(data?.data?.balance ?? 0));
        }
      } catch (err) {
        console.error("Failed loading token balance in tanks match:", err);
      }
    };
    fetchTokens();
  }, [user]);

  useEffect(() => {
    setMatchId(routeMatchId ?? null);
    if (!routeMatchId) return;

    const checkMatch = async () => {
      try {
        const res = await fetch(`/api/tanks/get-match?matchId=${routeMatchId}`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          cache: "no-store",
        });
        const data = await res.json();

        const modeFromServer = data?.settings?.mode === "battle_royale" ? "battle_royale" : "duel";
        const profileFromServer = data?.settings?.mapProfile === "duel_small" ? "duel_small" : "classic";
        const maxPlayersFromServer = Number(data?.maxPlayers ?? (modeFromServer === "battle_royale" ? 10 : 2));
        const minRequired = 2;
        setGameMode(modeFromServer);
        setMapProfile(profileFromServer);
        setMaxPlayers(maxPlayersFromServer);
        setMinPlayersToStart(minRequired);

        if (modeFromServer === "battle_royale" || data?.gameStarted || (modeFromServer === "duel" && Number(data.currentPlayers ?? 0) >= minRequired)) {
          setIsMatchReady(true);
        }

        if (data?.settings?.mapSeed !== undefined) {
          setMapSeed(Number(data.settings.mapSeed));
        }

        if (data?.bounty !== undefined && data?.bounty !== null) {
          setBounty(Number(data.bounty));
          bountyRef.current = Number(data.bounty);
        }

        if (Array.isArray(data?.players)) {
          setPlayerJoinOrder(data.players.filter((playerId: unknown): playerId is string => typeof playerId === "string"));
        }

        if (Array.isArray(data?.playersStats)) {
          const namesById: Record<string, string> = {};
          for (const stat of data.playersStats) {
            if (typeof stat?.clerkId === "string" && typeof stat?.username === "string") {
              namesById[stat.clerkId] = stat.username;
            }
          }
          setPlayerNames(namesById);
        }
      } catch (err) {
        console.error("Error fetching match:", err);
      }
    };

    checkMatch();
    const interval = setInterval(checkMatch, 4000);
    return () => clearInterval(interval);
  }, [routeMatchId]);

  useEffect(() => {
    if (!routeMatchId) return;

    const missingIds = [
      ...(selfId ? [selfId] : []),
      ...Object.keys(remotePlayers),
    ].filter((id) => id && !playerNames[id]);

    if (missingIds.length === 0) return;

    const hydrateNames = async () => {
      try {
        const res = await fetch(`/api/tanks/get-match?matchId=${routeMatchId}`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          cache: "no-store",
        });
        const data = await res.json();
        if (!res.ok || !Array.isArray(data?.playersStats)) return;

        const namesById: Record<string, string> = {};
        for (const stat of data.playersStats) {
          if (typeof stat?.clerkId === "string" && typeof stat?.username === "string" && stat.username.trim()) {
            namesById[stat.clerkId] = stat.username;
          }
        }
        if (Object.keys(namesById).length > 0) {
          setPlayerNames((prev) => ({ ...prev, ...namesById }));
        }
      } catch (err) {
        console.error("Failed hydrating tank names:", err);
      }
    };

    hydrateNames();
  }, [routeMatchId, selfId, remotePlayers, playerNames]);

  useEffect(() => {
    if (!socket || !routeMatchId) return;

    socket.emit("tanks:join_game", {
      gameId: routeMatchId,
      settings: {
        mapWidth: MAP_WIDTH,
        mapHeight: MAP_HEIGHT,
        mapSeed,
        rockCount: MAP_PROFILES[mapProfile].rockCount,
        maxHealth: MAX_HEALTH,
      },
    });

    const handleGameState = (payload: {
      players?: Record<string, PlayerState>;
      bullets?: BulletState[];
      map?: { width?: number; height?: number; rocks?: RockState[] };
    }) => {
      const players = payload?.players ?? {};
      const bullets = Array.isArray(payload?.bullets) ? payload.bullets : [];
      if (payload?.map && Array.isArray(payload.map.rocks)) {
        setServerMap({
          width: Number(payload.map.width ?? MAP_WIDTH),
          height: Number(payload.map.height ?? MAP_HEIGHT),
          rocks: payload.map.rocks,
        });
      }

      const currentSelfId = selfIdRef.current;
      if (currentSelfId && players[currentSelfId]) {
        const own = players[currentSelfId];
        if (own.health <= 0 && !gameFinishedRef.current) {
          gameFinishedRef.current = true;
          if (gameMode === "duel") {
            setDuelResult({ didWin: false, amount: 0 });
          } else {
            showGameAlert("💀 You were destroyed");
            fetch("/api/tanks/leave-match", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ gameId: routeMatchId, reason: "eliminated" }),
            }).finally(() => router.push("/casino/tanks"));
          }
          return;
        }
        if (own.health < healthRef.current) {
          selfHitUntilRef.current = performance.now() + 220;
          playHitSound();
        }
        healthRef.current = own.health;
        setHealth(own.health);
        if (typeof own.ammo === "number") {
          ammoRef.current = own.ammo;
          setAmmo(own.ammo);
        }
        posRef.current = { x: own.x, y: own.y };
        setPos({ x: own.x, y: own.y });
        positionInitializedRef.current = true;
      }

      const others = Object.fromEntries(
        Object.entries(players).filter(([id]) => id !== currentSelfId)
      ) as Record<string, PlayerState>;

      for (const [id, nextState] of Object.entries(others)) {
        const previous = remotePlayersRef.current[id];
        if (previous && typeof nextState.health === "number" && nextState.health < previous.health) {
          remoteHitUntilRef.current[id] = performance.now() + 220;
          playHitSound();
        }
      }

      setRemotePlayers(others);
      targetBulletsRef.current = bullets;
    };

    const handleHit = (payload: { attackerId?: string; targetId?: string }) => {
      if (payload?.attackerId === selfIdRef.current && payload?.targetId) {
        pendingHitsRef.current.push(payload.targetId);
        immediateSyncRef.current?.();
      }
    };

    socket.on("tanks:game_state", handleGameState);
    socket.on("tanks:hit", handleHit);

    return () => {
      socket.emit("tanks:leave_game", { gameId: routeMatchId });
      socket.off("tanks:game_state", handleGameState);
      socket.off("tanks:hit", handleHit);
    };
  }, [socket, routeMatchId, MAP_WIDTH, MAP_HEIGHT, mapSeed, mapProfile, gameMode, router]);

  useEffect(() => {
    if (!routeMatchId) return;

    const syncState = async () => {
      try {
        const res = await fetch("/api/tanks/update-state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            matchId: routeMatchId,
            x: positionInitializedRef.current ? posRef.current.x : undefined,
            y: positionInitializedRef.current ? posRef.current.y : undefined,
            rotation: rotationRef.current,
            hits: pendingHitsRef.current.splice(0),
            bullets: [],
          }),
        });

        if (!res.ok) {
          if ((res.status === 403 || res.status === 404) && !gameFinishedRef.current) {
            gameFinishedRef.current = true;
            showGameAlert("Match ended. Returning to lobby.");
            router.push("/casino/tanks");
          }
          return;
        }

        const data = await res.json();
        setSelfId(data.selfId);

        if (!positionInitializedRef.current && data?.playerStates && data?.selfId && data.playerStates[data.selfId]) {
          const own = data.playerStates[data.selfId];
          if (Number.isFinite(Number(own?.x)) && Number.isFinite(Number(own?.y))) {
            posRef.current = { x: Number(own.x), y: Number(own.y) };
            setPos({ x: Number(own.x), y: Number(own.y) });
            positionInitializedRef.current = true;
          }
          if (Number.isFinite(Number(own?.health))) {
            healthRef.current = Number(own.health);
            setHealth(Number(own.health));
          }
        }

        if (data?.gameOver && !gameFinishedRef.current) {
          gameFinishedRef.current = true;
          if (gameMode === "duel") {
            const didWin = data.gameOver.winnerId === data.selfId;
            setDuelResult({ didWin, amount: didWin ? Number(data.gameOver.winnerPayout ?? 0) : 0 });
          } else {
            if (data.gameOver.winnerId === data.selfId) {
              showGameAlert(`🏆 Victory!\n+${Number(data.gameOver.winnerPayout).toFixed(2)} tokens`);
            } else {
              showGameAlert("💀 You were destroyed");
            }
            router.push("/casino/tanks");
          }
        }
      } catch (err) {
        console.error("State sync error:", err);
      }
    };

    immediateSyncRef.current = syncState;

    syncState();
    const interval = setInterval(syncState, 220);
    return () => {
      clearInterval(interval);
      immediateSyncRef.current = null;
    };
  }, [routeMatchId, router, gameMode]);

  useEffect(() => {
    if (!routeMatchId) return;
    const handleBeforeUnload = () => {
      const payload = new Blob([JSON.stringify({ gameId: routeMatchId, reason: "disconnect" })], {
        type: "application/json",
      });
      navigator.sendBeacon("/api/tanks/leave-match", payload);
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [routeMatchId]);

  useEffect(() => {
    if (!routeMatchId) return;
    const parsedGameId = Number(routeMatchId);
    if (!Number.isFinite(parsedGameId)) return;

    const pingPresence = async () => {
      await fetch("/api/presence/game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ gameKey: "tanks", gameId: parsedGameId }),
      });
    };

    pingPresence();
    const id = setInterval(pingPresence, 15000);
    return () => clearInterval(id);
  }, [routeMatchId]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => (keys.current[e.key.toLowerCase()] = true);
    const up = (e: KeyboardEvent) => (keys.current[e.key.toLowerCase()] = false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const angle = (Math.atan2(e.clientY - window.innerHeight / 2, e.clientX - window.innerWidth / 2) * 180) / Math.PI + 90;
      rotationRef.current = angle;
      setRotation(angle);
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  useEffect(() => {
    if (!socket || !routeMatchId) return;
    const interval = setInterval(() => {
      socket.emit("tanks:input", {
        gameId: routeMatchId,
        input: {
          w: !!keys.current["w"],
          a: !!keys.current["a"],
          s: !!keys.current["s"],
          d: !!keys.current["d"],
        },
        rotation: rotationRef.current,
      });
    }, INPUT_TICK_MS);

    return () => clearInterval(interval);
  }, [socket, routeMatchId]);

  useEffect(() => {
    if (!socket || !routeMatchId) return;
    const handleMouse = (e: MouseEvent) => {
      if (e.button !== 0) return;
      socket.emit("tanks:shoot", { gameId: routeMatchId });
    };

    window.addEventListener("mousedown", handleMouse);
    return () => window.removeEventListener("mousedown", handleMouse);
  }, [socket, routeMatchId]);

  useEffect(() => {
    function gameLoop(frameTime: number) {
      const dt = lastFrameRef.current ? Math.min(2.2, (frameTime - lastFrameRef.current) / 16.6667) : 1;
      lastFrameRef.current = frameTime;
      const targetRemotes = remotePlayersRef.current;
      const currentRemotes = renderRemotePlayersRef.current;
      const smoothed: Record<string, PlayerState> = {};

      for (const [id, target] of Object.entries(targetRemotes)) {
        const current = currentRemotes[id] ?? target;
        const smoothing = 0.24 * dt;
        smoothed[id] = {
          ...target,
          x: current.x + (target.x - current.x) * smoothing,
          y: current.y + (target.y - current.y) * smoothing,
          rotation: current.rotation + (target.rotation - current.rotation) * smoothing,
        };
      }

      const now = performance.now();
      setSelfHitIntensity(Math.max(0, (selfHitUntilRef.current - now) / 220));
      const remoteFx: Record<string, number> = {};
      Object.entries(remoteHitUntilRef.current).forEach(([id, until]) => {
        remoteFx[id] = Math.max(0, (until - now) / 220);
      });
      setRemoteHitIntensity(remoteFx);

      renderRemotePlayersRef.current = smoothed;
      setRenderRemotePlayers(smoothed);

      setServerBullets((prev) => {
        const target = targetBulletsRef.current;
        const prevById = new Map(prev.map((b, i) => [b.id ?? i, b]));
        return target.map((bullet, i) => {
          const current = prevById.get(bullet.id ?? i) ?? bullet;
          const smoothing = 0.35 * dt;
          return {
            ...bullet,
            x: current.x + (bullet.x - current.x) * smoothing,
            y: current.y + (bullet.y - current.y) * smoothing,
          };
        });
      });

      rafLoopRef.current = requestAnimationFrame(gameLoop);
    }

    rafLoopRef.current = requestAnimationFrame(gameLoop);
    return () => {
      if (rafLoopRef.current !== null) cancelAnimationFrame(rafLoopRef.current);
    };
  }, []);

  const cameraX = typeof window !== "undefined" ? window.innerWidth / 2 - pos.x : 0;
  const cameraY = typeof window !== "undefined" ? window.innerHeight / 2 - pos.y : 0;
  const getTankColor = (playerId: string, isEnemy: boolean) => {
    if (gameMode !== "battle_royale") {
      return isEnemy ? "#dc2626" : "#16a34a";
    }

    const joinIndex = playerJoinOrder.indexOf(playerId);
    if (joinIndex >= 0) {
      return BATTLE_ROYALE_TANK_COLORS[joinIndex % BATTLE_ROYALE_TANK_COLORS.length];
    }

    return isEnemy ? "#dc2626" : "#16a34a";
  };

  if (!isMatchReady || !matchId) {
    return (
      <WaitingRoom
        gameId={matchId ?? ""}
        onReady={() => setIsMatchReady(true)}
        minPlayersToStart={minPlayersToStart}
        maxPlayers={maxPlayers}
        gameMode={gameMode}
      />
    );
  }

  return (
    <div className="w-full h-screen overflow-hidden relative bg-black">
      <div
        className="absolute"
        style={{
          width: worldWidth,
          height: worldHeight,
          transform: `translate(${cameraX}px, ${cameraY}px)`,
          zIndex: 1,
        }}
      >
        <div className="relative w-full h-full bg-[#f4e7b4]" style={{ pointerEvents: "none" }}>
          <div
            className="absolute inset-0"
            style={{
              pointerEvents: "none",
              backgroundImage: `
              radial-gradient(circle at 18% 28%, rgba(255,236,182,0.42) 0%, transparent 30%),
              radial-gradient(circle at 78% 65%, rgba(235,189,118,0.28) 0%, transparent 37%),
              repeating-radial-gradient(circle at 50% 50%, rgba(125,88,45,0.09) 0px, rgba(125,88,45,0.09) 2px, transparent 2px, transparent 12px)
              `,
            }}
          />
          <div
            className="absolute bottom-0 left-0 w-full h-1/3"
            style={{
              pointerEvents: "none",
              backgroundImage: `
              linear-gradient(to bottom, rgba(70,180,230,0.88), rgba(9,89,150,0.95)),
              repeating-linear-gradient(95deg, rgba(255,255,255,0.12) 0 6px, transparent 6px 18px)
              `,
            }}
          />
          <div
            className="absolute left-0 w-full"
            style={{
              bottom: "31%",
              height: 160,
              pointerEvents: "none",
              background: "radial-gradient(ellipse at 50% 45%, rgba(228,204,150,0.96) 30%, rgba(204,166,110,0.65) 44%, rgba(83,148,182,0.12) 58%, transparent 70%)",
              filter: "blur(3px)",
            }}
          />
          <div
            className="absolute left-0 w-full"
            style={{
              bottom: "31%",
              height: 100,
              pointerEvents: "none",
              backgroundImage: "repeating-linear-gradient(120deg, rgba(255,255,255,0.18) 0 2px, transparent 2px 12px)",
              opacity: 0.2,
            }}
          />
        </div>

        {rocks.map((r) => (
          <div
            key={r.id}
            className="absolute rounded-full border border-gray-900 shadow-lg"
            style={{
              width: r.size,
              height: r.size,
              left: r.x,
              top: r.y,
              backgroundImage: `
              radial-gradient(circle at 28% 26%, rgba(196,203,215,0.9) 0 15%, rgba(124,131,143,0.88) 42%, rgba(62,68,81,0.95) 88%),
              repeating-radial-gradient(circle at 65% 65%, rgba(255,255,255,0.18) 0 1px, rgba(0,0,0,0.18) 2px 4px, transparent 4px 7px)
              `,
            }}
          />
        ))}

        {Object.entries(renderRemotePlayers).map(([id, tank]) => (
          <div
            key={id}
            className="absolute"
            style={{
              left: tank.x,
              top: tank.y,
              width: 70,
              height: 70,
              transform: "translate(-50%, -50%)",
              pointerEvents: "none",
              zIndex: 9,
            }}
          >
            <PlayerTank
              x={35}
              y={35}
              rotation={tank.rotation}
              health={tank.health}
              maxHealth={MAX_HEALTH}
              isEnemy
              hitIntensity={remoteHitIntensity[id] ?? 0}
              tankColor={getTankColor(id, true)}
              playerName={playerNames[id] ?? "Player"}
            />
          </div>
        ))}

        <div
          className="absolute"
          style={{
            left: pos.x,
            top: pos.y,
            width: 70,
            height: 70,
            transform: "translate(-50%, -50%)",
            pointerEvents: "none",
            zIndex: 10,
          }}
        >
          {cashOutCountdown > 0 && (
            <svg className="absolute inset-0 w-full h-full">
              <circle
                cx={35}
                cy={35}
                r={32}
                stroke="yellow"
                strokeWidth={20}
                fill="transparent"
                strokeDasharray={2 * Math.PI * 32}
                strokeDashoffset={(1 - cashOutCountdown / 5) * 2 * Math.PI * 32}
                strokeLinecap="round"
              />
            </svg>
          )}
          <PlayerTank
            x={35}
            y={35}
            rotation={rotation}
            health={health}
            maxHealth={MAX_HEALTH}
            isEnemy={false}
            hitIntensity={selfHitIntensity}
            tankColor={selfId ? getTankColor(selfId, false) : "#16a34a"}
            playerName={selfId ? (playerNames[selfId] ?? "You") : undefined}
          />
        </div>

        {serverBullets.map((b, i) => (
          <div key={i} className="absolute w-3 h-3 bg-black rounded-full" style={{ left: b.x - 2, top: b.y - 2 }} />
        ))}
      </div>

      <div className="absolute top-4 left-4 p-4 bg-black/40 rounded-xl text-white flex flex-col gap-2 z-[9999]">
        <p className="text-lg font-bold">Bounty: ${bounty}</p>
        <p className="text-xs text-green-300">Balance: {tokenBalance ?? "..."} tokens</p>
        <p className="font-bold">Ammo: {ammo}/{MAX_AMMO}</p>
        <p className="text-xs text-yellow-200">
          Mode: {gameMode === "battle_royale" ? "Battle Royale" : "1v1"}
        </p>
        <p className="text-xs text-cyan-200">Terrain: {isWaterTile(pos.y) ? "Water (slowed)" : "Sand"}</p>
        <p className="text-xs text-gray-300">Player: {(selfId && playerNames[selfId]) || "..."}</p>

        {gameMode === "battle_royale" && (
          <CashOutButton bountyRef={bountyRef} setBounty={setBounty} setCashOutCountdown={setCashOutCountdown} routeMatchId={routeMatchId} />
        )}
      </div>

      {duelResult && (
        <div className="absolute inset-0 z-[10000] bg-black/75 flex items-center justify-center">
          <div className="bg-[#101010] border-2 border-yellow-500 rounded-2xl p-8 text-white text-center max-w-md w-full">
            <h2 className="text-3xl font-bold mb-3">{duelResult.didWin ? "🏆 You won!" : "💀 You lost"}</h2>
            <p className="text-lg mb-6">
              {duelResult.didWin ? `+${duelResult.amount.toFixed(2)} tokens` : "Better luck next round."}
            </p>
            <button
              onClick={() => router.push("/casino/tanks")}
              className="px-5 py-2 rounded-lg bg-yellow-600 hover:bg-yellow-700 font-semibold"
            >
              Return to Lobby
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
