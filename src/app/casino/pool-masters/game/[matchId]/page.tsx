"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import NavigationBar from "../../../../../components/navigation-bar";
import {
  BALL_LAYOUT,
  MAX_PULL,
  TABLE_H,
  TABLE_W,
} from "../../../../../lib/pool/constants";
import {
  applyShotPower,
  isMoving,
  tickPhysics,
} from "../../../../../lib/pool/physics";
import { evaluateRules } from "../../../../../lib/pool/rules";
import { drawBalls, drawTable } from "../../../../../lib/pool/render";
import {
  isNewerVersion,
  pushPoolState,
} from "../../../../../lib/pool/multiplayer";
import {
  Ball,
  PlayerTurn,
  ShotMeta,
  Team,
} from "../../../../../lib/pool/types";

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
      striped: false,
      pocketed: false,
    },
  ];
  let k = 1;
  for (let r = 0; r < 5; r++)
    for (let c = 0; c <= r; c++) {
      const d = BALL_LAYOUT[k - 1];
      balls.push({
        id: k,
        number: d.n,
        x: 620 + r * 19,
        y: 250 - r * 11 + c * 22,
        vx: 0,
        vy: 0,
        color: d.c,
        striped: d.s,
        pocketed: false,
      });
      k++;
    }
  return balls;
}
const touchPoint = (e: any, rect: DOMRect) =>
  e.touches
    ? {
        x: e.touches[0].clientX - rect.left,
        y: e.touches[0].clientY - rect.top,
      }
    : { x: e.clientX - rect.left, y: e.clientY - rect.top };

export default function Page() {
  const { matchId } = useParams<{ matchId: string }>();
  const aiMode = useSearchParams().get("ai") === "1";
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const shotLock = useRef(false);
  const shotMeta = useRef<ShotMeta>({
    firstContactNumber: null,
    railAfterContact: false,
    pocketedNumbers: [],
    cueScratch: false,
  });

  const [balls, setBalls] = useState(setupBalls());
  const [turn, setTurn] = useState<PlayerTurn>(1);
  const [owner, setOwner] = useState<PlayerTurn>(1);
  const [status, setStatus] = useState("Waiting...");
  const [myTeam, setMyTeam] = useState<Team>(null);
  const [oppTeam, setOppTeam] = useState<Team>(null);
  const [openTable, setOpenTable] = useState(true);
  const [ballInHand, setBallInHand] = useState(false);
  const [winner, setWinner] = useState<PlayerTurn | null>(null);
  const [aim, setAim] = useState(0);
  const [pull, setPull] = useState(0);
  const [started, setStarted] = useState(aiMode);
  const [myName, setMyName] = useState("Player 1");
  const [oppName, setOppName] = useState(aiMode ? "AI" : "Player 2");
  const [syncVersion, setSyncVersion] = useState(0);
  const me = useMemo(() => turn === owner, [turn, owner]);

  useEffect(() => {
    const id = setInterval(
      () =>
        setBalls((prev) => {
          const n = prev.map((b) => ({ ...b }));
          tickPhysics(n, shotMeta.current);
          return n;
        }),
      16,
    );
    return () => clearInterval(id);
  }, []);
  const canShoot =
    started &&
    !winner &&
    !isMoving(balls) &&
    (turn === owner || (aiMode && turn === 2));

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const x = c.getContext("2d");
    if (!x) return;
    drawTable(x);
    const cue = balls.find((b) => b.number === 0);
    if (cue && !cue.pocketed && canShoot && turn === owner) {
      x.strokeStyle = "rgba(255,255,255,.35)";
      x.lineWidth = 2;
      x.beginPath();
      x.moveTo(cue.x, cue.y);
      x.lineTo(cue.x + Math.cos(aim) * 260, cue.y + Math.sin(aim) * 260);
      x.stroke();
      x.strokeStyle = "#c3a16a";
      x.lineWidth = 8;
      x.beginPath();
      x.moveTo(
        cue.x - Math.cos(aim) * (64 + pull),
        cue.y - Math.sin(aim) * (64 + pull),
      );
      x.lineTo(cue.x - Math.cos(aim) * 14, cue.y - Math.sin(aim) * 14);
      x.stroke();
    }
    drawBalls(x, balls);
  }, [balls, canShoot, aim, pull, owner, turn]);

  useEffect(() => {
    if (!shotLock.current || isMoving(balls)) return;
    shotLock.current = false;
    const res = evaluateRules({
      balls,
      turn,
      myTurn: owner,
      myTeam,
      oppTeam,
      openTable,
      firstContact: shotMeta.current.firstContactNumber,
      railAfterContact: shotMeta.current.railAfterContact,
      pocketed: [...new Set(shotMeta.current.pocketedNumbers)],
      scratch: shotMeta.current.cueScratch,
    });
    if (res.foul && res.foulMessage) setStatus(res.foulMessage);
    else setStatus("Shot complete");
    setTurn(res.nextTurn);
    setBallInHand(res.ballInHand);
    setWinner(res.winner);
    setMyTeam(res.assignedMyTeam);
    setOppTeam(res.assignedOppTeam);
    setOpenTable(!(res.assignedMyTeam && res.assignedOppTeam));
    if (res.ballInHand)
      setBalls((prev) =>
        prev.map((b) =>
          b.number === 0
            ? { ...b, pocketed: false, x: 180, y: 250, vx: 0, vy: 0 }
            : b,
        ),
      );
    const version = Date.now();
    setSyncVersion(version);
    void pushPoolState(
      matchId,
      {
        balls,
        turn: res.nextTurn,
        myTeam: res.assignedMyTeam,
        oppTeam: res.assignedOppTeam,
        openTable: !(res.assignedMyTeam && res.assignedOppTeam),
        ballInHand: res.ballInHand,
        winner: res.winner,
        version,
      },
      aiMode,
    );
  }, [balls, turn, owner, myTeam, oppTeam, openTable, aiMode, matchId]);

  const fireShot = (a: number, p: number) => {
    if (!canShoot || isMoving(balls) || shotLock.current) return;
    shotLock.current = true;
    shotMeta.current = {
      firstContactNumber: null,
      railAfterContact: false,
      pocketedNumbers: [],
      cueScratch: false,
    };
    const speed = applyShotPower(p);
    setBalls((prev) =>
      prev.map((b) =>
        b.number === 0
          ? { ...b, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed }
          : b,
      ),
    );
  };

  const onDown = (e: any) => {
    if (winner) return;
    const r = e.currentTarget.getBoundingClientRect();
    const p = touchPoint(e, r);
    dragRef.current = p;
  };
  const onMove = (e: any) => {
    const cue = balls.find((b) => b.number === 0);
    if (!cue) return;
    const r = e.currentTarget.getBoundingClientRect();
    const p = touchPoint(e, r);
    setAim(Math.atan2(p.y - cue.y, p.x - cue.x));
    if (dragRef.current)
      setPull(
        Math.min(
          MAX_PULL,
          Math.hypot(p.x - dragRef.current.x, p.y - dragRef.current.y),
        ),
      );
  };
  const onUp = () => {
    if (dragRef.current) fireShot(aim, pull);
    dragRef.current = null;
    setPull(0);
  };

  useEffect(() => {
    if (aiMode && turn === 2 && canShoot) {
      const cue = balls[0],
        t = balls.find((b) => !b.pocketed && b.number > 0 && b.number !== 8);
      if (!cue || !t) return;
      const a =
        Math.atan2(t.y - cue.y, t.x - cue.x) + (Math.random() - 0.5) * 0.1;
      const timer = setTimeout(() => fireShot(a, 82), 700);
      return () => clearTimeout(timer);
    }
  }, [aiMode, turn, balls, winner, canShoot]);

  useEffect(() => {
    if (aiMode) return;
    const id = setInterval(async () => {
      const res = await fetch(`/api/pool/get-match?matchId=${matchId}`, {
        cache: "no-store",
      });
      const data = await res.json();
      const gs = data.match?.gameState;
      if (data.match?.status === "active") setStarted(true);
      if (data.viewerSeat) setOwner(data.viewerSeat);
      if (data.viewerName) setMyName(data.viewerName);
      if (data.opponentName) setOppName(data.opponentName);
      if (gs?.version && isNewerVersion(gs.version, syncVersion)) {
        setSyncVersion(gs.version);
        setBalls(gs.balls ?? balls);
        setTurn(gs.turn ?? turn);
        setMyTeam(gs.myTeam ?? null);
        setOppTeam(gs.oppTeam ?? null);
        setOpenTable(gs.openTable ?? true);
        setBallInHand(gs.ballInHand ?? false);
        setWinner(gs.winner ?? null);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [matchId, aiMode, syncVersion, balls, turn]);
  const myRemaining = BALL_LAYOUT.filter((b) =>
    myTeam ? (myTeam === "solids" ? !b.s && b.n !== 8 : b.s) : b.n !== 8,
  )
    .filter((b) => !balls.find((bb) => bb.number === b.n)?.pocketed)
    .map((b) => b.n);
  const oppRemaining = BALL_LAYOUT.filter((b) =>
    oppTeam ? (oppTeam === "solids" ? !b.s && b.n !== 8 : b.s) : b.n !== 8,
  )
    .filter((b) => !balls.find((bb) => bb.number === b.n)?.pocketed)
    .map((b) => b.n);

  return (
    <div className="min-h-screen bg-[#0b8f7f] p-4 text-white">
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto mt-6 max-w-6xl rounded-xl border border-cyan-500/40 bg-black/35 p-4">
        <h1 className="text-3xl font-black text-fuchsia-300">Pool Match</h1>
        <p>
          {started ? status : "Waiting for match start..."} • Turn:{" "}
          {turn === owner ? myName : oppName}
          {ballInHand ? " • Ball in hand" : ""}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-4">
          <div className="rounded bg-slate-800/80 p-3">
            <p className="font-bold">{myName}</p>
            <p className="text-xs text-cyan-100">{myTeam ?? "unassigned"}</p>
            <p className="mt-1 text-sm">
              Balls: {myRemaining.join(", ") || "none"}
            </p>
          </div>
          <div className="rounded bg-slate-800/80 p-3 text-right">
            <p className="font-bold">{oppName}</p>
            <p className="text-xs text-cyan-100">{oppTeam ?? "unassigned"}</p>
            <p className="mt-1 text-sm">
              Balls: {oppRemaining.join(", ") || "none"}
            </p>
          </div>
        </div>
        {winner && (
          <div className="my-2 rounded bg-fuchsia-900/70 p-2 font-bold">
            Winner: {winner === owner ? myName : oppName}
          </div>
        )}
        <canvas
          ref={canvasRef}
          width={TABLE_W}
          height={TABLE_H}
          onMouseDown={onDown}
          onMouseMove={onMove}
          onMouseUp={onUp}
          onMouseLeave={onUp}
          onTouchStart={onDown}
          onTouchMove={onMove}
          onTouchEnd={onUp}
          className="mt-4 w-full touch-none rounded-xl border border-amber-700/70 bg-[#0f3f2a]"
        />
      </div>
    </div>
  );
}
