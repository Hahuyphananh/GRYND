"use client";
import { useAuth } from "@clerk/nextjs";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const handledShotRef=useRef<string|null>(null);
  const socketBoundRef=useRef(false);
  const canvasRef=useRef<HTMLCanvasElement|null>(null);
  const pockets = useMemo(()=>[[34,34],[W/2,28],[W-34,34],[34,H-34],[W/2,H-28],[W-34,H-34]],[]);

  useEffect(()=>{(async()=>{
    const token = await getToken();
    if (!token) return;
    const socket = await createSocketConnection(token);
    if (!socket || socketBoundRef.current) return;
    socketBoundRef.current = true;
    socket.emit("pool:room:join", { matchId, userId });

    const onStart=(m:any)=>{ if(m?.id!==matchId) return; setGameStarted(Boolean(m.gameStarted)); setCurrentTurn(m.turnUserId||null); setStatus("Match started"); };
    const onTurn=({matchId:mid,turnUserId}:any)=>{ if(mid!==matchId) return; setCurrentTurn(turnUserId||null); setShotLock(false); };
    const onShot=({matchId:mid,shotId}:any)=>{ if(mid!==matchId) return; handledShotRef.current=shotId; setShotLock(true); };

    socket.on("pool:match:start", onStart);
    socket.on("pool:turn:start", onTurn);
    socket.on("pool:shoot", onShot);

    return ()=>{
      socket.off("pool:match:start", onStart);
      socket.off("pool:turn:start", onTurn);
      socket.off("pool:shoot", onShot);
      socketBoundRef.current=false;
    };
  })();},[getToken,matchId,userId]);

  const shoot=()=>{
    if(!gameStarted || !currentTurn || currentTurn!==userId || shotLock) return;
    const socket=getSocket(); if(!socket) return;
    const shotId=`${matchId}:${userId}:${Date.now()}`;
    socket.emit("pool:shoot", { matchId, userId, shotId, angle:0, power:0.5, cueBallPosition:{x:balls[0].x,y:balls[0].y} });
    if (aiMode) {
      setTimeout(()=> socket.emit("pool:physics:end", { matchId, shotId, nextTurnUserId:userId, snapshot:{}, eventSummary:{ai:true} }), 800);
    }
  };

  useEffect(()=>{
    const c=canvasRef.current; if(!c) return; const x=c.getContext("2d"); if(!x) return;
    x.clearRect(0,0,W,H); x.fillStyle="#0e2f22"; x.fillRect(40,40,W-80,H-80);
    pockets.forEach(([px,py])=>{x.beginPath();x.arc(px,py,24,0,Math.PI*2);x.fillStyle="#000";x.fill();});
    balls.forEach(b=>{x.beginPath();x.arc(b.x,b.y,R,0,Math.PI*2);x.fillStyle=b.color;x.fill();});
  },[balls,pockets]);

  return <div className="min-h-screen bg-[#09121a] p-4 text-white"><NavigationBar currentPath="/casino" /><div className="mx-auto mt-6 max-w-6xl rounded-xl border border-cyan-500/40 bg-black/30 p-4"><h1 className="text-3xl font-black text-fuchsia-300">Pool Match</h1><p>{status}</p><p>Current turn: {currentTurn ?? "(pending server)"}</p><p>You: {userId ?? "unknown"}</p><button onClick={shoot} className="mt-3 rounded bg-fuchsia-600 px-4 py-2">Shoot</button><canvas ref={canvasRef} width={W} height={H} className="mt-4 rounded-xl border border-emerald-600" /></div></div>;
}
