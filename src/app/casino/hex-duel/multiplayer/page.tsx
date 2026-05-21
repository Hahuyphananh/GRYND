"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function HexDuelMultiplayerPage() {
  const [games, setGames] = useState<any[]>([]);
  const [wager, setWager] = useState(50);
  const router = useRouter();
  const load = async () => {
    const res = await fetch('/api/hex-duel/multiplayer/available');
    const data = await res.json();
    setGames(data.games || []);
  };
  useEffect(() => { load(); }, []);
  return <main className="min-h-screen bg-gradient-to-br from-[#010510] via-[#031634] to-[#030916] p-6 pt-24 text-white">
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-black mb-4">Hex Duel Multiplayer Lobby</h1>
      <div className="mb-6 flex gap-2">
        <input type="number" value={wager} onChange={(e)=>setWager(Number(e.target.value)||0)} className="rounded bg-black/30 border border-white/20 px-3 py-2" />
        <button className="rounded border border-cyan-400/40 px-4" onClick={async()=>{await fetch('/api/hex-duel/multiplayer/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wager})});router.push('/casino/hex-duel')}}>Create Game</button>
      </div>
      <h2 className="mb-2 text-sm uppercase text-slate-400">Available Games</h2>
      <div className="space-y-2">{games.map((g)=><div key={g.id} className="rounded border border-white/10 p-3 flex justify-between"><span>Game #{g.id} · {g.wagerAmount} tokens</span><button onClick={async()=>{await fetch('/api/hex-duel/multiplayer/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gameId:g.id})});router.push('/casino/hex-duel')}}>Join</button></div>)}</div>
    </div>
  </main>
}
