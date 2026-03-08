"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import PlayerTank from "../../../../../components/PlayerTank";
import { useParams, useRouter } from "next/navigation";
import WaitingRoom from "./components/WaitingRoom";

function createSeededRandom(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function generateRocks(seed: number, mapWidth: number, mapHeight: number) {
  const rand = createSeededRandom(seed);
  return Array.from({ length: 40 }).map((_, i) => {
    const size = 40 + rand() * 60;
    return {
      id: i,
      size,
      x: rand() * (mapWidth - size),
      y: rand() * (mapHeight - size),
    };
  });
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
              body: JSON.stringify({ amount: bountyRef.current, matchId: routeMatchId }),
            });
            const data = await res.json();

            if (res.ok) {
              alert(`You cashed out ${bountyRef.current * 0.9} tokens!`);
              setBounty(0);
              bountyRef.current = 0;
              router.push("/casino/tanks");
            } else {
              alert(data.error || "Failed to cash out");
            }
          } catch (err) {
            console.error("Cashout error:", err);
            alert("Server error while cashing out");
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
  x: number;
  y: number;
  angle: number;
};

type PlayerState = {
  x: number;
  y: number;
  rotation: number;
  health: number;
  bullets?: BulletState[];
  updatedAt?: number;
};

export default function TanksGamePage() {
  const router = useRouter();
  const params = useParams<{ matchId: string }>();
  const routeMatchId = params?.matchId;

  const MAP_WIDTH = 3000;
  const MAP_HEIGHT = 3000;

  const [pos, setPos] = useState({ x: 1500, y: 1500 });
  const posRef = useRef(pos);
  posRef.current = pos;

  const MAX_HEALTH = 5;
  const [health, setHealth] = useState(MAX_HEALTH);
  const healthRef = useRef(health);
  healthRef.current = health;

  const [cashOutCountdown, setCashOutCountdown] = useState(0);

  const [bounty, setBounty] = useState(0);
  const bountyRef = useRef(bounty);
  bountyRef.current = bounty;

  const MAX_AMMO = 5;
  const AMMO_RECHARGE_RATE = 1000;
  const [ammo, setAmmo] = useState(MAX_AMMO);
  const ammoRef = useRef(ammo);
  ammoRef.current = ammo;

  const [isMatchReady, setIsMatchReady] = useState(false);
  const [matchId, setMatchId] = useState<string | null>(routeMatchId ?? null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [remotePlayers, setRemotePlayers] = useState<Record<string, PlayerState>>({});
  const remotePlayersRef = useRef(remotePlayers);
  remotePlayersRef.current = remotePlayers;

  const [renderRemotePlayers, setRenderRemotePlayers] = useState<Record<string, PlayerState>>({});
  const renderRemotePlayersRef = useRef(renderRemotePlayers);
  renderRemotePlayersRef.current = renderRemotePlayers;

  const pendingHitsRef = useRef<string[]>([]);
  const gameFinishedRef = useRef(false);
  const hasInitializedSpawnRef = useRef(false);

  const [mapSeed, setMapSeed] = useState<number>(12345);

  const [rotation, setRotation] = useState(0);
  const rotationRef = useRef(rotation);
  rotationRef.current = rotation;

  const [bullets, setBullets] = useState<{ x: number; y: number; angle: number }[]>([]);
  const bulletsRef = useRef(bullets);
  bulletsRef.current = bullets;

  const keys = useRef<{ [key: string]: boolean }>({});
  const speed = 2;
  const BULLET_SPEED = 6;

  const rocks = useMemo(() => generateRocks(mapSeed, MAP_WIDTH, MAP_HEIGHT), [mapSeed]);

  function lineIntersectsCircle(x1: number, y1: number, x2: number, y2: number, cx: number, cy: number, r: number) {
    const vx = x2 - x1;
    const vy = y2 - y1;
    const wx = cx - x1;
    const wy = cy - y1;
    const len2 = vx * vx + vy * vy;

    if (len2 === 0) return (cx - x1) ** 2 + (cy - y1) ** 2 <= r * r;

    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
    const px = x1 + vx * t;
    const py = y1 + vy * t;
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= r * r;
  }

  useEffect(() => {
    const interval = setInterval(() => {
      if (ammoRef.current < MAX_AMMO) {
        ammoRef.current += 1;
        setAmmo(ammoRef.current);
      }
    }, AMMO_RECHARGE_RATE);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    setMatchId(routeMatchId ?? null);
    if (!routeMatchId) return;

    const checkMatch = async () => {
      try {
        const res = await fetch(`/api/tanks/get-match?matchId=${routeMatchId}`);
        const data = await res.json();

        if (data.currentPlayers >= 2) {
          setIsMatchReady(true);
        }

        if (data?.settings?.mapSeed !== undefined) {
          setMapSeed(Number(data.settings.mapSeed));
        }

        if (data?.bounty !== undefined && data?.bounty !== null) {
          setBounty(Number(data.bounty));
          bountyRef.current = Number(data.bounty);
        }
      } catch (err) {
        console.error("Error fetching match:", err);
      }
    };

    checkMatch();
    const interval = setInterval(checkMatch, 1500);
    return () => clearInterval(interval);
  }, [routeMatchId]);

  useEffect(() => {
    if (!routeMatchId) return;

    const syncState = async () => {
      try {
        const res = await fetch("/api/tanks/update-state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            matchId: routeMatchId,
            x: posRef.current.x,
            y: posRef.current.y,
            rotation: rotationRef.current,
            hits: pendingHitsRef.current.splice(0),
            bullets: bulletsRef.current,
          }),
        });

        if (!res.ok) {
          if ((res.status === 403 || res.status === 404) && !gameFinishedRef.current) {
            gameFinishedRef.current = true;
            alert("Match ended. Returning to lobby.");
            router.push("/casino/tanks");
          }
          return;
        }

        const data = await res.json();
        setSelfId(data.selfId);

        const ownState = data.playerStates?.[data.selfId];
        if (ownState && typeof ownState.health === "number") {
          setHealth(ownState.health);
          healthRef.current = ownState.health;
        }

        if (
          ownState &&
          !hasInitializedSpawnRef.current &&
          Number.isFinite(Number(ownState.x)) &&
          Number.isFinite(Number(ownState.y))
        ) {
          const spawnedPos = { x: Number(ownState.x), y: Number(ownState.y) };
          hasInitializedSpawnRef.current = true;
          posRef.current = spawnedPos;
          setPos(spawnedPos);
        }

        if (data?.gameOver && !gameFinishedRef.current) {
          gameFinishedRef.current = true;
          if (data.gameOver.winnerId === data.selfId) {
            alert(`You won! +${Number(data.gameOver.winnerPayout).toFixed(2)} tokens`);
          } else {
            alert("You were destroyed. Better luck next game.");
          }
          router.push("/casino/tanks");
          return;
        }

        const others = Object.fromEntries(
          Object.entries(data.playerStates ?? {}).filter(([id]) => id !== data.selfId)
        ) as Record<string, PlayerState>;

        setRemotePlayers(others);
      } catch (err) {
        console.error("State sync error:", err);
      }
    };

    syncState();
    const interval = setInterval(syncState, 70);
    return () => clearInterval(interval);
  }, [routeMatchId]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => (keys.current[e.key] = true);
    const up = (e: KeyboardEvent) => (keys.current[e.key] = false);
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
    const handleMouse = (e: MouseEvent) => {
      if (e.button !== 0 || ammoRef.current <= 0) return;

      ammoRef.current -= 1;
      setAmmo(ammoRef.current);

      const px = posRef.current.x;
      const py = posRef.current.y;
      const rot = rotationRef.current;
      const rad = ((rot - 90) * Math.PI) / 180;
      const spawnDist = 35;

      const newBullet = {
        x: px + Math.cos(rad) * spawnDist,
        y: py + Math.sin(rad) * spawnDist,
        angle: rot,
      };

      bulletsRef.current = [...bulletsRef.current, newBullet];
      setBullets(bulletsRef.current);
    };

    window.addEventListener("mousedown", handleMouse);
    return () => window.removeEventListener("mousedown", handleMouse);
  }, []);

  useEffect(() => {
    const TANK_RADIUS = 22;
    function gameLoop() {
      const targetRemotes = remotePlayersRef.current;
      const currentRemotes = renderRemotePlayersRef.current;
      const smoothed: Record<string, PlayerState> = {};

      for (const [id, target] of Object.entries(targetRemotes)) {
        const current = currentRemotes[id] ?? target;
        smoothed[id] = {
          ...target,
          x: current.x + (target.x - current.x) * 0.35,
          y: current.y + (target.y - current.y) * 0.35,
          rotation: current.rotation + (target.rotation - current.rotation) * 0.35,
        };
      }

      renderRemotePlayersRef.current = smoothed;
      setRenderRemotePlayers(smoothed);
      let dx = 0;
      let dy = 0;
      if (keys.current["w"]) dy -= 1;
      if (keys.current["s"]) dy += 1;
      if (keys.current["a"]) dx -= 1;
      if (keys.current["d"]) dx += 1;
      if (dx && dy) {
        dx *= 0.7;
        dy *= 0.7;
      }

      const curPos = posRef.current;
      const nextX = curPos.x + dx * speed;
      const nextY = curPos.y + dy * speed;

      let blocked = false;
      for (const rock of rocks) {
        const cx = rock.x + rock.size / 2;
        const cy = rock.y + rock.size / 2;
        const rockR = rock.size / 2;
        if (Math.hypot(nextX - cx, nextY - cy) < rockR + TANK_RADIUS) blocked = true;
      }

      if (!blocked) {
        const newPos = {
          x: Math.min(MAP_WIDTH, Math.max(0, nextX)),
          y: Math.min(MAP_HEIGHT, Math.max(0, nextY)),
        };
        posRef.current = newPos;
        setPos(newPos);
      }

      const nextBullets = bulletsRef.current.filter((b) => {
        const rad = ((b.angle - 90) * Math.PI) / 180;
        const nx = b.x + Math.cos(rad) * BULLET_SPEED;
        const ny = b.y + Math.sin(rad) * BULLET_SPEED;

        const hitRock = rocks.some((r) =>
          lineIntersectsCircle(b.x, b.y, nx, ny, r.x + r.size / 2, r.y + r.size / 2, r.size / 2)
        );

        if (hitRock) return false;

        const hitPlayerEntry = Object.entries(remotePlayersRef.current).find(([_, player]) =>
          lineIntersectsCircle(b.x, b.y, nx, ny, player.x, player.y, TANK_RADIUS)
        );

        if (hitPlayerEntry) {
          const [targetId] = hitPlayerEntry;
          pendingHitsRef.current.push(targetId);
          return false;
        }

        if (nx >= 0 && nx <= MAP_WIDTH && ny >= 0 && ny <= MAP_HEIGHT) {
          b.x = nx;
          b.y = ny;
          return true;
        }

        return false;
      });

      bulletsRef.current = nextBullets;
      setBullets(nextBullets);

      requestAnimationFrame(gameLoop);
    }

    const raf = requestAnimationFrame(gameLoop);
    return () => cancelAnimationFrame(raf);
  }, [rocks]);

  const cameraX = typeof window !== "undefined" ? window.innerWidth / 2 - pos.x : 0;
  const cameraY = typeof window !== "undefined" ? window.innerHeight / 2 - pos.y : 0;

  if (!isMatchReady || !matchId) {
    return <WaitingRoom gameId={matchId ?? ""} onReady={() => setIsMatchReady(true)} />;
  }

  return (
    <div className="w-full h-screen overflow-hidden relative bg-black">
      <div
        className="absolute"
        style={{
          width: MAP_WIDTH,
          height: MAP_HEIGHT,
          transform: `translate(${cameraX}px, ${cameraY}px)`,
          zIndex: 1,
        }}
      >
        <div className="relative w-full h-full bg-[#f4e7b4]" style={{ pointerEvents: "none" }}>
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_30%,#f7e9b3,transparent_70%)] opacity-70" style={{ pointerEvents: "none" }} />
          <div className="absolute bottom-0 left-0 w-full h-1/3 bg-gradient-to-b from-[#3db4ff] to-[#006bb3]" style={{ pointerEvents: "none" }} />
          <div className="absolute bottom-[33%] left-0 w-full h-28 bg-[radial-gradient(circle_at_50%_120%,#f7e9b3_40%,transparent_45%)] opacity-70" style={{ pointerEvents: "none" }} />
        </div>

        {rocks.map((r) => (
          <div
            key={r.id}
            className="absolute bg-gray-700 rounded-full border border-gray-900 shadow-lg"
            style={{ width: r.size, height: r.size, left: r.x, top: r.y }}
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
            <PlayerTank x={35} y={35} rotation={tank.rotation} health={tank.health} maxHealth={MAX_HEALTH} isEnemy />
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
          <PlayerTank x={35} y={35} rotation={rotation} health={health} maxHealth={MAX_HEALTH} isEnemy={false} />
        </div>

        {Object.entries(renderRemotePlayers).flatMap(([id, tank]) =>
          (tank.bullets ?? []).map((b, i) => (
            <div
              key={`remote-${id}-${i}`}
              className="absolute w-3 h-3 bg-zinc-800 rounded-full"
              style={{ left: b.x - 2, top: b.y - 2 }}
            />
          ))
        )}

        {bullets.map((b, i) => (
          <div key={i} className="absolute w-3 h-3 bg-black rounded-full" style={{ left: b.x - 2, top: b.y - 2 }} />
        ))}
      </div>

      <div className="absolute top-4 left-4 p-4 bg-black/40 rounded-xl text-white flex flex-col gap-2 z-[9999]">
        <p className="text-lg font-bold">Bounty: ${bounty}</p>
        <p className="font-bold">Ammo: {ammo}/{MAX_AMMO}</p>
        <p className="text-xs text-gray-300">Player: {selfId ?? "..."}</p>

        <CashOutButton bountyRef={bountyRef} setBounty={setBounty} setCashOutCountdown={setCashOutCountdown} routeMatchId={routeMatchId} />
      </div>
    </div>
  );
}
