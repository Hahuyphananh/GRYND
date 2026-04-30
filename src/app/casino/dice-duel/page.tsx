"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

export default function DiceDuelLobbyPage() {
  const [lobbies, setLobbies] = useState<any[]>([]);
  const [wager, setWager] = useState(10);

  const load = async () => {
    const res = await fetch('/api/dice-duel/lobbies', { cache: 'no-store' });
    const data = await res.json();
    setLobbies(data.lobbies || []);
  };

  useEffect(() => { load(); }, []);

  const createLobby = async () => {
    const res = await fetch('/api/dice-duel/create-lobby', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wager }) });
    const data = await res.json();
    if (data.lobbyId) window.location.href = `/casino/dice-duel/game/${data.lobbyId}`;
  };

  return <div className="min-h-screen bg-[#060717] text-white p-6">
    <h1 className="text-3xl font-bold text-fuchsia-400">Dice Duel Arena</h1>
    <p className="text-cyan-300 mt-2">Cyberpunk turn-based 1v1 wager combat.</p>
    <div className="mt-6 flex gap-2 flex-wrap">{[5,10,25,50,100].map(v => <button key={v} onClick={() => setWager(v)} className={`px-4 py-2 rounded border ${wager===v?'border-fuchsia-400':'border-cyan-700'}`}>{v}</button>)}</div>
    <button onClick={createLobby} className="mt-4 px-5 py-2 rounded bg-fuchsia-600">Create Lobby</button>
    <h2 className="mt-8 text-xl">Open Lobbies</h2>
    <div className="grid md:grid-cols-2 gap-3 mt-3">{lobbies.map((l) => <div key={l.id} className="border border-cyan-700 rounded p-3"><div>Wager: {l.wager}</div><Link className="text-cyan-300 underline" href={`/casino/dice-duel/game/${l.id}`}>Join</Link></div>)}</div>
  </div>;
}
