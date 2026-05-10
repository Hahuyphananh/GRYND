"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import NavigationBar from "../../../../components/navigation-bar";

export default function PoolLobbyPage() {
  const router = useRouter();
  const [lobbies, setLobbies] = useState<any[]>([]);
  const [wager, setWager] = useState(10);
  const [createdLobbyId, setCreatedLobbyId] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch("/api/pool/lobbies", { cache: "no-store" });
    const data = await res.json();
    setLobbies(data.lobbies || []);
  };

  useEffect(() => { load(); const id = setInterval(load, 3000); return () => clearInterval(id); }, []);



  useEffect(() => {
    if (!createdLobbyId) return;
    const id = setInterval(async () => {
      const res = await fetch(`/api/pool/get-match?matchId=${createdLobbyId}`, { cache: "no-store" });
      const data = await res.json();
      const match = data?.match;
      if (match?.status === "active" && match?.id && match.id !== createdLobbyId) {
        router.push(`/casino/pool-masters/game/${match.id}`);
      }
    }, 1200);

    return () => clearInterval(id);
  }, [createdLobbyId, router]);
  const createLobby = async () => {
    const res = await fetch("/api/pool/create-lobby", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wager }) });
    const data = await res.json();
    if (data.lobbyId) {
      setCreatedLobbyId(data.lobbyId);
      router.push(`/casino/pool-masters/game/${data.lobbyId}`);
    }
  };
  

  const joinLobby = async (lobbyId: string) => {
    const res = await fetch("/api/pool/join-lobby", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lobbyId }) });
    const data = await res.json();
    if (data.matchId) router.push(`/casino/pool-masters/game/${data.matchId}`);
  };

  const createAI = async () => {
    const res = await fetch("/api/pool/create-ai-match", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wager }) });
    const data = await res.json();
    if (data.matchId) router.push(`/casino/pool-masters/game/${data.matchId}?ai=1`);
  };

  return <div className="min-h-screen bg-gradient-to-b from-[#06120f] to-[#050816] p-6 text-white">
    <NavigationBar currentPath="/casino" />
    <div className="mx-auto mt-10 max-w-6xl rounded-2xl border border-cyan-500/40 bg-black/30 p-5">
      <h1 className="text-4xl font-black text-fuchsia-300">Pool Masters Lobby</h1>
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-fuchsia-500/40 bg-black/30 p-4">
          <h2 className="text-xl font-bold">Create game</h2>
          <div className="mt-3 flex gap-2">{[10,25,50,100].map(v => <button key={v} onClick={() => setWager(v)} className={`rounded px-3 py-2 ${wager===v ? "bg-fuchsia-600" : "bg-slate-800"}`}>{v}</button>)}</div>
          <button onClick={createLobby} className="mt-4 w-full rounded bg-cyan-400 py-2 font-bold text-black">Create PvP Game</button>
          <button onClick={createAI} className="mt-2 w-full rounded bg-pink-500 py-2 font-bold text-black">Create AI Game</button>
        </div>
        <div className="rounded-xl border border-cyan-500/40 bg-black/30 p-4 lg:col-span-2">
          <h2 className="text-xl font-bold">Available Games</h2>
          <div className="mt-3 space-y-3">{lobbies.length===0 && <p className="text-slate-300">No open lobbies.</p>}
            {lobbies.map((l) => <div key={l.id} className="flex items-center justify-between rounded border border-slate-700 p-3"><div><p>Wager: {l.wager}</p><p className="text-xs text-slate-400">Mode: {l.gameMode} • Waiting for player</p></div><button onClick={() => joinLobby(l.id)} className="rounded bg-fuchsia-600 px-3 py-2">Join</button></div>)}
          </div>
        </div>
      </div>
    </div>
  </div>;
}
