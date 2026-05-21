"use client";

import { useMemo, useState } from "react";
import { useSocket } from "../../../context/SocketProvider";

const categories = ["ones","twos","threes","fours","fives","sixes","threeOfKind","fourOfKind","fullHouse","smallStraight","largeStraight","yahtzee","chance"];

export default function YahtzeePage() {
  const { socket } = useSocket();
  const [room, setRoom] = useState<any>(null);
  const [wager, setWager] = useState(100);
  const [joinId, setJoinId] = useState("");

  useMemo(() => {
    if (!socket) return;
    const up = (r:any) => setRoom(r);
    socket.on("room_created", up);
    socket.on("room_updated", up);
    socket.on("game_state_update", up);
    return () => { socket.off("room_created", up); socket.off("room_updated", up); socket.off("game_state_update", up); };
  }, [socket]);

  return (
    <div className="min-h-screen bg-[#05050b] text-cyan-100 p-4">
      <div className="mx-auto max-w-5xl rounded-2xl border border-cyan-400/40 bg-white/5 backdrop-blur p-4 shadow-[0_0_60px_rgba(6,182,212,0.2)]">
        <h1 className="text-3xl font-black text-fuchsia-300 drop-shadow-[0_0_16px_rgba(232,121,249,0.8)]">YAHTZEE // NEON ARENA</h1>
        <div className="mt-4 flex flex-wrap gap-2">
          <input className="bg-black/40 border border-cyan-500/40 rounded px-3 py-2" type="number" value={wager} onChange={(e)=>setWager(Number(e.target.value || 0))} />
          <button onClick={()=>socket?.emit("create_room", { game: "yahtzee", wager })} className="px-3 py-2 rounded bg-cyan-500/20 border border-cyan-300">Create Game</button>
          <input className="bg-black/40 border border-cyan-500/40 rounded px-3 py-2" placeholder="Room ID" value={joinId} onChange={(e)=>setJoinId(e.target.value)} />
          <button onClick={()=>socket?.emit("join_room", { roomId: joinId, game: "yahtzee" })} className="px-3 py-2 rounded bg-fuchsia-500/20 border border-fuchsia-300">Join Game</button>
          <button onClick={()=>socket?.emit("start_ai_match", { game: "yahtzee", wager, difficulty: "medium" })} className="px-3 py-2 rounded bg-emerald-500/20 border border-emerald-300">Play vs AI</button>
        </div>

        {room && (
          <div className="mt-6 grid grid-rows-[auto_1fr_auto] gap-4">
            <div className="rounded-xl border border-cyan-300/40 p-3 bg-black/30">Opponent: {room.players?.[1]?.name ?? "Waiting..."} | Score: {Object.values(room.scorecards?.[room.players?.[1]?.userId]||{}).reduce((a:any,b:any)=>a+b,0)}</div>
            <div className="rounded-xl border border-fuchsia-300/40 p-3 bg-black/30">
              <p className="mb-2">Turn: {room.currentTurn} | Rolls: {room.rollsThisTurn}/3</p>
              <div className="flex gap-2 mb-3">{(room.dice||[]).map((d:number,i:number)=><button key={i} onClick={()=>{const held=[...(room.heldDice||[])]; held[i]=!held[i]; socket?.emit("hold_dice", { roomId: room.id, heldDice: held });}} className={`h-14 w-14 rounded-lg border text-xl font-bold transition ${room.heldDice?.[i] ? "bg-fuchsia-500/40 border-fuchsia-300 animate-pulse" : "bg-cyan-500/20 border-cyan-200"}`}>{d}</button>)}</div>
              <button onClick={()=>socket?.emit("roll_dice", { roomId: room.id })} className="px-3 py-2 rounded bg-yellow-500/20 border border-yellow-300">Roll Dice</button>
              <div className="mt-4 grid grid-cols-2 gap-2">{categories.map(c=><button key={c} onClick={()=>socket?.emit("choose_category", { roomId: room.id, category: c })} className="text-left rounded border border-cyan-500/30 p-2 hover:bg-cyan-500/10">{c}: {room.scorecards?.[room.players?.[0]?.userId]?.[c] ?? "-"}</button>)}</div>
            </div>
            <div className="rounded-xl border border-emerald-300/40 p-3 bg-black/30">You: {room.players?.[0]?.name} | Score: {Object.values(room.scorecards?.[room.players?.[0]?.userId]||{}).reduce((a:any,b:any)=>a+b,0)}</div>
          </div>
        )}
      </div>
    </div>
  );
}
