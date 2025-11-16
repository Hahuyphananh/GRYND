"use client";

import { useEffect, useRef, useState } from "react";
import PlayerTank from "../../../../components/PlayerTank";

/**
 * Fixed TanksGamePage
 * - uses refs for live values so gameLoop doesn't close over stale state
 * - line-segment vs circle collision to avoid tunneling
 * - immutable bullet updates
 * - tank collision prevents driving through rocks
 */

export default function TanksGamePage() {
  const [pos, setPos] = useState({ x: 1500, y: 1500 });
  const posRef = useRef(pos);
  posRef.current = pos;
  const [mouse, setMouse] = useState({ x: 0, y: 0 });
  const MAX_HEALTH = 5;
const [health, setHealth] = useState(MAX_HEALTH);
const healthRef = useRef(health);
healthRef.current = health;
const [cashOutCountdown, setCashOutCountdown] = useState(0);
const cashOutCountdownRef = useRef(0);
cashOutCountdownRef.current = cashOutCountdown;

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

  /* ---------------- FIXED ROCKS (generated once) ---------------- */
  const ROCK_COUNT = 40;
  const rocksRef = useRef(
    Array.from({ length: ROCK_COUNT }).map((_, i) => {
      const size = 40 + Math.random() * 60;
      return {
        id: i,
        size,
        // top-left coordinates so rendering is straightforward
        x: Math.random() * (MAP_WIDTH - size),
        y: Math.random() * (MAP_HEIGHT - size),
      };
    })
  );
  const rocks = rocksRef.current;

  /* ---------------- Helpers ---------------- */
  function lineIntersectsCircle(x1: number, y1: number, x2: number, y2: number, cx: number, cy: number, r: number) {
    // Closest point on segment to circle center
    const vx = x2 - x1;
    const vy = y2 - y1;
    const wx = cx - x1;
    const wy = cy - y1;
    const len2 = vx * vx + vy * vy;

    if (len2 === 0) {
      // segment is a point
      const d2 = (cx - x1) * (cx - x1) + (cy - y1) * (cy - y1);
      return d2 <= r * r;
    }

    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
    const px = x1 + vx * t;
    const py = y1 + vy * t;

    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= r * r;
  }

  /* ---------------- Keyboard tracking ---------------- */
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      keys.current[e.key] = true;
    };
    const up = (e: KeyboardEvent) => {
      keys.current[e.key] = false;
    };

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  /* ---------------- Mouse movement for rotation only ---------------- */
useEffect(() => {
  const handleMouseMove = (e: MouseEvent) => {
    // Tank is always in the center of the screen visually
    const angle =
      Math.atan2(e.clientY - window.innerHeight / 2, e.clientX - window.innerWidth / 2) * 
      (180 / Math.PI) + 90;

    rotationRef.current = angle;
    setRotation(angle);
  };

  window.addEventListener("mousemove", handleMouseMove);
  return () => window.removeEventListener("mousemove", handleMouseMove);
}, []);


  /* ---------------- Mouse click to shoot ---------------- */
  useEffect(() => {
    const handleMouse = (e: MouseEvent) => {
      if (e.button !== 0) return; // left click only

      // Use live pos & rotation refs to compute spawn
      const px = posRef.current.x;
      const py = posRef.current.y;
      const rot = rotationRef.current;

      const rad = (rot - 90) * (Math.PI / 180);
      const spawnDist = 25 + 10; // tank half-size approx + barrel tip offset
      const spawnX = px + Math.cos(rad) * spawnDist;
      const spawnY = py + Math.sin(rad) * spawnDist;

      const newBullet = { x: spawnX, y: spawnY, angle: rot };

      // update refs and state immutably
      bulletsRef.current = [...bulletsRef.current, newBullet];
      setBullets(bulletsRef.current);
    };

    window.addEventListener("mousedown", handleMouse);
    return () => window.removeEventListener("mousedown", handleMouse);
  }, []);

function CashOutButton() {
  const [countdown, setCountdown] = useState(0);
  const countdownRef = useRef<number>(0);
  const rafRef = useRef<number | undefined>(undefined);

  const handleCashOut = () => {
    if (countdownRef.current > 0) return; // already counting down
console.log("cashOutCountdown", cashOutCountdown);

    const duration = 5; // 5 seconds
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
        setCashOutCountdown(0);
        alert("You cashed out!");
      }
    };

    rafRef.current = requestAnimationFrame(animate);
  };

  return (
    <button
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



  /* ---------------- Main Game Loop (single RAF) ---------------- */
  useEffect(() => {
    const TANK_RADIUS = 22; // collision radius for tank (adjust if needed)

    function gameLoop() {
      // INPUT
      let dx = 0;
      let dy = 0;
      if (keys.current["w"]) dy -= 1;
      if (keys.current["s"]) dy += 1;
      if (keys.current["a"]) dx -= 1;
      if (keys.current["d"]) dx += 1;

      if (dx !== 0 && dy !== 0) {
        dx *= 0.7;
        dy *= 0.7;
      }

      const curPos = posRef.current;

      // TENTATIVE NEXT POS for tank (do not mutate state yet)
      if (dx !== 0 || dy !== 0) {
        const nextX = curPos.x + dx * speed;
        const nextY = curPos.y + dy * speed;

        // Check collision vs rocks (circle-circle)
        let blocked = false;
        for (const rock of rocks) {
          const cx = rock.x + rock.size / 2;
          const cy = rock.y + rock.size / 2;
          const rockR = rock.size / 2;

          const dist = Math.hypot(nextX - cx, nextY - cy);
          if (dist < rockR + TANK_RADIUS) {
            blocked = true;
            break;
          }
        }

        if (!blocked) {
          // commit movement to refs + state
          const newPos = {
            x: Math.min(MAP_WIDTH, Math.max(0, nextX)),
            y: Math.min(MAP_HEIGHT, Math.max(0, nextY)),
          };
          posRef.current = newPos;
          setPos(newPos);
        }
      }

      // BULLET UPDATE (compute next positions and collisions)
      const curBullets = bulletsRef.current;
      const nextBullets: { x: number; y: number; angle: number }[] = [];

      for (const b of curBullets) {
        const rad = (b.angle - 90) * (Math.PI / 180);
        const nextX = b.x + Math.cos(rad) * BULLET_SPEED;
        const nextY = b.y + Math.sin(rad) * BULLET_SPEED;

        // Out of bounds check
        if (nextX < 0 || nextX > MAP_WIDTH || nextY < 0 || nextY > MAP_HEIGHT) {
          continue;
        }

        // Check line segment from (b.x,b.y) to (nextX,nextY) against each rock circle
        let hit = false;
        for (const rock of rocks) {
          const cx = rock.x + rock.size / 2;
          const cy = rock.y + rock.size / 2;
          const r = rock.size / 2;

          if (lineIntersectsCircle(b.x, b.y, nextX, nextY, cx, cy, r)) {
            hit = true;
            break;
          }
        }

        if (!hit) {
          // keep bullet with updated position (immutable)
          nextBullets.push({ x: nextX, y: nextY, angle: b.angle });
        } else {
          // optional: spawn impact particles (not implemented here)
        }
      }

      // commit bullets
      bulletsRef.current = nextBullets;
      setBullets(nextBullets);

// PLAYER DAMAGE CHECK (player hit by any bullets)
for (const b of bulletsRef.current) {
  // simple circle collision check
  const dist = Math.hypot(b.x - posRef.current.x, b.y - posRef.current.y);
  if (dist < 22 /* tank radius */) {
    // Reduce health and remove bullet
    setHealth(h => Math.max(0, h - 1));
    healthRef.current = Math.max(0, healthRef.current - 1);
    lastDamageTimeRef.current = Date.now();

    // Remove the bullet from nextBullets
    continue; // bullet disappears on hit
  }
}

const timeSinceDamage = Date.now() - lastDamageTimeRef.current;
if (timeSinceDamage >= 2000 /* 2 minutes = 120000ms */) {
  // regen linearly over 2 minutes
  const regenPerMs = MAX_HEALTH / 120000;
  const newHealth = Math.min(MAX_HEALTH, healthRef.current + regenPerMs * 16); // 16ms per frame approx
  healthRef.current = newHealth;
  setHealth(newHealth);
}


      requestAnimationFrame(gameLoop);
    }

    const raf = requestAnimationFrame(gameLoop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once

  /* ---------------- Camera (uses pos state so re-renders update camera) ---------------- */
  const cameraX = typeof window !== "undefined" ? window.innerWidth / 2 - pos.x : 0;
  const cameraY = typeof window !== "undefined" ? window.innerHeight / 2 - pos.y : 0;

  return (
    <div className="w-full h-screen overflow-hidden relative bg-black">
      <div
        className="absolute"
        style={{
          width: MAP_WIDTH,
          height: MAP_HEIGHT,
          transform: `translate(${cameraX}px, ${cameraY}px)`,
        }}
      >
        {/* MAP BACKGROUND */}
        <div className="relative w-full h-full bg-[#f4e7b4]">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_30%,#f7e9b3,transparent_70%)] opacity-70" />
          <div className="absolute bottom-0 left-0 w-full h-1/3 bg-gradient-to-b from-[#3db4ff] to-[#006bb3]" />
          <div className="absolute bottom-[33%] left-0 w-full h-28 bg-[radial-gradient(circle_at_50%_120%,#f7e9b3_40%,transparent_45%)] opacity-70" />
        </div>

        {/* FIXED ROCKS */}
        {rocks.map((rock) => (
          <div
            key={rock.id}
            className="absolute bg-gray-700 rounded-full border border-gray-900 shadow-lg"
            style={{
              width: rock.size,
              height: rock.size,
              left: rock.x,
              top: rock.y,
            }}
          />
        ))}
{/* PLAYER + CASHOUT CIRCLE */}
<div
  className="absolute"
  style={{
    left: pos.x,
    top: pos.y,
    width: 70,
    height: 70,
    transform: "translate(-50%, -50%)",
    pointerEvents: "none", // so circle doesn't block clicks
  }}
>
  {/* CASHOUT CIRCLE */}
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

  {/* PLAYER TANK */}
  <PlayerTank x={35} y={35} rotation={rotation} health={health} maxHealth={MAX_HEALTH} />
</div>





        {/* BULLETS */}
        {bullets.map((b, i) => (
          <div
            key={i}
            className="absolute w-3 h-3 bg-black rounded-full"
            style={{ left: b.x - 2, top: b.y - 2 }}
          />
        ))}
      </div>

      {/* UI */}
      /* ---------------- UI ---------------- */
<div className="absolute top-4 left-4 p-4 bg-black/40 rounded-xl text-white flex flex-col gap-2 z-50">
  <p className="text-lg font-bold">Bounty: $0</p>
  <p className="text-sm text-gray-300">(frontend only)</p>

  {/* Cash Out Button */}
  <CashOutButton />
</div>

    </div>
  );
}
