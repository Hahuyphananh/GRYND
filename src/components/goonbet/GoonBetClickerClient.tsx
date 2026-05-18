"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import NavigationBar from "../navigation-bar";
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
  const router = useRouter();
  const [tokens, setTokens] = useState<bigint>(BigInt(0));
  const [bet, setBet] = useState("10");
  const [roundId, setRoundId] = useState<number | null>(null);
  const [multiplier, setMultiplier] = useState(1);
  const [clicks, setClicks] = useState(0);
  const [busted, setBusted] = useState(false);
  const [lastPayout, setLastPayout] = useState<string | null>(null);
  const [history, setHistory] = useState<RoundHistory[]>([]);
  const [roundStartTime, setRoundStartTime] = useState<number | null>(null);
  const roundIdRef = useRef<number | null>(null);
  const roundStartTimeRef = useRef<number | null>(null);
  const clicksRef = useRef(0);
  const multiplierRef = useRef(1);

  const potentialPayout = useMemo(() => {
    const b = BigInt(bet || "0");
    return (b * BigInt(Math.floor(multiplier * 1_000_000))) / BigInt(1000000);
  }, [bet, multiplier]);

  async function refresh() {
    const [tokenRes, historyRes] = await Promise.all([
      fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      }),
      fetch("/api/user/tokens", { credentials: "include" }),
    ]);

    if (tokenRes.ok) {
      const tokenData = await tokenRes.json();
      if (tokenData.success) {
        setTokens(BigInt(Math.floor(Number(tokenData.data.balance ?? 0))));
      }
    }

    if (historyRes.ok) {
      const historyData = await historyRes.json();
      setHistory(historyData.rounds ?? []);
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    roundIdRef.current = roundId;
  }, [roundId]);

  useEffect(() => {
    roundStartTimeRef.current = roundStartTime;
  }, [roundStartTime]);

  useEffect(() => {
    clicksRef.current = clicks;
  }, [clicks]);

  useEffect(() => {
    multiplierRef.current = multiplier;
  }, [multiplier]);

  useEffect(() => {
    if (!roundId || !roundStartTime) return;
    const interval = setInterval(async () => {
      if (!roundIdRef.current) return;
      await fetch("/api/clicker/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roundId: roundIdRef.current,
          clientClicks: clicksRef.current,
          clientMultiplier: multiplierRef.current,
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
    multiplierRef.current = 1;
    setClicks(0);
    clicksRef.current = 0;
    setBusted(false);
    await refresh();
  }

  function clickRound() {
    if (!roundId) return;
    const nextClicks = clicksRef.current + 1;
    const failChance = bustChanceAtClick(nextClicks);
    if (Math.random() < failChance) {
      setClicks(nextClicks);
      clicksRef.current = nextClicks;
      const nextMultiplier = multiplierFromClicks(nextClicks);
      setMultiplier(nextMultiplier);
      multiplierRef.current = nextMultiplier;
      setBusted(true);
      setRoundId(null);
      setRoundStartTime(null);
      refresh();
      return;
    }

    setClicks(nextClicks);
    clicksRef.current = nextClicks;
    const nextMultiplier = multiplierFromClicks(nextClicks);
    setMultiplier(nextMultiplier);
    multiplierRef.current = nextMultiplier;
  }

  async function cashout() {
    const currentRoundId = roundIdRef.current;
    const currentRoundStartTime = roundStartTimeRef.current;
    if (!currentRoundId || currentRoundStartTime === null) return;
    const res = await fetch("/api/clicker/cashout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roundId: currentRoundId,
        clientClicks: clicksRef.current,
        clientMultiplier: multiplierRef.current,
        durationMs: Date.now() - currentRoundStartTime,
      }),
    });
   const data = await res.json();

if (!res.ok) {
  setBusted(true);
  setRoundId(null);
  return alert(data.error);
}

setClicks(data.clicks ?? 0);
setMultiplier(Number(data.multiplier ?? 1));
setBusted(data.busted ?? false);
setLastPayout(data.payout ? data.payout.toString() : "0");

setRoundId(null);
setRoundStartTime(null);

await refresh();
  }

  return (
    <main className="min-h-screen overflow-x-clip bg-black px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8 md:pt-24 md:px-8">
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto max-w-3xl rounded-2xl border border-fuchsia-500/40 bg-zinc-950 p-4 shadow-[0_0_40px_rgba(217,70,239,0.25)] sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-3xl font-bold text-fuchsia-400 sm:text-4xl">GoonBet Clicker</h1>
          <button
            onClick={() => router.push("/casino")}
            className="rounded-full border border-cyan-400/60 bg-cyan-400/10 px-4 py-2 text-sm font-bold text-cyan-200 shadow-[0_0_18px_rgba(34,211,238,0.25)] transition hover:bg-cyan-400 hover:text-black"
          >
            Return to Casino
          </button>
        </div>
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
          {lastPayout !== null && !roundId && (
            <p className="text-green-400 text-xl font-bold">Payout: {lastPayout} tokens</p>
          )}
          <p>Potential payout: {potentialPayout.toString()}</p>
          <p className="text-amber-300">
            Next click bust chance: {(bustChanceAtClick(clicks + 1) * 100).toFixed(2)}%
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
            <div key={r.id} className="text-sm bg-zinc-900 p-2 rounded border border-zinc-800">
              #{r.id} • bet {r.bet_amount} • {r.clicks} clicks • {r.multiplier.toFixed(4)}x •{" "}
              {r.status} • payout {r.payout}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
