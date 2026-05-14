"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import NavigationBar from "../../../../../components/navigation-bar";
import { useSocket } from "../../../../../context/SocketProvider";
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
import {
  drawAimGuide,
  drawBalls,
  drawTable,
} from "../../../../../lib/pool/render";
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

type PoolLivePayload = {
  matchId: string;
  sourceSeat: PlayerTurn;
  balls?: Ball[];
  turn?: PlayerTurn;
  myTeam?: Team;
  oppTeam?: Team;
  openTable?: boolean;
  ballInHand?: boolean;
  winner?: PlayerTurn | null;
  aim?: number;
  pull?: number;
  version: number;
  settled?: boolean;
  foul?: boolean;
  foulMessage?: string | null;
};

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

const isTeamBall = (n: number, team: Team) =>
  team === "solids" ? n >= 1 && n <= 7 : n >= 9 && n <= 15;

const teamHasBalls = (balls: Ball[], team: Team) =>
  !!team &&
  balls.some(
    (b) => !b.pocketed && !b.animatingPocket && isTeamBall(b.number, team),
  );

function planAiShot(balls: Ball[], aiTeam: Team, openTable: boolean) {
  const cue = balls.find((b) => b.number === 0 && !b.pocketed);
  if (!cue) return null;

  const objectBalls = balls.filter(
    (b) => !b.pocketed && !b.animatingPocket && b.number > 0,
  );
  const legalTargets = objectBalls.filter((b) => {
    if (openTable || !aiTeam) return b.number !== 8;
    if (teamHasBalls(balls, aiTeam)) return isTeamBall(b.number, aiTeam);
    return b.number === 8;
  });
  const targets = legalTargets.length
    ? legalTargets
    : objectBalls.filter((b) => b.number !== 8);
  if (!targets.length) return null;

  const target = [...targets].sort(
    (a, b) =>
      Math.hypot(a.x - cue.x, a.y - cue.y) -
      Math.hypot(b.x - cue.x, b.y - cue.y),
  )[0];
  const distance = Math.hypot(target.x - cue.x, target.y - cue.y);
  const angle = Math.atan2(target.y - cue.y, target.x - cue.x);

  return {
    angle: angle + (Math.random() - 0.5) * 0.035,
    power: Math.min(MAX_PULL, Math.max(72, distance / 5.4)),
  };
}

export default function Page() {
  const { matchId } = useParams<{ matchId: string }>();
  const router = useRouter();
  const { socket } = useSocket();
  const searchParams = useSearchParams();
  const aiMode = searchParams.get("ai") === "1";
  const initialTurn: PlayerTurn = searchParams.get("turn") === "2" ? 2 : 1;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ballsRef = useRef<Ball[]>([]);
  const ownerRef = useRef<PlayerTurn>(1);
  const liveEmitAtRef = useRef(0);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const shotLock = useRef(false);
  const aiShotLock = useRef(false);
  const shotMeta = useRef<ShotMeta>({
    firstContactNumber: null,
    railAfterContact: false,
    pocketedNumbers: [],
    cueScratch: false,
  });

  const [balls, setBalls] = useState(setupBalls());
  const [activeMatchId, setActiveMatchId] = useState(matchId);
  const [turn, setTurn] = useState<PlayerTurn>(initialTurn);
  const [owner, setOwner] = useState<PlayerTurn>(1);
  const [status, setStatus] = useState("Waiting...");
  const [lastFoul, setLastFoul] = useState<string | null>(null);
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
  const [remoteAim, setRemoteAim] = useState<{
    angle: number;
    pull: number;
    seat: PlayerTurn;
    at: number;
  } | null>(null);

  useEffect(() => {
    ballsRef.current = balls;
  }, [balls]);

  useEffect(() => {
    ownerRef.current = owner;
  }, [owner]);

  useEffect(() => {
    setActiveMatchId(matchId);
  }, [matchId]);
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

  const emitLiveState = (
    payload: Omit<PoolLivePayload, "matchId" | "version">,
  ) => {
    if (!socket || aiMode) return;
    socket.emit("room_event", {
      roomId: `pool:${activeMatchId}`,
      event: "pool:live-state",
      payload: {
        ...payload,
        matchId: activeMatchId,
        version: Date.now(),
      },
    });
  };

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const x = c.getContext("2d");
    if (!x) return;
    drawTable(x);
    const cue = balls.find((b) => b.number === 0);
    if (cue && !cue.pocketed && canShoot) {
      drawAimGuide(x, cue, aim, pull);
    } else if (
      cue &&
      !cue.pocketed &&
      remoteAim &&
      remoteAim.seat !== owner &&
      Date.now() - remoteAim.at < 2500
    ) {
      drawAimGuide(x, cue, remoteAim.angle, remoteAim.pull);
    }
    drawBalls(x, balls);
  }, [balls, canShoot, aim, pull, owner, turn, remoteAim]);

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
    if (res.foul && res.foulMessage) {
      setStatus(res.foulMessage);
      setLastFoul(res.foulMessage);
    } else {
      setStatus(res.keepTurn ? "Nice shot — shoot again." : "Shot complete.");
      setLastFoul(null);
    }
    setTurn(res.nextTurn);
    setBallInHand(res.ballInHand);
    setWinner(res.winner);
    setMyTeam(res.assignedMyTeam);
    setOppTeam(res.assignedOppTeam);
    setOpenTable(!(res.assignedMyTeam && res.assignedOppTeam));
    const syncedBalls = res.ballInHand
      ? balls.map((b) =>
          b.number === 0
            ? {
                ...b,
                pocketed: false,
                animatingPocket: false,
                opacity: 1,
                scale: 1,
                x: 180,
                y: 250,
                vx: 0,
                vy: 0,
              }
            : b,
        )
      : balls;
    if (res.ballInHand) setBalls(syncedBalls);
    const version = Date.now();
    setSyncVersion(version);
    emitLiveState({
      sourceSeat: owner,
      balls: syncedBalls,
      turn: res.nextTurn,
      myTeam: res.assignedMyTeam,
      oppTeam: res.assignedOppTeam,
      openTable: !(res.assignedMyTeam && res.assignedOppTeam),
      ballInHand: res.ballInHand,
      winner: res.winner,
      settled: true,
      foul: res.foul,
      foulMessage: res.foulMessage,
    });
    void pushPoolState(
      activeMatchId,
      {
        balls: syncedBalls,
        turn: res.nextTurn,
        myTeam: res.assignedMyTeam,
        oppTeam: res.assignedOppTeam,
        openTable: !(res.assignedMyTeam && res.assignedOppTeam),
        ballInHand: res.ballInHand,
        winner: res.winner,
        version,
        perspectiveSeat: owner,
        foul: res.foul,
        foulMessage: res.foulMessage,
      },
      aiMode,
    );
  }, [
    balls,
    turn,
    owner,
    myTeam,
    oppTeam,
    openTable,
    aiMode,
    activeMatchId,
    socket,
  ]);

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
    setBalls((prev) => {
      const next = prev.map((b) =>
        b.number === 0
          ? { ...b, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed }
          : b,
      );
      emitLiveState({
        sourceSeat: owner,
        balls: next,
        turn,
        aim: a,
        pull: p,
        settled: false,
      });
      return next;
    });
  };

  useEffect(() => {
    if (aiMode || !socket || !shotLock.current || turn !== owner) return;
    if (!isMoving(balls)) return;
    const now = Date.now();
    if (now - liveEmitAtRef.current < 48) return;
    liveEmitAtRef.current = now;
    emitLiveState({
      sourceSeat: owner,
      balls,
      turn,
      aim,
      pull,
      settled: false,
    });
  }, [aiMode, socket, balls, turn, owner, aim, pull]);

  const onDown = (e: any) => {
    if (winner || !canShoot || turn !== owner) return;
    const r = e.currentTarget.getBoundingClientRect();
    const p = touchPoint(e, r);
    dragRef.current = p;
  };
  const onMove = (e: any) => {
    const cue = balls.find((b) => b.number === 0);
    if (!cue || !canShoot || turn !== owner) return;
    const r = e.currentTarget.getBoundingClientRect();
    const p = touchPoint(e, r);
    setAim(Math.atan2(p.y - cue.y, p.x - cue.x));
    if (dragRef.current) {
      const nextPull = Math.min(
        MAX_PULL,
        Math.hypot(p.x - dragRef.current.x, p.y - dragRef.current.y),
      );
      setPull(nextPull);
      emitLiveState({
        sourceSeat: owner,
        balls,
        turn,
        aim: Math.atan2(p.y - cue.y, p.x - cue.x),
        pull: nextPull,
        settled: false,
      });
    }
  };
  const onUp = () => {
    if (dragRef.current && canShoot && turn === owner) fireShot(aim, pull);
    dragRef.current = null;
    setPull(0);
  };

  useEffect(() => {
    if (!socket || aiMode) return;
    const roomId = `pool:${activeMatchId}`;

    const handleLiveState = (message: { payload?: PoolLivePayload }) => {
      const payload = message?.payload;
      if (!payload || payload.matchId !== activeMatchId) return;
      if (payload.sourceSeat === ownerRef.current) return;

      if (payload.balls) setBalls(payload.balls);
      if (payload.turn) setTurn(payload.turn);
      const shouldSwapTeams = payload.sourceSeat !== ownerRef.current;
      if ("myTeam" in payload || "oppTeam" in payload) {
        setMyTeam(
          shouldSwapTeams
            ? (payload.oppTeam ?? null)
            : (payload.myTeam ?? null),
        );
        setOppTeam(
          shouldSwapTeams
            ? (payload.myTeam ?? null)
            : (payload.oppTeam ?? null),
        );
      }
      if (typeof payload.openTable === "boolean")
        setOpenTable(payload.openTable);
      if (typeof payload.ballInHand === "boolean")
        setBallInHand(payload.ballInHand);
      if ("winner" in payload) setWinner(payload.winner ?? null);
      if (typeof payload.aim === "number") {
        setRemoteAim({
          angle: payload.aim,
          pull: payload.pull ?? 0,
          seat: payload.sourceSeat,
          at: Date.now(),
        });
      }
      if (payload.settled) {
        setSyncVersion((current) => Math.max(current, payload.version));
        setLastFoul(
          payload.foul ? (payload.foulMessage ?? "Foul. Ball in hand.") : null,
        );
        if (payload.foulMessage) setStatus(payload.foulMessage);
        else setStatus("Shot complete.");
      }
    };

    socket.emit("join_room", { roomId });
    socket.on("pool:live-state", handleLiveState);

    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("pool:live-state", handleLiveState);
    };
  }, [socket, aiMode, activeMatchId]);

  useEffect(() => {
    if (!(aiMode && turn === 2 && canShoot) || winner) {
      aiShotLock.current = false;
      return;
    }
    if (aiShotLock.current) return;

    const shot = planAiShot(ballsRef.current, oppTeam, openTable);
    if (!shot) return;

    aiShotLock.current = true;
    setAim(shot.angle);
    setPull(shot.power);
    setStatus("AI is lining up a shot...");

    const timer = setTimeout(() => {
      fireShot(shot.angle, shot.power);
      setPull(0);
      aiShotLock.current = false;
    }, 260);

    return () => clearTimeout(timer);
  }, [aiMode, turn, canShoot, winner, oppTeam, openTable]);

  useEffect(() => {
    const syncMatch = async () => {
      const res = await fetch(`/api/pool/get-match?matchId=${activeMatchId}`, {
        cache: "no-store",
      });
      const data = await res.json();
      const gs = data.match?.gameState;

      if (data.match?.status === "active") {
        setStarted(true);
        setStatus((prev) => (prev === "Waiting..." ? "Match started." : prev));
        if (!aiMode && data.match.id && data.match.id !== activeMatchId) {
          setActiveMatchId(data.match.id);
          router.replace(`/casino/pool-masters/game/${data.match.id}`);
        }
      }
      if (data.viewerSeat) setOwner(data.viewerSeat);
      if (data.viewerName) setMyName(data.viewerName);
      if (data.opponentName) setOppName(data.opponentName);
      if (gs?.version && isNewerVersion(gs.version, syncVersion)) {
        setSyncVersion(gs.version);
        if (gs.balls) setBalls(gs.balls);
        if (gs.turn) setTurn(gs.turn);
        const remoteSeat = gs.perspectiveSeat;
        const shouldSwapTeams =
          remoteSeat && data.viewerSeat && remoteSeat !== data.viewerSeat;
        setMyTeam(shouldSwapTeams ? (gs.oppTeam ?? null) : (gs.myTeam ?? null));
        setOppTeam(
          shouldSwapTeams ? (gs.myTeam ?? null) : (gs.oppTeam ?? null),
        );
        setOpenTable(gs.openTable ?? true);
        setBallInHand(gs.ballInHand ?? false);
        setWinner(gs.winner ?? null);
        setLastFoul(gs.foul ? (gs.foulMessage ?? "Foul. Ball in hand.") : null);
        if (gs.foulMessage) setStatus(gs.foulMessage);
      }
    };

    if (aiMode) {
      if (syncVersion === 0) void syncMatch();
      return;
    }

    void syncMatch();
    const id = setInterval(syncMatch, 650);
    return () => clearInterval(id);
  }, [activeMatchId, aiMode, syncVersion, router]);
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
    <div className="min-h-screen overflow-x-clip bg-[#202124] bg-[radial-gradient(circle_at_center,#353535_0,#1f1f1f_55%,#101010_100%)] p-2 text-white sm:p-4">
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto mt-3 max-w-7xl rounded-2xl border border-black/70 bg-black/45 p-3 shadow-[0_20px_70px_rgba(0,0,0,.65)] sm:mt-6 sm:p-4">
        <div className="mb-2 text-center text-lg font-black text-yellow-300 drop-shadow sm:text-2xl">
          {started
            ? turn === owner
              ? "You will shoot."
              : `${oppName} will shoot.`
            : "Waiting for match start..."}
        </div>
        <div
          className={`mb-3 rounded-xl border px-4 py-3 text-center font-extrabold ${lastFoul ? "border-red-300 bg-red-700/85 text-white" : "border-white/10 bg-black/30 text-slate-100"}`}
        >
          {lastFoul ? `FOUL — ${lastFoul.replace(/^Foul: /, "")}` : status}
          {ballInHand ? " • Ball in hand" : ""}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:gap-4">
          <div className="rounded-xl border border-white/10 bg-[#1f1f1f]/90 p-3 shadow-inner">
            <p className="font-bold">{myName}</p>
            <p className="text-xs text-cyan-100">{myTeam ?? "unassigned"}</p>
            <p className="mt-1 text-sm">
              Balls: {myRemaining.join(", ") || "none"}
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-[#1f1f1f]/90 p-3 text-right shadow-inner">
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
          className="mt-4 w-full touch-none rounded-2xl border border-black bg-[#111] shadow-[0_12px_40px_rgba(0,0,0,.75)]"
        />
      </div>
    </div>
  );
}
