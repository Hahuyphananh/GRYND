"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import NavigationBar from "../../../../../components/navigation-bar";
import { useSocket } from "../../../../../context/SocketProvider";
import { BALL_LAYOUT, MAX_PULL, TABLE_H, TABLE_W } from "../../../../../lib/pool/constants";
import { applyShotPower, isMoving, tickPhysics } from "../../../../../lib/pool/physics";
import { evaluateRules } from "../../../../../lib/pool/rules";
import { drawAimGuide, drawBalls, drawBankPreview, drawShotPreview, drawTable } from "../../../../../lib/pool/render";
import { isNewerVersion, pushPoolState } from "../../../../../lib/pool/multiplayer";
import { Ball, PlayerTurn, ShotLifecycle, ShotMeta, Team } from "../../../../../lib/pool/types";
import { useUser } from "@clerk/nextjs";
import ReportModal from "../../../../../components/ReportModal";
import { celebrateWin, gameOverModal } from "../../../../../lib/animations";

type PoolLivePayload = {
  userId?: string;
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
  spinX?: number;
  spinY?: number;
  version: number;
  settled?: boolean;
  foul?: boolean;
  foulMessage?: string | null;
  lifecycle?: ShotLifecycle;
  shotId?: string | null;
  pocketedNumbers?: number[];
};

type ShotEntry = {
  turnNumber: number;
  playerName: string;
  seat: PlayerTurn;
  pocketedNumbers: number[];
  foul: boolean;
  foulMessage: string | null;
  ballInHand: boolean;
  winner: boolean;
  timestamp: number;
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
  !!team && balls.some((b) => !b.pocketed && !b.animatingPocket && isTeamBall(b.number, team));

function planAiShot(balls: Ball[], aiTeam: Team, openTable: boolean) {
  const cue = balls.find((b) => b.number === 0 && !b.pocketed);
  if (!cue) return null;

  const objectBalls = balls.filter((b) => !b.pocketed && !b.animatingPocket && b.number > 0);
  const legalTargets = objectBalls.filter((b) => {
    if (openTable || !aiTeam) return b.number !== 8;
    if (teamHasBalls(balls, aiTeam)) return isTeamBall(b.number, aiTeam);
    return b.number === 8;
  });
  const targets = legalTargets.length ? legalTargets : objectBalls.filter((b) => b.number !== 8);
  if (!targets.length) return null;

  const target = [...targets].sort(
    (a, b) => Math.hypot(a.x - cue.x, a.y - cue.y) - Math.hypot(b.x - cue.x, b.y - cue.y)
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
  const { user } = useUser();
  const searchParams = useSearchParams();
  const aiMode = searchParams.get("ai") === "1";
  const initialTurn: PlayerTurn = searchParams.get("turn") === "2" ? 2 : 1;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ballsRef = useRef<Ball[]>([]);
  const ownerRef = useRef<PlayerTurn>(1);
  const turnRef = useRef<PlayerTurn>(initialTurn);
  const liveEmitAtRef = useRef(0);
  const livePersistAtRef = useRef(0);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const shotLock = useRef(false);
  const aiShotLock = useRef(false);
  const localShotInProgressRef = useRef(false);
  const remoteShotInProgressRef = useRef(false);
  const shotHistoryRef = useRef<ShotEntry[]>([]);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPolledVersionRef = useRef(0);
  const pendingActionRef = useRef(false);
  const pendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shotMeta = useRef<ShotMeta>({
    firstContactNumber: null,
    railAfterContact: false,
    pocketedNumbers: [],
    cueScratch: false,
  });
  const lifecycleRef = useRef<ShotLifecycle>("IDLE");
  const activeShotIdRef = useRef<string | null>(null);
  const remoteShotMetaInitializedRef = useRef(false);
  const userIdRef = useRef<string | undefined>(undefined);
  const myNameRef = useRef("Player 1");
  const oppNameRef = useRef("Player 2");
  const syncVersionRef = useRef(0);
  const settleInterpRef = useRef<{ to: Ball[]; startTime: number } | null>(null);
  const spinRef = useRef({ x: 0, y: 0 });
  const notificationIdRef = useRef(0);
  const mountedRef = useRef(true);
  const notificationTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const turnNumberRef = useRef(0);
  const [syncVersion, setSyncVersion] = useState(0);
  const [spin, setSpin] = useState({ x: 0, y: 0 });
  const [notifications, setNotifications] = useState<
    { id: number; message: string; type: "pocket" | "foul" | "win" }[]
  >([]);
  const [shotHistory, setShotHistory] = useState<ShotEntry[]>([]);
  const [rematching, setRematching] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showResignConfirm, setShowResignConfirm] = useState(false);
  const [resigning, setResigning] = useState(false);
  const [showWinLossPopup, setShowWinLossPopup] = useState(false);
  const resigningRef = useRef(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [opponentClerkId, setOpponentClerkId] = useState<string | null>(null);

  // Keep userIdRef in sync so the socket handler never captures a stale user
  useEffect(() => {
    userIdRef.current = user?.id;
  }, [user?.id]);

  // Keep syncVersionRef in sync so the socket handler can version-check
  // without re-registering the listener on every settled shot
  useEffect(() => {
    syncVersionRef.current = syncVersion;
  }, [syncVersion]);

  useEffect(() => {
    spinRef.current = spin;
  }, [spin]);

  // ── Auto-dismiss notifications individually after 3s ──
  useEffect(() => {
    const timers = notificationTimersRef.current;
    notifications.forEach((n) => {
      if (!timers.has(n.id)) {
        timers.set(
          n.id,
          setTimeout(() => {
            if (!mountedRef.current) return;
            setNotifications((prev) => prev.filter((p) => p.id !== n.id));
            timers.delete(n.id);
          }, 3000),
        );
      }
    });
    // Clean up timers for notifications that no longer exist
    const activeIds = new Set(notifications.map((n) => n.id));
    timers.forEach((timer, id) => {
      if (!activeIds.has(id)) {
        clearTimeout(timer);
        timers.delete(id);
      }
    });
  }, [notifications]);

  // ── Cleanup on unmount ──
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      notificationTimersRef.current.forEach((t) => clearTimeout(t));
      notificationTimersRef.current.clear();
      if (pendingTimeoutRef.current) clearTimeout(pendingTimeoutRef.current);
      if (opponentVisorTimerRef.current) clearTimeout(opponentVisorTimerRef.current);
      if (remoteAimTimerRef.current) clearTimeout(remoteAimTimerRef.current);
    };
  }, []);

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
  const [remoteAim, setRemoteAim] = useState<{
    angle: number;
    pull: number;
    seat: PlayerTurn;
    at: number;
    spinX?: number;
    spinY?: number;
  } | null>(null);
  const [showRemoteAim, setShowRemoteAim] = useState(false);
  const [showOpponentVisor, setShowOpponentVisor] = useState(false);
  const opponentVisorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteAimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processedShotIdsRef = useRef<Set<string>>(new Set());

  // Derived: compute gameOverMessage from winner/owner/oppName
  const gameOverMessage = winner
    ? {
        won: winner === owner,
        message: winner === owner ? "You Win! 🏆" : `${oppName} Wins!`,
      }
    : null;

  // Show win/loss popup when winner is determined
  useEffect(() => {
    if (winner && !showWinLossPopup) {
      // Fire confetti if local player won
      if (winner === ownerRef.current) celebrateWin();
      // Small delay so the final ball positions render before the popup
      const timer = setTimeout(() => setShowWinLossPopup(true), 600);
      return () => clearTimeout(timer);
    }
  }, [winner, showWinLossPopup]);

  // Keep name refs in sync so websocket/event handlers never capture stale names
  // Must be after myName/oppName state declarations
  useEffect(() => {
    myNameRef.current = myName;
  }, [myName]);
  useEffect(() => {
    oppNameRef.current = oppName;
  }, [oppName]);

  // Keep shotHistoryRef in sync for duplicate detection in polling
  useEffect(() => {
    shotHistoryRef.current = shotHistory;
  }, [shotHistory]);

  useEffect(() => {
    ballsRef.current = balls;
  }, [balls]);

  useEffect(() => {
    ownerRef.current = owner;
  }, [owner]);

  useEffect(() => {
    turnRef.current = turn;
  }, [turn]);

  useEffect(() => {
    setActiveMatchId(matchId);
  }, [matchId]);

 useEffect(() => {
   let rafId: number;
   let lastTime = performance.now();
   let accumulator = 0;
   const FIXED_DT = 16.667; // ms  → ~60 Hz physics, consistent across all displays
   const MAX_TICKS = 5;      // prevent spiral-of-death on long background pauses

   const loop = () => {
     const now = performance.now();
     const frameDt = Math.min(100, now - lastTime);
     lastTime = now;

     const interp = settleInterpRef.current;

     if (interp) {
       // ── SETTLED interpolation: smoothly lerp toward authoritative positions ──
       setBalls((prev) => {
         const elapsed = performance.now() - interp.startTime;
         const duration = 120; // ms
         const t = Math.min(1, elapsed / duration);
         // ease-out cubic so the drift-in feels natural
         const eased = 1 - Math.pow(1 - t, 3);

         if (t >= 1) {
           settleInterpRef.current = null;
           return interp.to;
         }

         const next = prev.map((b, i) => {
           const target = interp.to[i];
           if (!target) return b;
           // pocketed / animating balls just adopt the target state
           if (target.pocketed || target.animatingPocket) return { ...target };
           return {
             ...b,
             x: b.x + (target.x - b.x) * eased,
             y: b.y + (target.y - b.y) * eased,
             vx: 0,
             vy: 0,
           };
         });
         return next;
       });
     } else {
       // ── Fixed-timestep physics ──
       accumulator += frameDt;
       let ticks = 0;
       while (accumulator >= FIXED_DT && ticks < MAX_TICKS) {
         setBalls((prev) => {
           if (!shotLock.current) return prev;
           if (!localShotInProgressRef.current && !remoteShotInProgressRef.current) return prev;
           if (!isMoving(prev)) {
             // Return a fresh copy to force React to commit the stopped state
             // (React 18 batching would otherwise bail out if prev is same ref)
             return prev.map((b) => ({ ...b }));
           }
           const next = prev.map((b) => ({ ...b }));
           tickPhysics(next, shotMeta.current);
           return next;
         });
         accumulator -= FIXED_DT;
         ticks++;
       }
       if (ticks > 0) {
         lifecycleRef.current = "ROLLING";
       }
     }

     rafId = requestAnimationFrame(loop);
   };
   rafId = requestAnimationFrame(loop);
   return () => cancelAnimationFrame(rafId);
 }, []);

  const isMyTurn = turn === owner;  const canShoot =
  started &&
  !winner &&
  !isMoving(balls) &&
  settleInterpRef.current === null &&
  (aiMode ? true : isMyTurn);


  const handleResign = async () => {
    if (resigningRef.current) return;
    resigningRef.current = true;
    setResigning(true);
    setShowResignConfirm(false);
    // Clean up any in-progress game state before resigning
    shotLock.current = false;
    localShotInProgressRef.current = false;
    remoteShotInProgressRef.current = false;
    settleInterpRef.current = null;
    try {
      const res = await fetch("/api/pool/resign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId: activeMatchId }),
      });
      const data = await res.json();
      if (data.success) {
        const resignedWinner: PlayerTurn = ownerRef.current === 1 ? 2 : 1;
        setWinner(resignedWinner);
        setStatus("You resigned.");
        // Emit resign via socket for live opponent
        if (!aiMode && socket) {
          socket.emit("room_event", {
            roomId: `pool:${activeMatchId}`,
            event: "pool:resigned",
            payload: {
              matchId: activeMatchId,
              resignedUserId: user?.id,
            },
          });
        }
      }
    } catch {
      // Resign request failed
    } finally {
      resigningRef.current = false;
      if (mountedRef.current) setResigning(false);
    }
  };

  const handleReturnToLobby = () => {
    router.push("/casino/pool-masters");
  };

  const handleRematch = async () => {
    setRematching(true);
    try {
      if (aiMode) {
        const res = await fetch("/api/pool/create-ai-match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wager: 10 }),
        });
        const data = await res.json();
        if (data.ok) {
          router.replace(
            `/casino/pool-masters/game/${data.matchId}?ai=1&turn=${data.firstTurnSeat}`,
          );
        }
      } else {
        router.push("/casino/pool-masters");
      }
    } catch {
      if (mountedRef.current) setRematching(false);
    }
  };

  const emitLiveState = (payload: Omit<PoolLivePayload, "matchId" | "version">) => {
    if (!socket || aiMode) return;
    socket.emit("room_event", {
      roomId: `pool:${activeMatchId}`,
      event: "pool:live-state",
      payload: {
  ...payload,
  userId: user?.id,
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
      drawShotPreview(x, cue, aim, balls);
      drawBankPreview(x, cue, aim, balls, true);
    } else if (cue && !cue.pocketed && showRemoteAim) {
      // Show opponent's full aim guide including cue stick, ghost ball & trajectory
      drawAimGuide(x, cue, remoteAim!.angle, remoteAim!.pull);
      drawShotPreview(x, cue, remoteAim!.angle, balls);
      drawBankPreview(x, cue, remoteAim!.angle, balls, false);
    }
    drawBalls(x, balls);
  }, [balls, canShoot, aim, pull, owner, turn, remoteAim, showRemoteAim]);

  useEffect(() => {
    if (!shotLock.current || isMoving(balls)) return;
    shotLock.current = false;
    lifecycleRef.current = "SETTLED";
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
    // ── Generate shot notifications ──
    const pocketedSet = [...new Set(shotMeta.current.pocketedNumbers)];
    if (pocketedSet.length > 0) {
      const idBase = notificationIdRef.current++;
      setNotifications((prev) => [
        ...prev,
        ...pocketedSet.map((n, i) => ({
          id: idBase + i,
          message: n === 8 ? "8-ball pocketed!" : `Pocketed the ${n} ball!`,
          type: "pocket" as const,
        })),
      ]);
    }
    if (shotMeta.current.cueScratch) {
      setNotifications((prev) => [
        ...prev,
        {
          id: notificationIdRef.current++,
          message: "Cue ball scratched!",
          type: "foul" as const,
        },
      ]);
    }

    if (res.foul && res.foulMessage) {
      setStatus(res.foulMessage);
      setLastFoul(res.foulMessage);
    } else {
      setStatus(res.keepTurn ? "Nice shot — shoot again." : "Shot complete.");
      setLastFoul(null);
    }
    turnRef.current = res.nextTurn;
    setTurn(res.nextTurn);
    setBallInHand(res.ballInHand);
    if (res.winner && !winner) {
      setNotifications((prev) => [
        ...prev,
        {
          id: notificationIdRef.current++,
          message: res.winner === owner ? "You win! 🏆" : `${oppName} wins!`,
          type: "win" as const,
        },
      ]);
    }
    setWinner(res.winner);
    setMyTeam(res.assignedMyTeam);
    setOppTeam(res.assignedOppTeam);
    setOpenTable(!(res.assignedMyTeam && res.assignedOppTeam));

    // ── Push shot history entry ──
    turnNumberRef.current += 1;
    const shotPlayerName = owner === 1 ? myName : oppName;
    setShotHistory((prev) => [
      {
        turnNumber: turnNumberRef.current,
        playerName: shotPlayerName,
        seat: owner,
        pocketedNumbers: pocketedSet,
        foul: res.foul,
        foulMessage: res.foulMessage,
        ballInHand: res.ballInHand,
        winner: !!res.winner,
        timestamp: Date.now(),
      },
      ...prev,
    ]);
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
            : b
        )
      : balls;
    if (res.ballInHand) setBalls(syncedBalls);
    const version = Date.now();
    const shotId = activeShotIdRef.current ?? `shot-${version}`;
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
      lifecycle: "SETTLED",
      shotId,
      pocketedNumbers: pocketedSet,
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
        lifecycle: "SETTLED",
        shotId,
        settled: true,
        pocketedNumbers: pocketedSet,
      },
      aiMode
    );
    lifecycleRef.current = "IDLE";
    localShotInProgressRef.current = false;
    remoteShotInProgressRef.current = false;
    activeShotIdRef.current = null;
  }, [balls, turn, owner, myTeam, oppTeam, openTable, aiMode, activeMatchId, socket]);

  const fireShot = (a: number, p: number) => {
    if (
  isMoving(balls) ||
  shotLock.current ||
  !started ||
  winner
)
  return;

if (!aiMode && turnRef.current !== owner) return;
    settleInterpRef.current = null; // cancel any in-flight SETTLED interpolation
    shotLock.current = true;
    localShotInProgressRef.current = true;
    remoteShotInProgressRef.current = false;
    // Block polling briefly so it doesn't fetch stale DB state while we push the new shot
    if (pendingTimeoutRef.current) clearTimeout(pendingTimeoutRef.current);
    pendingActionRef.current = true;
    pendingTimeoutRef.current = setTimeout(() => { pendingActionRef.current = false; }, 1500);
    lifecycleRef.current = "SHOOTING";
    const shotId = `shot-${Date.now()}-${owner}`;
    activeShotIdRef.current = shotId;
    shotMeta.current = {
      firstContactNumber: null,
      railAfterContact: false,
      pocketedNumbers: [],
      cueScratch: false,
    };
    const speed = applyShotPower(p);
    const currentSpin = spinRef.current;
    setBalls((prev) => {
      const next = prev.map((b) =>
        b.number === 0
          ? {
              ...b,
              vx: Math.cos(a) * speed,
              vy: Math.sin(a) * speed,
              spinX: currentSpin.x,
              spinY: currentSpin.y,
            }
          : b
      );
      const version = Date.now();
      emitLiveState({
        sourceSeat: owner,
        balls: next,
        turn,
        aim: a,
        pull: p,
        spinX: currentSpin.x,
        spinY: currentSpin.y,
        settled: false,
        lifecycle: "SHOOTING",
        shotId,
      });
      void pushPoolState(
        activeMatchId,
        {
          balls: next,
          turn,
          myTeam,
          oppTeam,
          openTable,
          ballInHand,
          winner,
          version,
          perspectiveSeat: owner,
          lifecycle: "SHOOTING",
          shotId,
          settled: false,
        },
        aiMode
      );
      return next;
    });
  };

  useEffect(() => {
    if (!shotLock.current || !localShotInProgressRef.current || turn !== owner) return;
    if (!isMoving(balls)) return;
    const now = Date.now();
    const shotId = activeShotIdRef.current ?? undefined;
    if (!aiMode && socket && now - liveEmitAtRef.current >= 50) {
      liveEmitAtRef.current = now;
      emitLiveState({
        sourceSeat: owner,
        balls,
        turn,
        aim,
        pull,
        settled: false,
        lifecycle: "ROLLING",
        shotId,
      });
    }
    if (now - livePersistAtRef.current >= 500) {
      livePersistAtRef.current = now;
      void pushPoolState(
        activeMatchId,
        {
          balls,
          turn,
          myTeam,
          oppTeam,
          openTable,
          ballInHand,
          winner,
          version: now,
          perspectiveSeat: owner,
          lifecycle: "ROLLING",
          shotId,
          settled: false,
        },
        aiMode
      );
    }
  }, [aiMode, socket, balls, turn, owner, aim, pull, activeMatchId, myTeam, oppTeam, openTable, ballInHand, winner]);

  const onDown = (e: any) => {
    if (winner || !canShoot || turnRef.current !== owner) return;
    const r = e.currentTarget.getBoundingClientRect();
    const p = touchPoint(e, r);
    dragRef.current = p;
  };
  const onMove = (e: any) => {
    const cue = balls.find((b) => b.number === 0);
    if (!canShoot || turnRef.current !== owner) return;
    const r = e.currentTarget.getBoundingClientRect();
    const p = touchPoint(e, r);
    setAim(Math.atan2(p.y - cue.y, p.x - cue.x));
    if (dragRef.current) {
      const nextPull = Math.min(
        MAX_PULL,
        Math.hypot(p.x - dragRef.current.x, p.y - dragRef.current.y)
      );
      setPull(nextPull);
      emitLiveState({
        sourceSeat: owner,
        turn,
        aim: Math.atan2(p.y - cue.y, p.x - cue.x),
        pull: nextPull,
        spinX: spin.x,
        spinY: spin.y,
        settled: false,
        lifecycle: "SHOOTING",
        shotId: activeShotIdRef.current ?? undefined,
      });
    }
  };
  const onUp = () => {
    if (dragRef.current && canShoot && turnRef.current === owner) fireShot(aim, pull);
    dragRef.current = null;
    setPull(0);
  };

  useEffect(() => {
    if (!socket || aiMode) return;
    const roomId = `pool:${activeMatchId}`;

    const handleLiveState = (message: PoolLivePayload | { payload?: PoolLivePayload }) => {
      // The realtime server forwards room_event payload fields directly on the
      // emitted event. Older callers may still wrap the payload, so accept both
      // shapes to keep both players' canvases live-synchronised.
      const payload = (
        "payload" in message && message.payload ? message.payload : message
      ) as PoolLivePayload;
      if (!payload || payload.matchId !== activeMatchId) return;
      if (payload.userId && payload.userId === userIdRef.current) return;

      const localShotInProgress = localShotInProgressRef.current;
      const remoteSettled = payload.settled || payload.lifecycle === "SETTLED";
      const isAimingEvent = payload.lifecycle === "SHOOTING" && !payload.balls;
      const isActualShot = payload.lifecycle === "SHOOTING" && payload.balls;
      const remoteRolling = isActualShot || payload.lifecycle === "ROLLING";

      // Only start remote shot tracking when we receive actual ball data (not just aim events)
      if (remoteRolling && !localShotInProgress) {
        remoteShotInProgressRef.current = true;
        // Engage shotLock so physics simulation can run for remote shots
        shotLock.current = true;
        lifecycleRef.current = payload.lifecycle;
        // Store the active shot ID for tracking
        if (payload.shotId) {
          activeShotIdRef.current = payload.shotId;
        }
        // A new remote shot cancels any in-flight SETTLED interpolation
        settleInterpRef.current = null;
        // Hide the remote aim guide now that the shot has been taken
        setShowRemoteAim(false);
        setShowOpponentVisor(false);
        if (remoteAimTimerRef.current) {
          clearTimeout(remoteAimTimerRef.current);
          remoteAimTimerRef.current = null;
        }
        // Reset shotMeta for remote shot - we track ball movement but don't have
        // first-contact/rail info from remote, so we let physics run naturally
        if (isActualShot && !remoteShotMetaInitializedRef.current) {
          shotMeta.current = {
            firstContactNumber: null,
            railAfterContact: false,
            pocketedNumbers: [],
            cueScratch: false,
          };
          remoteShotMetaInitializedRef.current = true;
        }
      }

     const isSelf = payload.userId === userIdRef.current;

// Only accept ball updates on actual shot SHOOTING (seed physics with velocities) or SETTLED
// (authoritative final).  During ROLLING we let the local physics simulation run
// freely so the opponent sees perfectly smooth motion instead of 100 ms snap-jumps.
// On SETTLED we interpolate from current positions to the authoritative final state
// over ~120 ms instead of snapping — this eliminates the end-of-shot visual pop.
const shouldAcceptBalls = remoteSettled || isActualShot;
if (payload.balls && !isSelf && shouldAcceptBalls && (!payload.version || payload.version > syncVersionRef.current)) {
  if (payload.version) {
    syncVersionRef.current = payload.version;
    setSyncVersion(payload.version);
  }

  if (remoteSettled) {
    // Smooth interpolation toward the authoritative settled positions
    settleInterpRef.current = {
      to: payload.balls.map((b) => ({ ...b })),
      startTime: performance.now(),
    };
  } else {
    // SHOOTING — seed local physics with remote velocities & spin for s-w-e-r-v-e
    const remoteBalls = payload.balls.map((b) => {
      if (b.number === 0 && (payload.spinX !== undefined || payload.spinY !== undefined)) {
        return { ...b, spinX: payload.spinX ?? 0, spinY: payload.spinY ?? 0 };
      }
      return b;
    });
    ballsRef.current = remoteBalls;
    setBalls(remoteBalls);
  }
}
      if (typeof payload.turn === "number") {
  turnRef.current = payload.turn;
  setTurn(payload.turn);
}
      const shouldSwapTeams = payload.sourceSeat !== ownerRef.current;
      if ("myTeam" in payload || "oppTeam" in payload) {
        setMyTeam(shouldSwapTeams ? (payload.oppTeam ?? null) : (payload.myTeam ?? null));
        setOppTeam(shouldSwapTeams ? (payload.myTeam ?? null) : (payload.oppTeam ?? null));
      }
      if (typeof payload.openTable === "boolean") setOpenTable(payload.openTable);
      if (typeof payload.ballInHand === "boolean") setBallInHand(payload.ballInHand);
      if ("winner" in payload) setWinner(payload.winner ?? null);
      // Show opponent's aim visor — keep showing for 8 seconds so it's visible
      // during the entire aiming+shooting sequence, not just brief mouse movements
      if (typeof payload.aim === "number") {
        setRemoteAim({
          angle: payload.aim,
          pull: payload.pull ?? 0,
          seat: payload.sourceSeat,
          at: Date.now(),
          spinX: payload.spinX,
          spinY: payload.spinY,
        });
        // Start/refresh the 8-second timer for showing remote aim
        setShowRemoteAim(true);
        setShowOpponentVisor(true);
        if (opponentVisorTimerRef.current) clearTimeout(opponentVisorTimerRef.current);
        opponentVisorTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setShowOpponentVisor(false);
        }, 8000);
        if (remoteAimTimerRef.current) clearTimeout(remoteAimTimerRef.current);
        remoteAimTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setShowRemoteAim(false);
        }, 8000);
        // When opponent is aiming, also clear any stale SETTLED interpolation
        // so balls stay in place while they line up their shot
        if (isAimingEvent && settleInterpRef.current) {
          settleInterpRef.current = null;
        }
      }
      if (payload.settled || payload.lifecycle === "SETTLED") {
        shotLock.current = false;
        localShotInProgressRef.current = false;
        remoteShotInProgressRef.current = false;
        lifecycleRef.current = "IDLE";
        activeShotIdRef.current = null;
        remoteShotMetaInitializedRef.current = false;
        syncVersionRef.current = Math.max(syncVersionRef.current, payload.version);
        setSyncVersion((current) => Math.max(current, payload.version));
        setLastFoul(payload.foul ? (payload.foulMessage ?? "Foul. Ball in hand.") : null);
        if (payload.foulMessage) setStatus(payload.foulMessage);
        else setStatus("Shot complete.");
        // Opponent win notification
        if (payload.winner && payload.winner !== ownerRef.current) {
          setNotifications((prev) => {
            const alreadyExists = prev.some(
              (n) => n.type === "win" && n.message.includes("wins"),
            );
            if (alreadyExists) return prev;
            return [
              ...prev,
              {
                id: notificationIdRef.current++,
                message: `${oppNameRef.current} wins!`,
                type: "win" as const,
              },
            ];
          });
        }

        // ── Push remote shot history entry ──
        if (payload.shotId && !processedShotIdsRef.current.has(payload.shotId)) {
          processedShotIdsRef.current.add(payload.shotId);
          turnNumberRef.current += 1;
          const remotePlayerName = payload.sourceSeat === ownerRef.current ? myNameRef.current : oppNameRef.current;
          setShotHistory((prev) => [
            {
              turnNumber: turnNumberRef.current,
              playerName: remotePlayerName,
              seat: payload.sourceSeat,
              pocketedNumbers: payload.pocketedNumbers ?? [],
              foul: payload.foul ?? false,
              foulMessage: payload.foulMessage ?? null,
              ballInHand: payload.ballInHand ?? false,
              winner: !!payload.winner,
              timestamp: Date.now(),
            },
            ...prev,
          ]);
        }
      }
    };

    const handleResigned = (message: any) => {
      const payload = "payload" in message && message.payload ? message.payload : message;
      if (!payload || payload.matchId !== activeMatchId) return;
      if (payload.resignedUserId === userIdRef.current) return;
      // Opponent resigned — we win
      setWinner(ownerRef.current);
      setStatus("Opponent resigned. You win!");
      // Clean up shot state so the win/loss popup shows immediately
      shotLock.current = false;
      localShotInProgressRef.current = false;
      remoteShotInProgressRef.current = false;
      settleInterpRef.current = null;
    };

    socket.emit("join_room", { roomId });
    socket.on("pool:live-state", handleLiveState);
    socket.on("pool:resigned", handleResigned);

    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("pool:live-state", handleLiveState);
      socket.off("pool:resigned", handleResigned);
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
    setShowOpponentVisor(true);
    if (opponentVisorTimerRef.current) clearTimeout(opponentVisorTimerRef.current);
    opponentVisorTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setShowOpponentVisor(false);
    }, 1200);

    const timer = setTimeout(() => {
      fireShot(shot.angle, shot.power);
      setPull(0);
      aiShotLock.current = false;
      setShowOpponentVisor(false);
    }, 1200);

    return () => clearTimeout(timer);
  }, [aiMode, turn, canShoot, winner, oppTeam, openTable]);

  const syncMatch = async () => {
    // Skip polling when the local player just fired a shot — prevents stale DB
    // state from reverting local changes before pushPoolState completes
    if (pendingActionRef.current) return;
    try {
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
          return;
        }
      }
      // Handle match finished (e.g. opponent resigned)
      if (data.match?.status === "finished" && !winner) {
        const finishedWinner = gs?.winner;
        if (finishedWinner) {
          shotLock.current = false;
          localShotInProgressRef.current = false;
          remoteShotInProgressRef.current = false;
          settleInterpRef.current = null;
          setWinner(finishedWinner);
          setStatus(
            finishedWinner === ownerRef.current
              ? "Opponent resigned. You win!"
              : "You resigned.",
          );
        }
      }
      if (data.viewerSeat && ownerRef.current === 1) {
        setOwner(data.viewerSeat);
      }
      if (data.viewerName) setMyName(data.viewerName);
      if (data.opponentName) setOppName(data.opponentName);
      // Capture opponent's clerkId for reporting
      if (data.match?.player1Id && data.match?.player2Id) {
        const oppId = data.viewerSeat === 1 ? data.match.player2Id : data.match.player1Id;
        if (oppId) setOpponentClerkId(oppId);
      }

      // Use refs for the most current values — avoids stale closure issues
      const localShotInProgress = localShotInProgressRef.current || remoteShotInProgressRef.current;
      const currentVersion = syncVersionRef.current;

      if (
        !localShotInProgress &&
        gs?.version &&
        isNewerVersion(gs.version, currentVersion)
      ) {
        // Update both state and ref atomically
        syncVersionRef.current = Math.max(currentVersion, gs.version);
        setSyncVersion(gs.version);
        lastPolledVersionRef.current = gs.version;

        if (gs.balls) {
          // If the remote player is rolling (gs.lifecycle === "ROLLING" or "SHOOTING"),
          // seed local physics so balls move smoothly on the opponent's screen
          const isRemoteRolling = gs.lifecycle === "ROLLING" || gs.lifecycle === "SHOOTING";
          if (isRemoteRolling && !gs.settled && !remoteShotInProgressRef.current && !localShotInProgressRef.current) {
            // We missed the SHOOTING socket event — seed physics from polling data
            remoteShotInProgressRef.current = true;
            shotLock.current = true;
            lifecycleRef.current = gs.lifecycle ?? "ROLLING";
            settleInterpRef.current = null;
            if (!remoteShotMetaInitializedRef.current) {
              shotMeta.current = {
                firstContactNumber: null,
                railAfterContact: false,
                pocketedNumbers: [],
                cueScratch: false,
              };
              remoteShotMetaInitializedRef.current = true;
            }
            ballsRef.current = gs.balls.map((b: Ball) => ({ ...b }));
            setBalls(gs.balls.map((b: Ball) => ({ ...b })));
          } else if (!isRemoteRolling || gs.settled) {
            // Settled state — smooth interpolation
            settleInterpRef.current = {
              to: gs.balls.map((b: Ball) => ({ ...b })),
              startTime: performance.now(),
            };
          }
        }
        if (gs.turn) { turnRef.current = gs.turn; setTurn(gs.turn); }
        const remoteSeat = gs.perspectiveSeat;
        const shouldSwapTeams = remoteSeat && data.viewerSeat && remoteSeat !== data.viewerSeat;
        setMyTeam(shouldSwapTeams ? (gs.oppTeam ?? null) : (gs.myTeam ?? null));
        setOppTeam(shouldSwapTeams ? (gs.myTeam ?? null) : (gs.oppTeam ?? null));
        setOpenTable(gs.openTable ?? true);
        setBallInHand(gs.ballInHand ?? false);
        setWinner(gs.winner ?? null);
        setLastFoul(gs.foul ? (gs.foulMessage ?? "Foul. Ball in hand.") : null);
        if (gs.foulMessage) setStatus(gs.foulMessage);

        // If the remote settled, clean up remote shot flags
        if (gs.settled || gs.lifecycle === "SETTLED") {
          shotLock.current = false;
          remoteShotInProgressRef.current = false;
          localShotInProgressRef.current = false;
          lifecycleRef.current = "IDLE";
          activeShotIdRef.current = null;
          remoteShotMetaInitializedRef.current = false;
        }

        // ── Push polling shot history entry for remote settled shots ──
        const pollingSourceSeat = gs.perspectiveSeat;
        const shotIdKey = gs.shotId;
        if (pollingSourceSeat && pollingSourceSeat !== ownerRef.current) {
          // Use shotId for dedup when available, fall back to timestamp matching
          const alreadyLogged = (shotIdKey && processedShotIdsRef.current.has(shotIdKey)) ||
            (() => {
              const history = shotHistoryRef.current;
              return history.some(
                (e) =>
                  (e.playerName === (pollingSourceSeat === ownerRef.current ? myNameRef.current : oppNameRef.current) &&
                   Math.abs(e.timestamp - Date.now()) < 5000),
              );
            })();
          if (!alreadyLogged) {
            if (shotIdKey) processedShotIdsRef.current.add(shotIdKey);
            turnNumberRef.current += 1;
            const pollTurn = turnNumberRef.current;
            const pollingPlayerName = pollingSourceSeat === ownerRef.current ? myNameRef.current : oppNameRef.current;
            setShotHistory((prev) => [
              {
                turnNumber: pollTurn,
                playerName: pollingPlayerName,
                seat: pollingSourceSeat,
                pocketedNumbers: gs.pocketedNumbers ?? [],
                foul: gs.foul ?? false,
                foulMessage: gs.foulMessage ?? null,
                ballInHand: gs.ballInHand ?? false,
                winner: !!gs.winner,
                timestamp: Date.now(),
              },
              ...prev,
            ]);
          }
        }
      }
    } catch (err) {
      // Network errors are transient — next interval will retry
      if (process.env.NODE_ENV !== "production") {
        console.warn("[pool] polling error:", err);
      }
    }
  };

  useEffect(() => {
    if (aiMode) {
      if (syncVersionRef.current === 0) void syncMatch();
      return;
    }

    void syncMatch();
    pollIntervalRef.current = setInterval(syncMatch, 1000);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
    // router is intentionally omitted — useRouter() returns a stable reference in Next.js
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMatchId, aiMode]);
  const myRemaining = BALL_LAYOUT.filter((b) =>
    myTeam ? (myTeam === "solids" ? !b.s && b.n !== 8 : b.s) : b.n !== 8
  )
    .filter((b) => !balls.find((bb) => bb.number === b.n)?.pocketed)
    .map((b) => b.n);
  const oppRemaining = BALL_LAYOUT.filter((b) =>
    oppTeam ? (oppTeam === "solids" ? !b.s && b.n !== 8 : b.s) : b.n !== 8
  )
    .filter((b) => !balls.find((bb) => bb.number === b.n)?.pocketed)
    .map((b) => b.n);

  return (
    <div className="min-h-screen overflow-x-clip bg-[#202124] bg-[radial-gradient(circle_at_center,#353535_0,#1f1f1f_55%,#101010_100%)] p-2 text-white sm:p-4">
      <NavigationBar currentPath="/casino" />

      {/* ── Shot notification toasts ── */}
      <div className="pointer-events-none fixed left-1/2 top-20 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
        {notifications.map((n) => (
          <div
            key={n.id}
            className={`animate-slide-down rounded-full px-5 py-2 text-sm font-bold shadow-2xl backdrop-blur-md ${
              n.type === "pocket"
                ? "bg-emerald-600/90 text-white"
                : n.type === "foul"
                  ? "bg-red-600/90 text-white"
                  : "bg-yellow-500/90 text-black"
            }`}
          >
            {n.message}
          </div>
        ))}
      </div>

      <div className="mx-auto mt-3 max-w-7xl rounded-2xl border border-black/70 bg-black/45 p-3 shadow-[0_20px_70px_rgba(0,0,0,.65)] sm:mt-6 sm:p-4">
        <div className="mb-2 text-center text-lg font-black text-yellow-300 drop-shadow sm:text-2xl">
          {started
  ? turn === owner
    ? "Your turn."
    : `${oppName} is shooting...`
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
            <p className="mt-1 text-sm">Balls: {myRemaining.join(", ") || "none"}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-[#1f1f1f]/90 p-3 text-right shadow-inner">
            <p className="font-bold">{oppName}</p>
            <p className="text-xs text-cyan-100">{oppTeam ?? "unassigned"}</p>
            <p className="mt-1 text-sm">Balls: {oppRemaining.join(", ") || "none"}</p>
          </div>
        </div>
        {/* ── Resign button ── */}
        {started && !winner && (
          <div className="mt-3 flex flex-col items-center gap-2">
            <div className="flex justify-center">
              {!showResignConfirm ? (
                <button
                  onClick={() => setShowResignConfirm(true)}
                  disabled={resigning}
                  className="rounded-lg border border-red-500/40 bg-red-900/30 px-5 py-1.5 text-sm font-semibold text-red-300 transition-all hover:bg-red-900/50 hover:text-red-200"
                >
                  {resigning ? "Resigning..." : "🏳️ Resign"}
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleResign}
                    disabled={resigning}
                    className="rounded-lg bg-red-700 px-5 py-1.5 text-sm font-bold text-white transition-all hover:bg-red-600 disabled:opacity-60"
                  >
                    {resigning ? "Resigning..." : "Confirm Resign"}
                  </button>
                  <button
                    onClick={() => setShowResignConfirm(false)}
                    disabled={resigning}
                    className="rounded-lg border border-white/20 bg-white/10 px-4 py-1.5 text-sm font-semibold text-white/70 transition-all hover:bg-white/20"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
            {!aiMode && (
              <button
                onClick={() => setShowReportModal(true)}
                className="text-xs text-slate-500 hover:text-red-400 transition underline underline-offset-4"
              >
                🚩 Report Player
              </button>
            )}
          </div>
        )}

        {/* ── Win / Loss popup modal ── */}
        <AnimatePresence>
        {showWinLossPopup && gameOverMessage && (
          <motion.div
            key="pool-end-popup"
            {...gameOverModal.backdrop}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          >
            <motion.div
              {...gameOverModal.panel}
              className={`relative mx-4 w-full max-w-sm rounded-2xl border p-8 shadow-2xl ${
                gameOverMessage.won
                  ? "border-yellow-400/40 bg-gradient-to-b from-[#1a2e1a] to-[#0d1a0d] shadow-[0_0_40px_rgba(250,204,21,0.3)]"
                  : "border-white/20 bg-[#1a1a2e]"
              }`}
            >
              {/* Confetti / decorative glow */}
              <div
                className={`absolute inset-0 rounded-2xl opacity-20 blur-xl ${
                  gameOverMessage.won
                    ? "bg-gradient-to-br from-yellow-400 via-amber-500 to-orange-600"
                    : "bg-gradient-to-br from-red-400 via-rose-500 to-pink-600"
                }`}
              />

              <div className="relative flex flex-col items-center gap-4">
                {/* Icon */}
                <motion.div
                  initial={{ scale: 0, rotate: -30 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 300, damping: 12, delay: 0.3 }}
                  className="text-6xl"
                >
                  {gameOverMessage.won ? "🏆" : "😞"}
                </motion.div>

                {/* Title */}
                <motion.h2
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.5, duration: 0.4 }}
                  className={`text-3xl font-black ${
                    gameOverMessage.won
                      ? "bg-gradient-to-r from-yellow-300 to-amber-400 bg-clip-text text-transparent"
                      : "bg-gradient-to-r from-red-300 to-rose-400 bg-clip-text text-transparent"
                  }`}
                >
                  {gameOverMessage.won ? "You Win!" : "You Lose"}
                </motion.h2>

                {/* Subtitle */}
                <motion.p
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.6, duration: 0.4 }}
                  className="text-center text-sm text-white/60"
                >
                  {gameOverMessage.won
                    ? "Congratulations! You won the match."
                    : `${oppName} won the match. Better luck next time!`}
                </motion.p>

                {/* Buttons */}
                <motion.div
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.7, duration: 0.4 }}
                  className="mt-2 flex w-full flex-col gap-2"
                >
                  <button
                    onClick={handleReturnToLobby}
                    className="w-full rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 px-6 py-3 font-bold text-white shadow-lg transition-all hover:scale-105 hover:from-indigo-500 hover:to-purple-500"
                  >
                    Return to Lobby
                  </button>
                  <button
                    onClick={handleRematch}
                    disabled={rematching}
                    className="w-full rounded-xl border border-white/20 bg-white/5 px-6 py-2.5 text-sm font-semibold text-white/70 transition-all hover:bg-white/10 disabled:opacity-40"
                  >
                    {rematching ? "Creating..." : aiMode ? "Play Again" : "Find New Match"}
                  </button>
                </motion.div>
              </div>
            </motion.div>
          </motion.div>
        )}
        </AnimatePresence>

        {/* ── Shot history toggle & panel ── */}
        <div className="mt-3">
          <button
            onClick={() => setShowHistory((p) => !p)}
            className="flex w-full items-center justify-between rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white/70 transition-colors hover:bg-white/10"
          >
            <span>📋 Shot History ({shotHistory.length})</span>
            <span className="text-xs">{showHistory ? "▲ Hide" : "▼ Show"}</span>
          </button>
          {showHistory && (
            <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-white/10 bg-black/40 p-3 text-xs backdrop-blur-sm">
              {shotHistory.length === 0 ? (
                <p className="text-center text-white/30 italic">No shots yet.</p>
              ) : (
                <div className="flex flex-col-reverse gap-2">
                  {shotHistory.map((entry, i) => {
                    const pocketedStr =
                      entry.pocketedNumbers.length > 0
                        ? ` pocketed [${entry.pocketedNumbers.join(", ")}]`
                        : "";
                    const foulStr = entry.foul
                      ? ` — FOUL${entry.foulMessage ? `: ${entry.foulMessage.replace(/^Foul: /, "")}` : ""}` + (entry.ballInHand ? ", ball in hand" : "")
                      : "";
                    const winStr = entry.winner ? " 🏆" : "";
                    return (
                      <div
                        key={i}
                        className={`rounded-md px-3 py-2 leading-relaxed ${
                          entry.foul
                            ? "border border-red-500/20 bg-red-900/25"
                            : "border border-white/5 bg-white/5"
                        }`}
                      >
                        <span className="font-bold text-white/80">
                          #{entry.turnNumber}{" "}
                        </span>
                        <span
                          className={`font-semibold ${entry.seat === owner ? "text-cyan-300" : "text-orange-300"}`}
                        >
                          {entry.playerName}
                        </span>
                        {pocketedStr && (
                          <span className="text-emerald-300">{pocketedStr}</span>
                        )}
                        {foulStr && (
                          <span className="text-red-300">{foulStr}</span>
                        )}
                        {winStr && (
                          <span className="text-yellow-300">{winStr}</span>
                        )}
                        {!pocketedStr && !foulStr && !winStr && (
                          <span className="text-white/40"> missed</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="relative mt-4">
          {/* ── Shot power meter ── */}
          {canShoot && pull > 0 && (
            <div className="absolute right-3 top-1/2 z-10 flex -translate-y-1/2 flex-col items-center gap-1">
              <div className="h-40 w-4 overflow-hidden rounded-full border border-white/20 bg-black/50">
                <div
                  className="w-full transition-all duration-75"
                  style={{
                    height: `${Math.min(100, (pull / MAX_PULL) * 100)}%`,
                    marginTop: `${100 - Math.min(100, (pull / MAX_PULL) * 100)}%`,
                    background:
                      pull / MAX_PULL < 0.33
                        ? "linear-gradient(to top, #22c55e, #4ade80)"
                        : pull / MAX_PULL < 0.66
                          ? "linear-gradient(to top, #eab308, #facc15)"
                          : "linear-gradient(to top, #ef4444, #f87171)",
                    borderRadius: "9999px",
                  }}
                />
              </div>
              <span className="text-xs font-bold text-white/80">
                {Math.round((pull / MAX_PULL) * 100)}%
              </span>
            </div>
          )}

          {/* ── Spin control ── */}
          {canShoot && turn === owner && (
            <div
              className="absolute bottom-3 left-3 z-10 select-none rounded-full border-2 border-white/30 bg-black/55 p-1 shadow-lg backdrop-blur-sm"
              onMouseDown={(e) => {
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const r = rect.width / 2 - 4;
                const sx = Math.max(-1, Math.min(1, (e.clientX - cx) / r));
                const sy = Math.max(-1, Math.min(1, (e.clientY - cy) / r));
                setSpin({ x: sx, y: -sy }); // negate y: down = draw = negative
              }}
              onMouseMove={(e) => {
                if (e.buttons !== 1) return;
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const r = rect.width / 2 - 4;
                const sx = Math.max(-1, Math.min(1, (e.clientX - cx) / r));
                const sy = Math.max(-1, Math.min(1, (e.clientY - cy) / r));
                setSpin({ x: sx, y: -sy });
              }}
              onTouchStart={(e) => {
                e.stopPropagation();
                const t = e.touches[0];
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const r = rect.width / 2 - 4;
                const sx = Math.max(-1, Math.min(1, (t.clientX - cx) / r));
                const sy = Math.max(-1, Math.min(1, (t.clientY - cy) / r));
                setSpin({ x: sx, y: -sy });
              }}
              onTouchMove={(e) => {
                e.stopPropagation();
                const t = e.touches[0];
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const r = rect.width / 2 - 4;
                const sx = Math.max(-1, Math.min(1, (t.clientX - cx) / r));
                const sy = Math.max(-1, Math.min(1, (t.clientY - cy) / r));
                setSpin({ x: sx, y: -sy });
              }}
            >
              {/* Outer circle with tick marks */}
              <svg width={52} height={52} viewBox="0 0 52 52">
                <circle cx={26} cy={26} r={24} fill="#1a472a" stroke="rgba(255,255,255,0.2)" strokeWidth={1} />
                {/* Crosshair lines */}
                <line x1={26} y1={4} x2={26} y2={48} stroke="rgba(255,255,255,0.15)" strokeWidth={0.5} />
                <line x1={4} y1={26} x2={48} y2={26} stroke="rgba(255,255,255,0.15)" strokeWidth={0.5} />
                {/* Labels */}
                <text x={26} y={10} textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize={5} fontFamily="Arial">
                  FOLLOW
                </text>
                <text x={26} y={49} textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize={5} fontFamily="Arial">
                  DRAW
                </text>
                <text x={7} y={27.5} textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize={5} fontFamily="Arial">
                  L
                </text>
                <text x={44} y={27.5} textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize={5} fontFamily="Arial">
                  R
                </text>
                {/* Spin dot */}
                <circle
                  cx={26 + spin.x * 20}
                  cy={26 - spin.y * 20}
                  r={5}
                  fill="#f5f5f5"
                  stroke="rgba(0,0,0,0.6)"
                  strokeWidth={1}
                />
                {/* Center dot */}
                <circle cx={26} cy={26} r={1.5} fill="rgba(255,255,255,0.2)" />
              </svg>
            </div>
          )}

          {/* ── Opponent aim visor ── */}
          {showOpponentVisor && turn !== owner && (
            <div className="absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-gradient-to-b from-black/60 via-transparent to-black/60 pointer-events-none">
              <div className="absolute top-6 left-1/2 -translate-x-1/2 animate-pulse rounded-full border border-yellow-400/40 bg-yellow-500/10 px-6 py-2 backdrop-blur-md">
                <span className="text-sm font-bold text-yellow-300 drop-shadow-lg">
                  🎯 {oppName} is aiming...
                </span>
              </div>
              {/* Crosshair corners */}
              <div className="absolute top-8 left-8 h-8 w-8 border-t-2 border-l-2 border-yellow-400/30 rounded-tl" />
              <div className="absolute top-8 right-8 h-8 w-8 border-t-2 border-r-2 border-yellow-400/30 rounded-tr" />
              <div className="absolute bottom-8 left-8 h-8 w-8 border-b-2 border-l-2 border-yellow-400/30 rounded-bl" />
              <div className="absolute bottom-8 right-8 h-8 w-8 border-b-2 border-r-2 border-yellow-400/30 rounded-br" />
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
              className={`w-full touch-none rounded-2xl border border-black bg-[#111]
shadow-[0_12px_40px_rgba(0,0,0,.75)]
${!canShoot ? "pointer-events-none" : ""}`}
            />
        </div>
      </div>
      {/* Report Modal */}
      <ReportModal
        isOpen={showReportModal}
        onClose={() => setShowReportModal(false)}
        onSubmit={async (reason, details) => {
          const res = await fetch("/api/reports/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reportedClerkId: opponentClerkId,
              gameType: "pool-masters",
              gameId: String(matchId),
              reason,
              details: details || undefined,
            }),
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error || "Failed to submit report");
        }}
        reportedPlayerName={oppName}
        gameType="Pool Masters"
      />
    </div>
  );
}
