"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import NavigationBar from "../../../components/navigation-bar";

type LobbyRoom = { id: string; wager: number; status: string };
type Player = { userId: string; name: string; isAI?: boolean };
type GameState = {
  id: string;
  players: Player[];
  currentTurn: string;
  rollsThisTurn: number;
  dice: number[];
  heldDice: boolean[];
  scorecards: Record<string, Record<string, number>>;
  state: string;
};

const categories = [
  ["ones", "Ones"], ["twos", "Twos"], ["threes", "Threes"], ["fours", "Fours"], ["fives", "Fives"], ["sixes", "Sixes"],
  ["threeOfKind", "3x"], ["fourOfKind", "4x"], ["fullHouse", "Full"], ["smallStraight", "Sm"], ["largeStraight", "Lg"], ["yahtzee", "Ytz"], ["chance", "?"],
] as const;

const sum = (d: number[]) => d.reduce((a, b) => a + b, 0);
const scoreFor = (dice: number[], category: string) => {
  const c = new Map<number, number>(); dice.forEach((v) => c.set(v, (c.get(v) ?? 0) + 1));
  const f = [...c.values()].sort((a, b) => b - a); const u = [...new Set(dice)].sort((a, b) => a - b);
  if (category === "chance") return sum(dice);
  if (["ones", "twos", "threes", "fours", "fives", "sixes"].includes(category)) { const n = ["ones", "twos", "threes", "fours", "fives", "sixes"].indexOf(category) + 1; return dice.filter((d) => d === n).length * n; }
  if (category === "threeOfKind") return f[0] >= 3 ? sum(dice) : 0;
  if (category === "fourOfKind") return f[0] >= 4 ? sum(dice) : 0;
  if (category === "fullHouse") return f[0] === 3 && f[1] === 2 ? 25 : 0;
  if (category === "smallStraight") return ([1,2,3,4].every((n) => u.includes(n)) || [2,3,4,5].every((n) => u.includes(n)) || [3,4,5,6].every((n) => u.includes(n))) ? 30 : 0;
  if (category === "largeStraight") return (JSON.stringify(u) === "[1,2,3,4,5]" || JSON.stringify(u) === "[2,3,4,5,6]") ? 40 : 0;
  if (category === "yahtzee") return f[0] === 5 ? 50 : 0;
  return 0;
};

const DiceFace = ({ value, held, rolling }: { value: number; held?: boolean; rolling?: boolean }) => {
  const dots: Record<number, string[]> = {1:["50% 50%"],2:["30% 30%","70% 70%"],3:["30% 30%","50% 50%","70% 70%"],4:["30% 30%","70% 30%","30% 70%","70% 70%"],5:["30% 30%","70% 30%","50% 50%","30% 70%","70% 70%"],6:["30% 25%","70% 25%","30% 50%","70% 50%","30% 75%","70% 75%"]};
  return <div className={`relative h-14 w-14 rounded-xl border-2 bg-white shadow-[0_0_20px_rgba(34,211,238,0.35)] ${held ? "border-fuchsia-500" : "border-cyan-400"} ${rolling ? "animate-spin" : ""}`}>{dots[value]?.map((pos, i) => { const [left, top] = pos.split(" "); return <span key={i} className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black" style={{ left, top }} />; })}</div>;
};

export default function YahtzeePage() {
  const { isSignedIn, user } = useUser();
  const [wager, setWager] = useState(100); const [balance, setBalance] = useState(0); const [loading, setLoading] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null); const [availableGames, setAvailableGames] = useState<LobbyRoom[]>([]);
  const [roomId, setRoomId] = useState<string | null>(null); const [game, setGame] = useState<GameState | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null); const [rolling, setRolling] = useState(false);

  const fetchBalance = async () => { if (!user) return; const r = await fetch("/api/get-user-tokens", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include" }); const d = await r.json(); if (d.success) setBalance(Number(d.data.balance || 0)); };
  const fetchGames = async () => { const res = await fetch("/api/yahtzee/state", { cache: "no-store" }); const data = await res.json(); if (data.success) setAvailableGames(data.rooms || []); };
  const fetchRoom = async (id: string) => { const res = await fetch(`/api/yahtzee/state?roomId=${encodeURIComponent(id)}`, { cache: "no-store" }); const data = await res.json(); if (data.success && data.room?.gameState) setGame(data.room.gameState as GameState); };

  useEffect(() => { if (isSignedIn && user) fetchBalance(); fetchGames(); }, [isSignedIn, user]);
  useEffect(() => { if (!roomId) return; fetchRoom(roomId); const p = setInterval(() => fetchRoom(roomId), 1500); return () => clearInterval(p); }, [roomId]);

  const you = useMemo(() => game?.players?.find((p) => p.userId === user?.id) || null, [game, user?.id]);
  const opponent = useMemo(() => game?.players?.find((p) => p.userId !== user?.id) || null, [game, user?.id]);
  const isYourTurn = Boolean(game && you && game.currentTurn === you.userId);
  const waitingForOpponent = Boolean(game && game.players.length < 2 && game.state === "waiting");

  const sectionTotals = (pid?: string) => { const c = game?.scorecards?.[pid || ""] || {}; const upper = ["ones","twos","threes","fours","fives","sixes"].reduce((t, k) => t + (c[k] ?? 0), 0); const bonus = upper >= 63 ? 35 : 0; const total = Object.values(c).reduce((a, b) => a + (b || 0), 0) + bonus; return { upper, bonus, total }; };
  const preview = (key: string) => (!game || !isYourTurn || game.rollsThisTurn < 1 || !you || game.scorecards?.[you.userId]?.[key] !== undefined ? null : scoreFor(game.dice, key));

  const createGame = async () => { if (wager <= 0 || wager > balance) return alert("Invalid wager amount"); setLoading(true); try { const res = await fetch("/api/yahtzee/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wager }) }); const d = await res.json(); if (!res.ok || !d.success) return alert(d.error || "Unable to create room"); setRoomId(d.roomId); setGame(d.state);} finally { setLoading(false); } };
  const playAI = async () => { setLoading(true); try { const res = await fetch("/api/yahtzee/start-ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wager, difficulty: "medium" }) }); const d = await res.json(); if (!res.ok || !d.success) return alert(d.error || "Unable"); setRoomId(d.roomId); setGame(d.state);} finally { setLoading(false); } };
  const joinGame = async (id: string) => { setLoading(true); setJoiningId(id); try { const res = await fetch("/api/yahtzee/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId: id }) }); const d = await res.json(); if (!res.ok || !d.success) return alert(d.error || "Unable to join"); setRoomId(id); setGame(d.state);} finally { setLoading(false); setJoiningId(null);} };
  const playAction = async (url: string, payload: Record<string, unknown>) => { if (!roomId || !isYourTurn) return; const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId, ...payload }) }); const d = await res.json(); if (!res.ok || !d.success) return alert(d.error || "Action failed"); setGame((d.state || d.finalState) as GameState); };
  const resign = async () => { if (!roomId) return; const res = await fetch("/api/yahtzee/resign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId }) }); const d = await res.json(); if (!res.ok || !d.success) return alert(d.error || "Failed"); setGame(d.state); };

  return <div className="min-h-screen bg-gradient-to-b from-[#090217] to-[#041433] px-3 pb-24 pt-20 text-white"><NavigationBar currentPath="/casino" />
    <div className="mx-auto mt-4 max-w-5xl">
      <motion.h1 initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mb-2 text-center text-4xl font-black text-fuchsia-400">YAHTZEE ARENA</motion.h1>
      {!roomId && <div className="rounded-2xl border border-cyan-700 bg-black/40 p-4"><div className="mb-3 font-bold text-yellow-300">Balance: {balance.toFixed(2)} tokens</div><div className="flex flex-wrap gap-2"><input type="number" value={wager} onChange={(e) => setWager(Number(e.target.value || 0))} className="rounded bg-slate-900 px-3 py-2" /><button onClick={createGame} className="rounded bg-cyan-500 px-4 py-2 font-bold text-black">Create PvP</button><button onClick={playAI} className="rounded bg-fuchsia-500 px-4 py-2 font-bold">Play vs AI</button><button onClick={fetchGames} className="rounded bg-amber-500 px-4 py-2 font-bold">Refresh</button></div>
      <div className="mt-4 space-y-2">{availableGames.length === 0 ? <p>No open games.</p> : availableGames.map((l) => <div key={l.id} className="flex items-center justify-between rounded bg-slate-900/80 p-2"><span>{l.id} · {l.wager}</span><button onClick={() => joinGame(l.id)} className="rounded bg-cyan-500 px-3 py-1 text-black">{joiningId === l.id ? "Joining" : "Join"}</button></div>)}</div></div>}

      {game && <div className="mt-6 rounded-2xl border border-cyan-700 bg-black/45 p-4">
        <div className="mb-3 flex items-center justify-between"><div>{isYourTurn ? "Your turn" : `${opponent?.name || "Opponent"}'s turn`} · Rolls {game.rollsThisTurn}/3</div><button onClick={resign} className="rounded bg-red-600 px-3 py-1 font-bold">Resign</button></div>
        {waitingForOpponent && <div className="mb-4 rounded border border-fuchsia-500 bg-fuchsia-950/40 p-2 text-sm">Waiting for opponent to join. You cannot roll yet.</div>}

        <div className="mb-3 flex justify-center gap-2">{game.dice.map((d, i) => <button key={i} disabled={!isYourTurn || waitingForOpponent} onClick={() => playAction("/api/yahtzee/hold", { heldDice: game.heldDice.map((v, idx) => idx === i ? !v : v) })}><DiceFace value={d} held={game.heldDice[i]} rolling={rolling} /></button>)}</div>
        <div className="mb-4 flex justify-center"><button disabled={!isYourTurn || waitingForOpponent} onClick={async () => { setRolling(true); await playAction("/api/yahtzee/roll", {}); setTimeout(() => setRolling(false), 350); }} className="rounded bg-yellow-400 px-5 py-2 font-black text-black">ROLL</button></div>

        <div className="rounded-xl border border-cyan-500/50 overflow-hidden"><div className="grid grid-cols-4 bg-cyan-900/60 p-2 font-bold text-sm"><div>Case</div><div>{you?.name || "You"}</div><div>{opponent?.name || "Them"}</div><div>Preview</div></div>
        {categories.map(([k, label]) => { const myVal = you ? game.scorecards?.[you.userId]?.[k] : undefined; const opVal = opponent ? game.scorecards?.[opponent.userId]?.[k] : undefined; const canPick = isYourTurn && myVal === undefined && game.rollsThisTurn > 0; return <button key={k} onClick={() => canPick && setSelectedCategory(k)} className={`grid w-full grid-cols-4 border-t border-cyan-900/60 p-2 text-left text-sm ${selectedCategory === k ? "bg-fuchsia-900/30" : ""}`}><div>{label}</div><div>{myVal ?? "—"}</div><div>{opVal ?? "—"}</div><div>{myVal === undefined ? (preview(k) ?? "—") : "Locked"}</div></button>; })}
        <div className="grid grid-cols-4 border-t border-cyan-400 bg-cyan-950 p-2 font-bold"><div>Bonus/Total</div><div>{sectionTotals(you?.userId).bonus} / {sectionTotals(you?.userId).total}</div><div>{sectionTotals(opponent?.userId).bonus} / {sectionTotals(opponent?.userId).total}</div><div>63+ upper = +35</div></div></div>
        <div className="mt-3 flex justify-center"><button disabled={!selectedCategory || !isYourTurn} onClick={() => { if (!selectedCategory) return; playAction("/api/yahtzee/choose-category", { category: selectedCategory }); setSelectedCategory(null); }} className="rounded bg-fuchsia-500 px-5 py-2 font-bold disabled:opacity-50">Confirm Play</button></div>
      </div>}
    </div>
  </div>;
}
