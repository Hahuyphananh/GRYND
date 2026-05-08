"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import NavigationBar from "../../../../../components/navigation-bar";

type Ball = { id:number; x:number; y:number; vx:number; vy:number; color:string; striped?:boolean; pocketed?:boolean; };
const R = 10;
const W = 900;
const H = 500;

function setupBalls(): Ball[] {
  const balls: Ball[] = [{ id: 0, x: 180, y: 250, vx: 0, vy: 0, color: "#fff" }];
  const colors = ["#f6d32d", "#2d5ff6", "#e33535", "#7d35e3", "#ff8936", "#22c55e", "#b91c1c", "#111827", "#f6d32d", "#2d5ff6", "#e33535", "#7d35e3", "#ff8936", "#22c55e", "#b91c1c"];
  let k = 1;
  for (let row = 0; row < 5; row++) for (let col = 0; col <= row; col++) balls.push({ id: k, x: 620 + row * 18, y: 250 - row * 10 + col * 20, vx: 0, vy: 0, color: colors[k - 1], striped: k > 8 }), k++;
  return balls;
}

export default function PoolGamePage() {
  const { matchId } = useParams<{ matchId: string }>();
  const aiMode = useSearchParams().get("ai") === "1";
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [balls, setBalls] = useState<Ball[]>(setupBalls());
  const [angle, setAngle] = useState(0);
  const [power, setPower] = useState(0.55);
  const [status, setStatus] = useState("Waiting for opponent to join...");
  const [started, setStarted] = useState(aiMode);

  const pockets = useMemo(() => [[30,30],[W/2,25],[W-30,30],[30,H-30],[W/2,H-25],[W-30,H-30]], []);
  const tick = (next: Ball[]) => {
    for (const b of next) {
      if (b.pocketed) continue;
      b.x += b.vx; b.y += b.vy; b.vx *= 0.99; b.vy *= 0.99;
      if (Math.abs(b.vx) < 0.02) b.vx = 0; if (Math.abs(b.vy) < 0.02) b.vy = 0;
      if (b.x < 45 || b.x > W - 45) b.vx *= -1;
      if (b.y < 45 || b.y > H - 45) b.vy *= -1;
      for (const [px, py] of pockets) if ((b.x - px) ** 2 + (b.y - py) ** 2 < 18 ** 2) b.pocketed = true;
    }
    for (let i = 0; i < next.length; i++) for (let j = i + 1; j < next.length; j++) {
      const a = next[i], b = next[j]; if (a.pocketed || b.pocketed) continue;
      const dx = b.x - a.x, dy = b.y - a.y; const d = Math.hypot(dx, dy); if (d > 0 && d < R * 2) {
        const nx = dx / d, ny = dy / d; const p = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        a.vx -= p * nx; a.vy -= p * ny; b.vx += p * nx; b.vy += p * ny;
      }
    }
  };

  useEffect(() => {
    const i = setInterval(() => setBalls((prev) => { const next = prev.map((b) => ({ ...b })); tick(next); return next; }), 16);
    return () => clearInterval(i);
  }, []);

  useEffect(() => {
    const c = canvasRef.current; if (!c) return; const x = c.getContext("2d"); if (!x) return;
    x.clearRect(0,0,W,H); x.fillStyle = "#1a6b45"; x.fillRect(40,40,W-80,H-80); x.strokeStyle = "#5b3419"; x.lineWidth = 24; x.strokeRect(30,30,W-60,H-60);
    for (const [px,py] of pockets) { x.fillStyle = "#050505"; x.beginPath(); x.arc(px,py,18,0,Math.PI*2); x.fill(); }
    const cue = balls[0]; if (cue && !cue.pocketed) {
      x.strokeStyle = "rgba(255,255,255,.5)"; x.lineWidth = 2; x.beginPath(); x.moveTo(cue.x, cue.y); x.lineTo(cue.x + Math.cos(angle) * 220, cue.y + Math.sin(angle) * 220); x.stroke();
      x.strokeStyle = "#d7b37d"; x.lineWidth = 6; x.beginPath(); x.moveTo(cue.x - Math.cos(angle) * (60 + power * 70), cue.y - Math.sin(angle) * (60 + power * 70)); x.lineTo(cue.x - Math.cos(angle) * 10, cue.y - Math.sin(angle) * 10); x.stroke();
    }
    for (const b of balls) { if (b.pocketed) continue; x.fillStyle = b.color; x.beginPath(); x.arc(b.x,b.y,R,0,Math.PI*2); x.fill(); }
  }, [balls, angle, power, pockets]);

  useEffect(() => {
    if (aiMode && started) {
      const moving = balls.some((b) => Math.abs(b.vx) + Math.abs(b.vy) > 0.01);
      if (moving) return;
      const cue = balls[0]; if (!cue || cue.pocketed) return;
      const target = balls.find((b) => b.id !== 0 && !b.pocketed);
      if (!target) return;
      const a = Math.atan2(target.y - cue.y, target.x - cue.x);
      setTimeout(() => {
        setBalls((prev) => prev.map((b) => b.id === 0 ? { ...b, vx: Math.cos(a) * 8.5, vy: Math.sin(a) * 8.5 } : b));
        setStatus("AI took a shot.");
      }, 1200);
    }
  }, [balls, aiMode, started]);

  useEffect(() => {
    if (aiMode) return;
    const check = async () => {
      const res = await fetch(`/api/pool/get-match?matchId=${matchId}`, { cache: "no-store" });
      const data = await res.json();
      if (data.match?.status === "active") { setStarted(true); setStatus("Match started. Your turn."); }
    };
    check();
    const id = setInterval(check, 2000);
    return () => clearInterval(id);
  }, [matchId, aiMode]);

  return <div className="min-h-screen bg-[#09121a] p-4 text-white">
    <NavigationBar currentPath="/casino" />
    <div className="mx-auto mt-6 max-w-6xl rounded-xl border border-cyan-500/40 bg-black/30 p-4">
      <h1 className="text-3xl font-black text-fuchsia-300">Pool Match</h1>
      <p className="text-cyan-200">{status}</p>
      {!started ? <div className="mt-4 rounded bg-yellow-500/20 p-3">Game will start when another player joins this lobby.</div> : null}
      <div className="mt-4 overflow-x-auto"><canvas ref={canvasRef} width={W} height={H} className="rounded-xl border border-emerald-600 bg-[#0f3f2a]"/></div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label>Aiming bar: {Math.round((angle + Math.PI) / (Math.PI * 2) * 360)}°<input className="w-full" type="range" min={-Math.PI} max={Math.PI} step={0.01} value={angle} onChange={(e) => setAngle(Number(e.target.value))} /></label>
        <label>Shot power: {power.toFixed(2)}<input className="w-full" type="range" min={0.2} max={1} step={0.01} value={power} onChange={(e) => setPower(Number(e.target.value))} /></label>
      </div>
      <button disabled={!started} onClick={() => setBalls((prev) => prev.map((b) => b.id === 0 ? { ...b, vx: Math.cos(angle) * (4 + power * 8), vy: Math.sin(angle) * (4 + power * 8) } : b))} className="mt-3 rounded bg-fuchsia-500 px-4 py-2 font-bold text-black disabled:opacity-40">Take Shot</button>
    </div>
  </div>;
}
