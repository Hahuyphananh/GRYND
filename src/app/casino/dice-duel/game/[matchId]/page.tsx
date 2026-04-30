"use client";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";

const ACTIONS = ["SAFE_ROLL", "POWER_ROLL", "SHIELD", "DOUBLE_DOWN"];

export default function DiceDuelMatchPage() {
  const { matchId } = useParams<{ matchId: string }>();
  const router = useRouter();
  const [match, setMatch] = useState<any>(null);
  const [turns, setTurns] = useState<any[]>([]);
  const [pending, setPending] = useState(false);
  const [viewerId, setViewerId] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch(`/api/dice-duel/get-match?matchId=${matchId}`, { cache: "no-store" });
    const data = await res.json();
    if (!data.ok) return;
    setMatch(data.match);
    setTurns(data.turns || []);
    setViewerId(data.viewerId || null);
  };

  useEffect(() => { load(); const id = setInterval(load, 1500); return () => clearInterval(id); }, [matchId]);

  const myTurn = useMemo(() => Boolean(match?.turnUserId && viewerId && match.turnUserId === viewerId), [match, viewerId]);

  const play = async (actionType: string) => {
    setPending(true);
    await fetch("/api/dice-duel/submit-turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ matchId, actionType }) });
    setPending(false);
    load();
  };

  return <div className="min-h-screen bg-[#050512] text-white p-4 md:p-8">
    <div className="max-w-5xl mx-auto rounded-2xl border border-cyan-800 bg-black/30 p-5">
      <div className="flex items-center justify-between"><h1 className="text-3xl font-black text-fuchsia-400">Arena Match</h1><button onClick={()=>router.push('/casino/dice-duel')} className="text-cyan-300">Back</button></div>
      <div className="grid md:grid-cols-2 gap-4 mt-5">
        <div className="rounded-xl border border-fuchsia-500 p-4"><p className="text-sm text-slate-300">Player HP</p><p className="text-3xl font-bold">{match?.hp1 ?? "--"}</p></div>
        <div className="rounded-xl border border-cyan-500 p-4"><p className="text-sm text-slate-300">Enemy HP</p><p className="text-3xl font-bold">{match?.hp2 ?? "--"}</p></div>
      </div>
      <div className="mt-4 text-sm text-slate-300">Round {match?.round || 1} · Status: {match?.status || 'loading'}</div>
      <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-2">
        {ACTIONS.map((a)=><button key={a} disabled={pending || !myTurn || match?.status !== "active"} onClick={()=>play(a)} className="rounded-lg border border-pink-500 py-3 bg-[#140b2f] disabled:opacity-50">{a.replace('_', ' ')}</button>)}
      </div>
      <h2 className="mt-6 font-bold text-cyan-300">Recent Turns</h2>
      <div className="mt-2 space-y-2">{turns.map((t)=><div key={t.id} className="text-sm rounded border border-slate-700 p-2">{t.userId} used {t.actionType} · dmg {t.damageDealt} · self {t.selfDamage}</div>)}</div>
    </div>
  </div>;
}
