"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

import NavigationBar from "../../../../../components/navigation-bar";

type Team = "solids" | "stripes" | null;

type Ball = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  striped?: boolean;
  pocketed?: boolean;
  number?: number;
};

const R = 11;
const W = 900;
const H = 500;

const FRICTION = 0.992;
const RAIL = 42;
const POCKET_R = 30;

const BALLS = [
  { n: 1, c: "#facc15", s: false },
  { n: 2, c: "#2563eb", s: false },
  { n: 3, c: "#dc2626", s: false },
  { n: 4, c: "#7c3aed", s: false },
  { n: 5, c: "#f97316", s: false },

  { n: 6, c: "#16a34a", s: false },
  { n: 7, c: "#a16207", s: false },
  { n: 8, c: "#111827", s: false },
  { n: 9, c: "#facc15", s: true },
  { n: 10, c: "#2563eb", s: true },

  { n: 11, c: "#dc2626", s: true },
  { n: 12, c: "#7c3aed", s: true },
  { n: 13, c: "#f97316", s: true },
  { n: 14, c: "#16a34a", s: true },
  { n: 15, c: "#a16207", s: true },
];

function setupBalls(): Ball[] {
  const balls: Ball[] = [
    {
      id: 0,
      number: 0,
      x: 180,
      y: 250,
      vx: 0,
      vy: 0,
      color: "#f5f5f5",
    },
  ];

  let k = 1;

  for (let row = 0; row < 5; row++) {
    for (let col = 0; col <= row; col++) {
      const d = BALLS[k - 1];

      balls.push({
        id: k,
        number: d.n,
        x: 620 + row * 19,
        y: 250 - row * 11 + col * 22,
        vx: 0,
        vy: 0,
        color: d.c,
        striped: d.s,
      });

      k++;
    }
  }

  return balls;
}

const moving = (balls: Ball[]) =>
  balls.some((b) => Math.abs(b.vx) + Math.abs(b.vy) > 0.03);

export default function PoolGamePage() {
  const { matchId } = useParams<{ matchId: string }>();

  const aiMode = useSearchParams().get("ai") === "1";

  const pockets = useMemo(
    () => [
      [34, 34],
      [W / 2, 28],
      [W - 34, 34],

      [34, H - 34],
      [W / 2, H - 28],
      [W - 34, H - 34],
    ],
    []
  );

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const [balls, setBalls] = useState<Ball[]>(setupBalls());

  const [status, setStatus] = useState("Waiting...");
  const [started, setStarted] = useState(aiMode);

  const [myTeam, setMyTeam] = useState<Team>(null);
  const [oppTeam, setOppTeam] = useState<Team>(null);

  const [turn, setTurn] = useState<1 | 2>(1);
  const [owner, setOwner] = useState<1 | 2>(1);

  const [myName, setMyName] = useState("You");
  const [oppName, setOppName] = useState(aiMode ? "AI" : "Opponent");

  const [pull, setPull] = useState(0);
  const [aim, setAim] = useState(0);

  const [syncVersion, setSyncVersion] = useState(0);

  const physics = (next: Ball[]) => {
    for (const b of next) {
      if (b.pocketed) continue;

      b.x += b.vx;
      b.y += b.vy;

      b.vx *= FRICTION;
      b.vy *= FRICTION;

      if (Math.abs(b.vx) < 0.02) b.vx = 0;
      if (Math.abs(b.vy) < 0.02) b.vy = 0;

      for (const [px, py] of pockets) {
        if ((b.x - px) ** 2 + (b.y - py) ** 2 < (POCKET_R - 3) ** 2) {
          b.pocketed = true;

          b.vx = 0;
          b.vy = 0;

          b.x = px;
          b.y = py;

          break;
        }
      }

      if (b.pocketed) continue;

      if (b.x < RAIL + R || b.x > W - RAIL - R) {
        b.x = Math.max(RAIL + R, Math.min(W - RAIL - R, b.x));
        b.vx *= -0.93;
      }

      if (b.y < RAIL + R || b.y > H - RAIL - R) {
        b.y = Math.max(RAIL + R, Math.min(H - RAIL - R, b.y));
        b.vy *= -0.93;
      }
    }

    for (let i = 0; i < next.length; i++) {
      for (let j = i + 1; j < next.length; j++) {
        const a = next[i];
        const b = next[j];

        if (a.pocketed || b.pocketed) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;

        const d = Math.hypot(dx, dy);

        if (d > 0 && d < R * 2) {
          const nx = dx / d;
          const ny = dy / d;

          const overlap = R * 2 - d;

          a.x -= (nx * overlap) / 2;
          a.y -= (ny * overlap) / 2;

          b.x += (nx * overlap) / 2;
          b.y += (ny * overlap) / 2;

          const p =
            (a.vx - b.vx) * nx +
            (a.vy - b.vy) * ny;

          a.vx -= p * nx;
          a.vy -= p * ny;

          b.vx += p * nx;
          b.vy += p * ny;
        }
      }
    }
  };

  useEffect(() => {
    const id = setInterval(() => {
      setBalls((p) => {
        const n = p.map((b) => ({ ...b }));

        physics(n);

        return n;
      });
    }, 16);

    return () => clearInterval(id);
  }, []);

  const sendState = async (
    nextBalls: Ball[],
    t: 1 | 2,
    mt: Team,
    ot: Team
  ) => {
    if (aiMode) return;

    await fetch("/api/pool/update-state", {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        matchId,

        state: {
          balls: nextBalls,
          turn: t,
          myTeam: mt,
          oppTeam: ot,
          version: Date.now(),
        },
      }),
    });
  };

  useEffect(() => {
    const id = setInterval(async () => {
      const res = await fetch(
        `/api/pool/get-match?matchId=${matchId}`,
        {
          cache: "no-store",
        }
      );

      const data = await res.json();

      if (data.match?.status === "active") {
        setStarted(true);
      }

      if (data.viewerSeat) {
        setOwner(data.viewerSeat);
      }

      if (data.viewerName) {
        setMyName(data.viewerName);
      }

      if (data.opponentName) {
        setOppName(data.opponentName);
      }

      const gs = data.match?.gameState;

      if (gs?.version && gs.version > syncVersion) {
        setSyncVersion(gs.version);

        if (gs.balls) {
          setBalls(gs.balls);
        }

        if (gs.turn) {
          setTurn(gs.turn);
        }

        if (gs.myTeam !== undefined) {
          setMyTeam(gs.myTeam);
        }

        if (gs.oppTeam !== undefined) {
          setOppTeam(gs.oppTeam);
        }
      }
    }, 1200);

    return () => clearInterval(id);
  }, [matchId, syncVersion]);

  useEffect(() => {
    const c = canvasRef.current;

    if (!c) return;

    const x = c.getContext("2d");

    if (!x) return;

    x.clearRect(0, 0, W, H);

    const grad = x.createLinearGradient(0, 0, 0, H);

    grad.addColorStop(0, "#1fb56b");
    grad.addColorStop(1, "#058545");

    x.fillStyle = grad;

    x.fillRect(
      RAIL,
      RAIL,
      W - RAIL * 2,
      H - RAIL * 2
    );

    x.strokeStyle = "#7a4c28";
    x.lineWidth = 32;

    x.strokeRect(
      RAIL - 14,
      RAIL - 14,
      W - (RAIL - 14) * 2,
      H - (RAIL - 14) * 2
    );

    for (const [px, py] of pockets) {
      x.fillStyle = "#050505";

      x.beginPath();

      x.arc(px, py, POCKET_R, 0, Math.PI * 2);

      x.fill();
    }

    const cue = balls[0];

    if (
      cue &&
      !cue.pocketed &&
      !moving(balls) &&
      turn === owner
    ) {
      x.strokeStyle = "rgba(255,255,255,.35)";
      x.lineWidth = 2;

      x.beginPath();

      x.moveTo(cue.x, cue.y);

      x.lineTo(
        cue.x + Math.cos(aim) * 260,
        cue.y + Math.sin(aim) * 260
      );

      x.stroke();

      x.strokeStyle = "#c3a16a";
      x.lineWidth = 8;

      x.beginPath();

      x.moveTo(
        cue.x - Math.cos(aim) * (64 + pull),
        cue.y - Math.sin(aim) * (64 + pull)
      );

      x.lineTo(
        cue.x - Math.cos(aim) * 14,
        cue.y - Math.sin(aim) * 14
      );

      x.stroke();
    }

    for (const b of balls) {
      if (b.pocketed) continue;

      const g = x.createRadialGradient(
        b.x - 4,
        b.y - 4,
        1,
        b.x,
        b.y,
        R
      );

      g.addColorStop(0, "#fff");
      g.addColorStop(0.15, b.color);
      g.addColorStop(1, "#111");

      x.fillStyle = g;

      x.beginPath();

      x.arc(b.x, b.y, R, 0, Math.PI * 2);

      x.fill();

      if (b.striped) {
        x.fillStyle = "#fff";

        x.fillRect(
          b.x - R + 1,
          b.y - 4,
          R * 2 - 2,
          8
        );
      }

      if (b.number) {
        x.fillStyle = "#fff";
        x.font = "bold 9px sans-serif";

        x.fillText(
          String(b.number),
          b.x - 3,
          b.y + 3
        );
      }
    }
  }, [balls, aim, pull, pockets, owner, turn]);

  const shoot = (
    shotAim: number,
    shotPull: number
  ) => {
    if (!started || moving(balls) || turn !== owner) {
      return;
    }

    const p = Math.min(
      1,
      Math.max(0.2, shotPull / 90)
    );

    const speed = 4 + p * 9;

    const prev = balls.map((b) => ({ ...b }));

    const next = prev.map((b) =>
      b.id === 0
        ? {
            ...b,
            vx: Math.cos(shotAim) * speed,
            vy: Math.sin(shotAim) * speed,
          }
        : b
    );

    setBalls(next);

    setStatus("Shot taken");

    setTimeout(() => {
      const before = prev
        .filter((b) => b.pocketed)
        .map((b) => b.id);

      const newPockets = next.filter(
        (b) =>
          b.pocketed &&
          !before.includes(b.id)
      );

      const sunkOwnBall = newPockets.some(
        (b) => b.id > 0 && b.id !== 8
      );

      let mt = myTeam;
      let ot = oppTeam;

      if (!myTeam) {
        const firstScore = newPockets.find(
          (b) => b.id > 0 && b.id !== 8
        );

        if (firstScore) {
          mt = firstScore.striped
            ? "stripes"
            : "solids";

          ot =
            mt === "solids"
              ? "stripes"
              : "solids";

          setMyTeam(mt);
          setOppTeam(ot);
        }
      }

      const nt =
        sunkOwnBall
          ? turn
          : turn === 1
          ? 2
          : 1;

      setTurn(nt);

      void sendState(next, nt, mt, ot);
    }, 1400);
  };

  useEffect(() => {
    if (!aiMode || turn !== 2 || moving(balls)) {
      return;
    }

    const cue = balls[0];

    const target = balls.find(
      (b) =>
        b.id !== 0 &&
        !b.pocketed &&
        (
          oppTeam
            ? oppTeam === "solids"
              ? !b.striped
              : b.striped
            : true
        )
    );

    if (!cue || !target) return;

    const a =
      Math.atan2(
        target.y - cue.y,
        target.x - cue.x
      ) +
      (Math.random() - 0.5) * 0.12;

    const timer = setTimeout(() => {
      const p = Math.min(
        1,
        Math.max(0.2, 75 / 90)
      );

      const speed = 4 + p * 9;

      setBalls((prev) =>
        prev.map((b) =>
          b.id === 0
            ? {
                ...b,
                vx: Math.cos(a) * speed,
                vy: Math.sin(a) * speed,
              }
            : b
        )
      );

      setTurn(1);

      setStatus("AI played");
    }, 900);

    return () => clearTimeout(timer);
  }, [aiMode, turn, balls, oppTeam]);

  const onDown = (e: any) => {
    const r =
      e.currentTarget.getBoundingClientRect();

    dragRef.current = {
      x: e.clientX - r.left,
      y: e.clientY - r.top,
    };
  };

  const onMove = (e: any) => {
    const cue = balls[0];

    if (!cue) return;

    const r =
      e.currentTarget.getBoundingClientRect();

    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;

    setAim(
      Math.atan2(
        my - cue.y,
        mx - cue.x
      )
    );

    if (dragRef.current) {
      setPull(
        Math.min(
          95,
          Math.hypot(
            mx - dragRef.current.x,
            my - dragRef.current.y
          )
        )
      );
    }
  };

  const onUp = () => {
    if (dragRef.current) {
      shoot(aim, pull);

      setPull(0);
    }

    dragRef.current = null;
  };

  const myRemaining = BALLS
    .filter((b) =>
      myTeam
        ? myTeam === "solids"
          ? !b.s && b.n !== 8
          : b.s
        : true
    )
    .filter(
      (b) =>
        !balls.find(
          (bb) => bb.number === b.n
        )?.pocketed
    )
    .map((b) => b.n);

  const oppRemaining = BALLS
    .filter((b) =>
      oppTeam
        ? oppTeam === "solids"
          ? !b.s && b.n !== 8
          : b.s
        : true
    )
    .filter(
      (b) =>
        !balls.find(
          (bb) => bb.number === b.n
        )?.pocketed
    )
    .map((b) => b.n);

  return (
    <div className="min-h-screen bg-[#0b8f7f] p-4 text-white">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto mt-6 max-w-6xl rounded-xl border border-cyan-500/40 bg-black/35 p-4">
        <h1 className="text-3xl font-black text-fuchsia-300">
          Pool Match
        </h1>

        <p>
          {status} • Turn:{" "}
          {turn === owner
            ? myName
            : oppName}
        </p>

        <div className="mt-3 grid grid-cols-2 gap-4">
          <div className="rounded bg-slate-800/80 p-3">
            <p className="font-bold">
              {myName}
            </p>

            <p className="text-xs text-cyan-100">
              {myTeam ?? "unassigned"}
            </p>

            <p className="mt-1 text-sm">
              Balls:{" "}
              {myRemaining.join(", ") || "none"}
            </p>
          </div>

          <div className="rounded bg-slate-800/80 p-3 text-right">
            <p className="font-bold">
              {oppName}
            </p>

            <p className="text-xs text-cyan-100">
              {oppTeam ?? "unassigned"}
            </p>

            <p className="mt-1 text-sm">
              Balls:{" "}
              {oppRemaining.join(", ") || "none"}
            </p>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <canvas
            ref={canvasRef}
            width={W}
            height={H}
            onMouseDown={onDown}
            onMouseMove={onMove}
            onMouseUp={onUp}
            onMouseLeave={onUp}
            className="cursor-crosshair rounded-xl border border-amber-700/70 bg-[#0f3f2a]"
          />
        </div>
      </div>
    </div>
  );
}