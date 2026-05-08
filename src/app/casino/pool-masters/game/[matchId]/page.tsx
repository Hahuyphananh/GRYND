"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import NavigationBar from "../../../../../components/navigation-bar";

type Team = "solids" | "stripes" | null;
type Ball = { id:number; x:number; y:number; vx:number; vy:number; color:string; striped?:boolean; pocketed?:boolean; number?:number; };
const R = 11; const W = 900; const H = 500; const FRICTION = 0.992;
const BALLS = [
  { n:1,c:"#facc15",s:false },{ n:2,c:"#2563eb",s:false },{ n:3,c:"#dc2626",s:false },{ n:4,c:"#7c3aed",s:false },{ n:5,c:"#f97316",s:false },{ n:6,c:"#16a34a",s:false },{ n:7,c:"#a16207",s:false },{ n:8,c:"#111827",s:false },
  { n:9,c:"#facc15",s:true },{ n:10,c:"#2563eb",s:true },{ n:11,c:"#dc2626",s:true },{ n:12,c:"#7c3aed",s:true },{ n:13,c:"#f97316",s:true },{ n:14,c:"#16a34a",s:true },{ n:15,c:"#a16207",s:true },
];
function setupBalls(): Ball[] { const balls=[{id:0,number:0,x:180,y:250,vx:0,vy:0,color:"#fff"} as Ball]; let k=1; for(let row=0;row<5;row++) for(let col=0;col<=row;col++){ const d=BALLS[k-1]; balls.push({id:k,number:d.n,x:620+row*19,y:250-row*11+col*22,vx:0,vy:0,color:d.c,striped:d.s});k++;} return balls; }
const moving=(balls:Ball[])=>balls.some((b)=>Math.abs(b.vx)+Math.abs(b.vy)>0.03);
export default function PoolGamePage(){
  const { matchId } = useParams<{matchId:string}>(); const aiMode = useSearchParams().get("ai")==="1";
  const canvasRef=useRef<HTMLCanvasElement|null>(null); const dragRef=useRef<{x:number;y:number}|null>(null);
  const [balls,setBalls]=useState<Ball[]>(setupBalls()); const [status,setStatus]=useState("Waiting..."); const [started,setStarted]=useState(aiMode);
  const [myTeam,setMyTeam]=useState<Team>(null); const [oppTeam,setOppTeam]=useState<Team>(null); const [turn,setTurn]=useState<1|2>(1); const [owner,setOwner]=useState<1|2>(1);
  const [pull,setPull]=useState(0); const [aim,setAim]=useState(0); const [syncVersion,setSyncVersion]=useState(0);
  const pockets = useMemo(()=>[[34,34],[W/2,28],[W-34,34],[34,H-34],[W/2,H-28],[W-34,H-34]],[]);

  const physics=(next:Ball[])=>{ for(const b of next){ if(b.pocketed) continue; b.x+=b.vx; b.y+=b.vy; b.vx*=FRICTION; b.vy*=FRICTION; if(Math.abs(b.vx)<0.02)b.vx=0; if(Math.abs(b.vy)<0.02)b.vy=0; if(b.x<52||b.x>W-52){b.x=Math.max(52,Math.min(W-52,b.x));b.vx*=-0.93;} if(b.y<52||b.y>H-52){b.y=Math.max(52,Math.min(H-52,b.y));b.vy*=-0.93;} for(const [px,py] of pockets){ if((b.x-px)**2+(b.y-py)**2<24**2){b.pocketed=true;b.vx=0;b.vy=0;} } }
    for(let i=0;i<next.length;i++)for(let j=i+1;j<next.length;j++){const a=next[i],b=next[j]; if(a.pocketed||b.pocketed)continue; const dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy); if(d>0&&d<R*2){const nx=dx/d,ny=dy/d; const overlap=R*2-d; a.x-=nx*overlap/2; a.y-=ny*overlap/2; b.x+=nx*overlap/2; b.y+=ny*overlap/2; const p=2*((a.vx-b.vx)*nx+(a.vy-b.vy)*ny)/2; a.vx-=p*nx; a.vy-=p*ny; b.vx+=p*nx; b.vy+=p*ny;}}
  };

  useEffect(()=>{ const id=setInterval(()=>setBalls((p)=>{const n=p.map((b)=>({...b})); physics(n); return n;}),16); return ()=>clearInterval(id);},[]);
  useEffect(()=>{ const c=canvasRef.current; if(!c) return; const x=c.getContext("2d"); if(!x)return; x.clearRect(0,0,W,H); x.fillStyle="#0e2f22"; x.fillRect(40,40,W-80,H-80); x.strokeStyle="#5c3a1c"; x.lineWidth=28; x.strokeRect(30,30,W-60,H-60); for(const [px,py] of pockets){x.fillStyle="#050505"; x.beginPath(); x.arc(px,py,24,0,Math.PI*2); x.fill();}
    const cue=balls[0]; if(cue&&!cue.pocketed&&!moving(balls)){ x.strokeStyle="rgba(255,255,255,.4)"; x.lineWidth=2; x.beginPath(); x.moveTo(cue.x,cue.y); x.lineTo(cue.x+Math.cos(aim)*260,cue.y+Math.sin(aim)*260); x.stroke(); x.strokeStyle="#d6ba8d"; x.lineWidth=7; x.beginPath(); x.moveTo(cue.x-Math.cos(aim)*(62+pull),cue.y-Math.sin(aim)*(62+pull)); x.lineTo(cue.x-Math.cos(aim)*12,cue.y-Math.sin(aim)*12); x.stroke(); }
    for(const b of balls){ if(b.pocketed)continue; x.fillStyle=b.color; x.beginPath(); x.arc(b.x,b.y,R,0,Math.PI*2); x.fill(); if(b.striped){x.fillStyle="#fff"; x.fillRect(b.x-R+1,b.y-4,R*2-2,8);} if(b.number){x.fillStyle="#fff"; x.font="9px sans-serif"; x.fillText(String(b.number),b.x-3,b.y+3);} }
  },[balls,aim,pull,pockets]);

  const sendState=async(nextBalls:Ball[],t:1|2,mt:Team,ot:Team)=>{ if(aiMode) return; await fetch('/api/pool/update-state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({matchId,state:{balls:nextBalls,turn:t,myTeam:mt,oppTeam:ot,version:Date.now()}})}); };
  useEffect(()=>{ if(aiMode)return; const id=setInterval(async()=>{ const res=await fetch(`/api/pool/get-match?matchId=${matchId}`,{cache:'no-store'}); const data=await res.json(); if(data.match?.status==="active") setStarted(true); const gs=data.match?.gameState; if(gs?.version && gs.version>syncVersion){ setSyncVersion(gs.version); if(gs.balls) setBalls(gs.balls); if(gs.turn) setTurn(gs.turn); if(gs.myTeam!==undefined) setMyTeam(gs.myTeam); if(gs.oppTeam!==undefined) setOppTeam(gs.oppTeam);} },1200); return ()=>clearInterval(id); },[matchId,aiMode,syncVersion]);

  const shoot=(shotAim:number,shotPull:number)=>{ if(!started||moving(balls)||turn!==owner) return; const p=Math.min(1,Math.max(0.2,shotPull/90)); const speed=4+p*9; const prev=balls; const next=prev.map((b)=>b.id===0?{...b,vx:Math.cos(shotAim)*speed,vy:Math.sin(shotAim)*speed}:b); setBalls(next); setStatus("Shot taken");
    setTimeout(()=>{ const now=next; const beforePocketed=prev.filter(b=>b.pocketed).length; const afterPocketed=now.filter(b=>b.pocketed).length; const sunk=afterPocketed>beforePocketed;
      let mt=myTeam,ot=oppTeam; if(!myTeam){ const scored=now.find(b=>b.pocketed && !prev.find(p=>p.id===b.id)?.pocketed && b.id>0 && b.id!==8); if(scored){ mt=scored.striped?"stripes":"solids"; ot=mt==="solids"?"stripes":"solids"; setMyTeam(mt); setOppTeam(ot);} }
      const nt = sunk?turn:(turn===1?2:1); setTurn(nt); void sendState(now,nt,mt,ot); },1300);
  };
  useEffect(()=>{ if(!aiMode||turn!==2||moving(balls)) return; const cue=balls[0]; const target=balls.find(b=>b.id!==0&&!b.pocketed&&(myTeam? (myTeam==="solids"?!b.striped:b.striped):true)); if(!cue||!target)return; const a=Math.atan2(target.y-cue.y,target.x-cue.x)+(Math.random()-0.5)*0.08; setTimeout(()=>shoot(a,70),900); },[balls,turn,aiMode,myTeam]);

  const onDown=(e:any)=>{const r=e.currentTarget.getBoundingClientRect();dragRef.current={x:e.clientX-r.left,y:e.clientY-r.top};};
  const onMove=(e:any)=>{const cue=balls[0]; if(!cue)return; const r=e.currentTarget.getBoundingClientRect(); const mx=e.clientX-r.left,my=e.clientY-r.top; setAim(Math.atan2(my-cue.y,mx-cue.x)); if(dragRef.current){ setPull(Math.min(95,Math.hypot(mx-dragRef.current.x,my-dragRef.current.y))); }};
  const onUp=()=>{ if(dragRef.current){ shoot(aim,pull); setPull(0);} dragRef.current=null; };

  return <div className="min-h-screen bg-[#09121a] p-4 text-white"><NavigationBar currentPath="/casino" /><div className="mx-auto mt-6 max-w-6xl rounded-xl border border-cyan-500/40 bg-black/30 p-4"><h1 className="text-3xl font-black text-fuchsia-300">Pool Match</h1><p>{status} • Turn: Player {turn}</p><p className="text-cyan-200">You: {myTeam||"unassigned"} | Opponent: {oppTeam||"unassigned"}</p><div className="mt-4 overflow-x-auto"><canvas onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} ref={canvasRef} width={W} height={H} className="rounded-xl border border-emerald-600 bg-[#0f3f2a] cursor-crosshair"/></div></div></div>;
}
