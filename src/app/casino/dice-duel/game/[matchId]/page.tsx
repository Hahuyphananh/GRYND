"use client";
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import io from 'socket.io-client';

const socket = io(process.env.NEXT_PUBLIC_REALTIME_URL || 'http://localhost:4000', { autoConnect: true });

export default function DiceDuelMatchPage() {
  const { matchId } = useParams<{ matchId: string }>();
  const [state, setState] = useState<any>(null);
  const [timer, setTimer] = useState(20);

  useEffect(() => {
    socket.emit('dice:lobby:join', { lobbyId: matchId });
    socket.on('dice:state:update', setState);
    socket.on('dice:match:start', setState);
    return () => { socket.off('dice:state:update', setState); socket.off('dice:match:start', setState); };
  }, [matchId]);

  useEffect(() => {
    const id = setInterval(() => setTimer((x) => Math.max(0, x - 1)), 1000);
    return () => clearInterval(id);
  }, []);

  const myTurn = useMemo(() => state?.turnUserId === state?.me, [state]);
  const submit = (actionType: string) => socket.emit('dice:turn:submit', { matchId, actionType });

  return <div className="min-h-screen bg-[#070414] text-white p-6">
    <h1 className="text-3xl font-bold text-fuchsia-400">Dice Duel Arena Match</h1>
    <div className="mt-4 grid md:grid-cols-2 gap-4">
      <div className="p-4 border border-fuchsia-600 rounded">HP: {state?.hp1 ?? 20}</div>
      <div className="p-4 border border-cyan-600 rounded">HP: {state?.hp2 ?? 20}</div>
    </div>
    <div className="mt-3 text-cyan-300">Turn timer: {timer}s</div>
    <div className="mt-5 flex flex-wrap gap-2">
      {['SAFE_ROLL','POWER_ROLL','SHIELD','DOUBLE_DOWN'].map((a)=><button disabled={!myTurn} key={a} onClick={() => submit(a)} className="px-4 py-2 bg-[#1a1440] rounded border border-pink-500 disabled:opacity-40">{a}</button>)}
    </div>
  </div>;
}
