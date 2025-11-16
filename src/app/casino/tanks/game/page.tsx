"use client";

import { useEffect, useRef, useState } from "react";
import PlayerTank from "../../../../components/PlayerTank";
import { useSearchParams, useRouter } from "next/navigation";

export default function TanksGamePage() {
  const [pos, setPos] = useState({ x: 1500, y: 1500 });
  const posRef = useRef(pos);
  posRef.current = pos;

  const MAX_HEALTH = 5;
  const [health, setHealth] = useState(MAX_HEALTH);
  const healthRef = useRef(health);
  healthRef.current = health;

  const [cashOutCountdown, setCashOutCountdown] = useState(0);
  const cashOutCountdownRef = useRef(0);
  cashOutCountdownRef.current = cashOutCountdown;

  const [bounty, setBounty] = useState(0);
  const bountyRef = useRef(bounty);
  bountyRef.current = bounty;

  const lastDamageTimeRef = useRef(Date.now());

  const [rotation, setRotation] = useState(0);
  const rotationRef = useRef(rotation);
  rotationRef.current = rotation;

  const [bullets, setBullets] = useState<{ x: number; y: number; angle: number }[]>([]);
  const bulletsRef = useRef(bullets);
  bulletsRef.current = bullets;

  const keys = useRef<{ [key: string]: boolean }>({});
  const speed = 2;
  const BULLET_SPEED = 6;

  const MAP_WIDTH = 3000;
  const MAP_HEIGHT = 3000;

  const searchParams = useSearchParams();
  const matchId = searchParams.get("matchId");

  const rocksRef = useRef(
    Array.from({ length: 40 }).map((_, i) => {
      const size = 40 + Math.random() * 60;
      return {
        id: i,
        size,
        x: Math.random() * (MAP_WIDTH - size),
        y: Math.random() * (MAP_HEIGHT - size),
      };
    })
  );
  const rocks = rocksRef.current;

  function lineIntersectsCircle(
    x1: number, y1: number, x2: number, y2: number,
    cx: number, cy: number, r: number
  ) {
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
    const matchId = searchParams.get("matchId");
    if (!matchId) return;

    async function fetchMatch() {
      try {
        const res = await fetch(`/api/tanks/get-match?matchId=${matchId}`);
        if (!res.ok) return console.error("Failed to fetch match:", res.status);
        const data = await res.json();
        if (data?.bounty !== undefined && data?.bounty !== null) {
          setBounty(Number(data.bounty));
          bountyRef.current = Number(data.bounty);
        }
      } catch (err) {
        console.error("Error fetching match:", err);
      }
    }
    fetchMatch();
  }, [searchParams]);

  // Keyboard input
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

  // Mouse rotation
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const angle = Math.atan2(
        e.clientY - window.innerHeight / 2,
        e.clientX - window.innerWidth / 2
      ) * (180 / Math.PI) + 90;
      rotationRef.current = angle;
      setRotation(angle);
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  // Shoot bullets
  useEffect(() => {
    const handleMouse = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const px = posRef.current.x;
      const py = posRef.current.y;
      const rot = rotationRef.current;
      const rad = (rot - 90) * (Math.PI / 180);
      const spawnDist = 35;
      const newBullet = { x: px + Math.cos(rad) * spawnDist, y: py + Math.sin(rad) * spawnDist, angle: rot };
      bulletsRef.current = [...bulletsRef.current, newBullet];
      setBullets(bulletsRef.current);
    };
    window.addEventListener("mousedown", handleMouse);
    return () => window.removeEventListener("mousedown", handleMouse);
  }, []);

  function CashOutButton() {
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
                body: JSON.stringify({ amount: bountyRef.current }),
              });
              const data = await res.json();
              if (res.ok) {
                alert(`You cashed out ${bountyRef.current} tokens!`);
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
        onClick={() => {
          console.log("CashOut button clicked");
          handleCashOut();
        }}
        disabled={countdown > 0}
        className={`mt-2 w-full p-2 rounded-xl font-bold text-white ${
          countdown > 0 ? "bg-gray-600 cursor-not-allowed" : "bg-yellow-600 hover:bg-yellow-700"
        }`}
      >
        {countdown > 0 ? `Cashing out in ${Math.ceil(countdown)}s` : "Cash Out"}
      </button>
    );
  }

  // Game loop (unchanged)
  useEffect(() => {
    const TANK_RADIUS = 22;
    function gameLoop() {
      let dx = 0, dy = 0;
      if (keys.current["w"]) dy -= 1;
      if (keys.current["s"]) dy += 1;
      if (keys.current["a"]) dx -= 1;
      if (keys.current["d"]) dx += 1;
      if (dx && dy) { dx *= 0.7; dy *= 0.7; }

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

      // Update bullets
      const nextBullets = bulletsRef.current.filter(b => {
        const rad = (b.angle - 90) * (Math.PI / 180);
        const nx = b.x + Math.cos(rad) * BULLET_SPEED;
        const ny = b.y + Math.sin(rad) * BULLET_SPEED;
        let hit = rocks.some(r => lineIntersectsCircle(b.x, b.y, nx, ny, r.x + r.size/2, r.y + r.size/2, r.size/2));
        if (!hit && nx >= 0 && nx <= MAP_WIDTH && ny >= 0 && ny <= MAP_HEIGHT) {
          b.x = nx; b.y = ny;
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
  }, []);

  const cameraX = typeof window !== "undefined" ? window.innerWidth / 2 - pos.x : 0;
  const cameraY = typeof window !== "undefined" ? window.innerHeight / 2 - pos.y : 0;

  return (
    <div className="w-full h-screen overflow-hidden relative bg-black">
      <div
        className="absolute"
        style={{ width: MAP_WIDTH, height: MAP_HEIGHT, transform: `translate(${cameraX}px, ${cameraY}px)` }}
      >
        {/* Background */}
        <div className="relative w-full h-full bg-[#f4e7b4]">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_30%,#f7e9b3,transparent_70%)] opacity-70" />
          <div className="absolute bottom-0 left-0 w-full h-1/3 bg-gradient-to-b from-[#3db4ff] to-[#006bb3]" />
          <div className="absolute bottom-[33%] left-0 w-full h-28 bg-[radial-gradient(circle_at_50%_120%,#f7e9b3_40%,transparent_45%)] opacity-70" />
        </div>

        {/* Rocks */}
        {rocks.map(r => (
          <div key={r.id} className="absolute bg-gray-700 rounded-full border border-gray-900 shadow-lg" style={{ width: r.size, height: r.size, left: r.x, top: r.y }} />
        ))}

        {/* Player + Tank */}
        <div
          className="absolute"
          style={{ left: pos.x, top: pos.y, width: 70, height: 70, transform: "translate(-50%, -50%)", pointerEvents: "none", zIndex: 10 }}
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
          <PlayerTank x={35} y={35} rotation={rotation} health={health} maxHealth={MAX_HEALTH} />
        </div>

        {/* Bullets */}
        {bullets.map((b, i) => (
          <div key={i} className="absolute w-3 h-3 bg-black rounded-full" style={{ left: b.x - 2, top: b.y - 2 }} />
        ))}
      </div>

      {/* UI */}
      <div className="absolute top-4 left-4 p-4 bg-black/40 rounded-xl text-white flex flex-col gap-2 z-50">
        <p className="text-lg font-bold">Bounty: ${bounty}</p>
        <CashOutButton />
      </div>
    </div>
  );
}
