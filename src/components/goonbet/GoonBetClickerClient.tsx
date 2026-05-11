"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  bustChanceAtClick,
  CLICKER_GROWTH_RATE,
  CLICKER_SYNC_INTERVAL_MS,
  multiplierFromClicks,
} from "../../lib/goonbet-clicker";

type RoundHistory = {
  id: number;
  bet_amount: string;
  multiplier: number;
  clicks: number;
  status: string;
  payout: string;
  created_at: string;
};

export default function GoonBetClickerClient() {
  const [tokens, setTokens] = useState<bigint>(BigInt(0));
  const [bet, setBet] = useState("10");
  const [roundId, setRoundId] = useState<number | null>(null);
  const [multiplier, setMultiplier] = useState(1);
  const [clicks, setClicks] = useState(0);
  const [busted, setBusted] = useState(false);
  const [history, setHistory] = useState<RoundHistory[]>([]);
  const [roundStartTime, setRoundStartTime] = useState<number | null>(null);
  const roundIdRef = useRef<number | null>(null);

  const potentialPayout = useMemo(() => {
    const b = BigInt(bet || "0");
    return (b * BigInt(Math.floor(multiplier * 1_000_000))) / BigInt(1000000);
  }, [bet, multiplier]);

  async function refresh() {
    const res = await fetch("/api/user/tokens");
    if (!res.ok) return;
    const data = await res.json();
    setTokens(BigInt(data.tokens));
    setHistory(data.rounds ?? []);
  }
  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    roundIdRef.current = roundId;
  }, [roundId]);

  useEffect(() => {
    if (!roundId || !roundStartTime) return;
    const interval = setInterval(async () => {
      if (!roundIdRef.current) return;
      await fetch("/api/clicker/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roundId: roundIdRef.current,
          clientClicks: clicks,
          clientMultiplier: multiplier,
          durationMs: Date.now() - roundStartTime,
        }),
      });
    }, CLICKER_SYNC_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [roundId, roundStartTime, clicks, multiplier]);

  async function start() {
    const res = await fetch("/api/clicker/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ betAmount: bet }),
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error);
    setRoundId(data.roundId);
    setRoundStartTime(new Date(data.startTime).getTime());
    setMultiplier(1);
    setClicks(0);
    setBusted(false);
    await refresh();
  }

  function clickRound() {
    if (!roundId) return;
    const nextClicks = clicks + 1;
    const failChance = bustChanceAtClick(nextClicks);
    if (Math.random() < failChance) {
      setClicks(nextClicks);
      setMultiplier(multiplierFromClicks(nextClicks));
      setBusted(true);
      setRoundId(null);
      setRoundStartTime(null);
      refresh();
      return;
    }

    setClicks(nextClicks);
    setMultiplier(multiplierFromClicks(nextClicks));
  }

  async function cashout() {
    if (!roundId || !roundStartTime) return;
    const res = await fetch("/api/clicker/cashout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roundId,
        clientClicks: clicks,
        clientMultiplier: multiplier,
        durationMs: Date.now() - roundStartTime,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setBusted(true);
      setRoundId(null);
      return alert(data.error);
    }
    setRoundId(null);
    setRoundStartTime(null);
    await refresh();
  }

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <div className="mx-auto max-w-3xl rounded-2xl border border-fuchsia-500/40 bg-zinc-950 p-6 shadow-[0_0_40px_rgba(217,70,239,0.25)]">
        <h1 className="text-4xl font-bold text-fuchsia-400">GoonBet Clicker</h1>
        <p className="mt-2 text-zinc-300">
          Tokens: <span className="text-emerald-400">{tokens.toString()}</span>
        </p>
        <p className="text-xs text-zinc-500 mt-1">
          Local growth rate: {CLICKER_GROWTH_RATE} per click
        </p>
        <div className="mt-6 flex gap-3">
          <input
            className="bg-zinc-900 border border-zinc-700 rounded px-3 py-2"
            value={bet}
            onChange={(e) => setBet(e.target.value)}
          />
          <button
            onClick={start}
            disabled={!!roundId}
            className="px-4 py-2 rounded bg-fuchsia-600 disabled:opacity-50"
          >
            Start Round
          </button>
        </div>

        <div
          className={`mt-8 rounded-xl p-6 border ${busted ? "border-red-500 bg-red-950/40 animate-pulse" : "border-cyan-500/50 bg-zinc-900"}`}
        >
          <p className="text-lg">
            Multiplier:{" "}
            <span
              className="text-cyan-300 text-3xl inline-block transition-transform duration-100"
              style={{ transform: `scale(${1 + clicks * 0.002})` }}
            >
              {multiplier.toFixed(4)}x
            </span>
          </p>
          <p>Clicks: {clicks}</p>
          <p>Potential payout: {potentialPayout.toString()}</p>
          <p className="text-amber-300">
            Next click bust chance:{" "}
            {(bustChanceAtClick(clicks + 1) * 100).toFixed(2)}%
          </p>
          {busted && <p className="text-red-400 text-2xl font-black">BUST</p>}
        </div>

        <div className="mt-6 flex gap-3">
          <button
            onClick={clickRound}
            disabled={!roundId}
            className="px-8 py-4 rounded-full bg-cyan-500 text-black font-bold shadow-[0_0_30px_rgba(34,211,238,0.7)] disabled:opacity-50"
          >
            CLICK
          </button>
          {roundId && !busted && (
            <button
              onClick={cashout}
              className="px-4 py-2 rounded bg-emerald-500 text-black font-bold"
            >
              Cash Out
            </button>
          )}
        </div>

        <h2 className="mt-10 text-xl font-semibold">Last Rounds</h2>
        <div className="mt-3 space-y-2">
          {history.map((r) => (
            <div
              key={r.id}
              className="text-sm bg-zinc-900 p-2 rounded border border-zinc-800"
            >
              #{r.id} • bet {r.bet_amount} • {r.clicks} clicks •{" "}
              {r.multiplier.toFixed(4)}x • {r.status} • payout {r.payout}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
