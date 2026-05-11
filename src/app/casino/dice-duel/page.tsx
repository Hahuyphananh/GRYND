"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import NavigationBar from "../../../components/navigation-bar";

export default function DiceDuelLobbyPage() {
  const [lobbies, setLobbies] = useState<any[]>([]);
  const [wager, setWager] = useState(10);
  const [loading, setLoading] = useState(false);
  const [tokens, setTokens] = useState<number | null>(null);
  const router = useRouter();

  const loadTokens = async () => {
    const res = await fetch("/api/get-user-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const data = await res.json();

    if (data.success) {
      setTokens(data.data.balance);
    }
  };

  const load = async () => {
    const res = await fetch("/api/dice-duel/lobbies", { cache: "no-store" });
    const data = await res.json();
    setLobbies(data.lobbies || []);
  };

  useEffect(() => {
    load();
    loadTokens();

    const id = setInterval(() => {
      load();
      loadTokens();
    }, 3000);

    return () => clearInterval(id);
  }, []);

  const createLobby = async () => {
    setLoading(true);
    const res = await fetch("/api/dice-duel/create-lobby", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wager }),
    });
    const data = await res.json();
    setLoading(false);
    if (data.lobbyId) router.push(`/casino/dice-duel/game/${data.lobbyId}`);
  };

  const joinLobby = async (lobbyId: string) => {
    const res = await fetch("/api/dice-duel/join-lobby", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lobbyId }),
    });
    const data = await res.json();
    router.push(`/casino/dice-duel/game/${data.matchId || lobbyId}`);
  };

  const playAI = async () => {
    const res = await fetch("/api/dice-duel/create-ai-match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wager }),
    });
    const data = await res.json();
    if (data.matchId) {
      router.push(`/casino/dice-duel/game/${data.matchId}`);
    } else {
      alert(data.message || "Unable to start game");
    }
  };

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-b from-[#090217] to-[#041433] px-3 pb-24 pt-20 text-white sm:px-4 md:px-8 md:pb-8">
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto mt-4 max-w-6xl rounded-2xl border border-cyan-800 bg-black/30 p-4 sm:mt-8 sm:p-5">
        <h1 className="text-2xl font-black text-fuchsia-400 sm:text-3xl md:text-4xl">
          Dice Duel Arena
        </h1>
        <p className="text-cyan-300 mt-2">
          Turn-based cyberpunk PvP with wagered tokens.
        </p>
        <p className="text-yellow-400 mt-1 font-semibold">
          Tokens: {tokens ?? "--"}
        </p>
        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          <div className="col-span-1 rounded-xl border border-fuchsia-500/50 bg-black/30 p-4">
            <h2 className="font-bold text-xl">Create Game</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {[5, 10, 25, 50, 100].map((v) => (
                <button
                  key={v}
                  onClick={() => setWager(v)}
                  className={`min-h-11 rounded px-3 py-2 text-sm sm:text-base ${wager === v ? "bg-fuchsia-600" : "bg-slate-800"}`}
                >
                  {v}
                </button>
              ))}
            </div>
            <button
              disabled={loading}
              onClick={createLobby}
              className="mt-4 w-full py-2 rounded bg-cyan-500 text-black font-bold"
            >
              Create PvP Lobby
            </button>
            <button
              onClick={playAI}
              className="mt-2 w-full py-2 rounded bg-pink-500 font-bold"
            >
              Play vs AI
            </button>
          </div>
          <div className="col-span-2 rounded-xl border border-cyan-500/50 bg-black/30 p-4">
            <h2 className="font-bold text-xl">Available Games</h2>
            <div className="mt-3 space-y-3">
              {lobbies.length === 0 && (
                <p className="text-slate-300">No open lobbies yet.</p>
              )}
              {lobbies.map((l) => (
                <div
                  key={l.id}
                  className="flex flex-col gap-2 rounded border border-slate-700 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="font-semibold">Wager: {l.wager} tokens</p>
                    <p className="text-xs text-slate-400">Status: {l.status}</p>
                  </div>
                  <button
                    onClick={() => joinLobby(l.id)}
                    className="min-h-11 rounded bg-fuchsia-600 px-4 py-2"
                  >
                    Join
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
