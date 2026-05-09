"use client";
import { useAuth } from "@clerk/nextjs";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useParams, useSearchParams } from "next/navigation";
import NavigationBar from "../../../../../components/navigation-bar";
import { createSocketConnection, getSocket } from "../../../../../lib/socket";

type Ball = { id:number;x:number;y:number;vx:number;vy:number;color:string;pocketed?:boolean;striped?:boolean;number?:number };
const R=11,W=900,H=500;
function setupBalls(): Ball[] { return [{id:0,number:0,x:180,y:250,vx:0,vy:0,color:'#fff'}]; }

export default function PoolGamePage(){
  const { getToken, userId } = useAuth();
  const { matchId } = useParams<{matchId:string}>();
  const aiMode = useSearchParams().get("ai")==="1";
  const [balls] = useState<Ball[]>(setupBalls());
  const [gameStarted,setGameStarted]=useState(false);
  const [currentTurn,setCurrentTurn]=useState<string|null>(null);
  const [status,setStatus]=useState("Waiting for server gameStarted event...");
  const [shotLock,setShotLock]=useState(false);
  const [aiming,setAiming]=useState(false);
  const [aimLine,setAimLine]=useState<{x:number;y:number;power:number}|null>(null);
  const dragStartRef=useRef<{x:number;y:number}|null>(null);
  const socketBoundRef=useRef(false);
  const canvasRef=useRef<HTMLCanvasElement|null>(null);
  const pockets = useMemo(()=>[[34,34],[W/2,28],[W-34,34],[34,H-34],[W/2,H-28],[W-34,H-34]],[]);

  const matchIds = useMemo(() => new Set([String(matchId), `pool-${String(matchId)}`]), [matchId]);
  const canonicalMatchId = String(matchId).startsWith("pool-") ? String(matchId) : `pool-${String(matchId)}`;

  useEffect(()=>{(async()=>{
    const token = await getToken();
    if (!token) return;
    const socket = await createSocketConnection(token);
    if (!socket || socketBoundRef.current) return;
    socketBoundRef.current = true;
    socket.emit("pool:room:join", { matchId: String(matchId), userId });
    socket.emit("pool:room:join", { matchId: canonicalMatchId, userId });

    const onStart=(m:any)=>{ if(!m?.id || !matchIds.has(String(m.id))) return; setGameStarted(Boolean(m.gameStarted)); setCurrentTurn(m.turnUserId||null); setStatus("Match started"); };
    const onTurn=({matchId:mid,turnUserId}:any)=>{ if(!matchIds.has(String(mid))) return; setCurrentTurn(turnUserId||null); setShotLock(false); };
    const onShot=({matchId:mid}:any)=>{ if(!matchIds.has(String(mid))) return; setShotLock(true); };

    socket.on("pool:match:start", onStart);
    socket.on("pool:turn:start", onTurn);
    socket.on("pool:shoot", onShot);
  })();},[canonicalMatchId,getToken,matchId,matchIds,userId]);

  const shoot=(angle:number,power:number)=>{
    if(!gameStarted || !currentTurn || currentTurn!==userId || shotLock) return;
    const socket=getSocket(); if(!socket) return;
    const shotId=`${matchId}:${userId}:${Date.now()}`;
    socket.emit("pool:shoot", { matchId: canonicalMatchId, userId, shotId, angle, power, cueBallPosition:{x:balls[0].x,y:balls[0].y} });
    setAiming(false); setAimLine(null);
    if (aiMode) setTimeout(()=> socket.emit("pool:physics:end", { matchId: canonicalMatchId, shotId, nextTurnUserId:userId, snapshot:{}, eventSummary:{ai:true} }), 800);
  };

  const toCanvasPoint = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current; if (!c) return null;
    const rect = c.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!gameStarted || !currentTurn || currentTurn !== userId || shotLock) return;
    const p = toCanvasPoint(e); if (!p) return; dragStartRef.current = p; setAiming(true);
  };
  const onPointerMove = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!aiming || !dragStartRef.current) return;
    const p = toCanvasPoint(e); if (!p) return;
    const dx = dragStartRef.current.x - p.x; const dy = dragStartRef.current.y - p.y;
    setAimLine({ x: p.x, y: p.y, power: Math.min(1, Math.hypot(dx, dy) / 180) });
  };
  const onPointerUp = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!aiming || !dragStartRef.current) return;
    const p = toCanvasPoint(e); if (!p) return;
    const dx = dragStartRef.current.x - p.x; const dy = dragStartRef.current.y - p.y;
    const power = Math.min(1, Math.hypot(dx, dy) / 180);
    if (power > 0.05) shoot(Math.atan2(dy, dx), power);
    setAiming(false); setAimLine(null); dragStartRef.current = null;
  };

  useEffect(()=>{
    const c=canvasRef.current; if(!c) return; const x=c.getContext("2d"); if(!x) return;
    x.clearRect(0,0,W,H); x.fillStyle="#0e2f22"; x.fillRect(40,40,W-80,H-80);
    pockets.forEach(([px,py])=>{x.beginPath();x.arc(px,py,24,0,Math.PI*2);x.fillStyle="#000";x.fill();});
    balls.forEach(b=>{x.beginPath();x.arc(b.x,b.y,R,0,Math.PI*2);x.fillStyle=b.color;x.fill();});
    if (aiming && aimLine) { const cue = balls[0]; x.beginPath(); x.moveTo(cue.x, cue.y); x.lineTo(aimLine.x, aimLine.y); x.strokeStyle = "rgba(255,255,255,0.7)"; x.lineWidth = 2 + aimLine.power * 4; x.stroke(); }
  },[balls,pockets,aiming,aimLine]);

  return <div className="min-h-screen bg-[#09121a] p-4 text-white"><NavigationBar currentPath="/casino" /><div className="mx-auto mt-6 max-w-6xl rounded-xl border border-cyan-500/40 bg-black/30 p-4"><h1 className="text-3xl font-black text-fuchsia-300">Pool Match</h1><p>{status}</p><p>Current turn: {currentTurn ?? "(pending server)"}</p><p>You: {userId ?? "unknown"}</p><p className="mt-2 text-sm text-cyan-200">Drag on table to aim and set power, then release to shoot.</p><canvas onMouseDown={onPointerDown} onMouseMove={onPointerMove} onMouseUp={onPointerUp} ref={canvasRef} width={W} height={H} className="mt-4 rounded-xl border border-emerald-600" /></div></div>;
}
