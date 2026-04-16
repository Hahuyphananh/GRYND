"use client";

import React, { useEffect, useMemo, useRef, useState } from 'react';
import NavigationBar from '../../../components/navigation-bar';

const MAX_LANES = 12;
const LANE_RUNNER_TILES = 24;
const LANE_RUNNER_DIFFICULTIES = {
  easy: { label: 'Easy', pFail: 0.04, safeTiles: 8 },
  medium: { label: 'Medium', pFail: 0.12, safeTiles: 6 },
  hard: { label: 'Hard', pFail: 0.2, safeTiles: 4 },
  extreme: { label: 'Extreme', pFail: 0.4, safeTiles: 2 },
};

export default function LaneRunnerPage() {
  const [betAmount, setBetAmount] = useState(10);
  const [difficulty, setDifficulty] = useState('easy');
  const [clientSeed, setClientSeed] = useState(`client-${Date.now()}`);
  const [currentLane, setCurrentLane] = useState(0);
  const [multiplier, setMultiplier] = useState(1);
  const [payout, setPayout] = useState(0);
  const [hasLost, setHasLost] = useState(false);
  const [hasCashedOut, setHasCashedOut] = useState(false);
  const [outcomeSequence, setOutcomeSequence] = useState([]);
  const [safeTilesByLane, setSafeTilesByLane] = useState({});
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedTileByLane, setSelectedTileByLane] = useState({});
  const [fairData, setFairData] = useState(null);
  const [history, setHistory] = useState([]);
  const [autoplayTarget, setAutoplayTarget] = useState(2);
  const [autoplayEnabled, setAutoplayEnabled] = useState(false);
  const [userTokens, setUserTokens] = useState(0);
  const [isBalanceLoading, setIsBalanceLoading] = useState(false);
  const [animatingTile, setAnimatingTile] = useState(null);
  const [crashLane, setCrashLane] = useState(null);

  const loseSoundRef = useRef(null);
  const winSoundRef = useRef(null);

  const difficultyConfig = useMemo(() => LANE_RUNNER_DIFFICULTIES[difficulty], [difficulty]);

  useEffect(() => {
    fetchUserTokens();
  }, []);

  async function fetchUserTokens() {
    setIsBalanceLoading(true);
    try {
      const res = await fetch('/api/get-user-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const json = await res.json();
      if (res.ok && json.success) {
        setUserTokens(Number(json.data.balance));
      }
    } catch (fetchErr) {
      console.error('Failed to fetch user tokens', fetchErr);
    } finally {
      setIsBalanceLoading(false);
    }
  }

  async function startGame() {
    setIsLoading(true);
    setError('');
    setHasLost(false);
    setHasCashedOut(false);
    setCurrentLane(0);
    setMultiplier(1);
    setPayout(Number(betAmount));
    setSelectedTileByLane({});
    setSafeTilesByLane({});
    setOutcomeSequence([]);
    setCrashLane(null);

    const res = await fetch('/api/lane-runner/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ action: 'start', betAmount, difficulty, clientSeed }),
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
      setError(json.error || 'Unable to start game');
      setRunning(false);
      setIsLoading(false);
      return;
    }

    setRunning(true);
    setPayout(json.data.potentialPayout);
    setUserTokens(Number(json.data.newBalance ?? userTokens));
    setFairData({
      clientSeed: json.data.clientSeed,
      serverSeedHash: json.data.serverSeedHash,
      nonce: json.data.nonce,
    });
    setIsLoading(false);
  }

  async function pickTile(tileIndex) {
    if (!running || hasLost || hasCashedOut || isLoading) return;
    setIsLoading(true);
    setAnimatingTile(`${currentLane}-${tileIndex}`);

    const res = await fetch('/api/lane-runner/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ action: 'pick', tileIndex }),
    });
    const json = await res.json();
    setIsLoading(false);

    if (!res.ok || !json.success) {
      setAnimatingTile(null);
      setError(json.error || 'Pick failed');
      return;
    }

    const data = json.data;
    setSelectedTileByLane((prev) => ({ ...prev, [data.lane]: tileIndex }));
    setSafeTilesByLane((prev) => ({ ...prev, [data.lane]: data.safeTiles || [] }));
    setMultiplier(data.multiplier);
    setPayout(data.payout ?? 0);
    setCurrentLane(data.currentLane ?? data.lane);
    setFairData(data.fair);
    setOutcomeSequence((prev) => [...prev, data]);

    if (typeof data.newBalance === 'number') {
      setUserTokens(data.newBalance);
    }

    if (data.hasLost) {
      setCrashLane(data.lane);
      setHasLost(true);
      setRunning(false);
      loseSoundRef.current?.play().catch(() => {});
      setHistory((prev) => [{ id: Date.now(), result: 'lost', lane: data.lane + 1, payout: 0, multiplier: data.multiplier }, ...prev].slice(0, 10));
      setAnimatingTile(null);
      return;
    }

    if (data.hasCashedOut) {
      setHasCashedOut(true);
      setRunning(false);
      if (typeof data.newBalance === 'number') {
        setUserTokens(data.newBalance);
      }
      setHistory((prev) => [{ id: Date.now(), result: 'completed', lane: data.currentLane, payout: data.payout, multiplier: data.multiplier }, ...prev].slice(0, 10));
      setAnimatingTile(null);
      return;
    }

    winSoundRef.current?.play().catch(() => {});
    setTimeout(() => setAnimatingTile(null), 300);
  }

  async function cashOut() {
    if (!running || hasLost || hasCashedOut) return;
    setIsLoading(true);

    const res = await fetch('/api/lane-runner/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ action: 'cashout' }),
    });

    const json = await res.json();
    setIsLoading(false);

    if (!res.ok || !json.success) {
      setError(json.error || 'Cashout failed');
      return;
    }

    setHasCashedOut(true);
    setRunning(false);
    setMultiplier(json.data.multiplier);
    setPayout(json.data.payout);
    setFairData(json.data.fair);
    setUserTokens(Number(json.data.newBalance ?? userTokens));
    setHistory((prev) => [{ id: Date.now(), result: 'cashed_out', lane: currentLane, payout: json.data.payout, multiplier: json.data.multiplier }, ...prev].slice(0, 10));
  }

  useEffect(() => {
    if (!autoplayEnabled || !running || hasLost || hasCashedOut) return;

    if (multiplier >= autoplayTarget) {
      cashOut();
      return;
    }

    const timer = setTimeout(() => {
      const pick = Math.floor(Math.random() * LANE_RUNNER_TILES);
      pickTile(pick);
    }, 500);

    return () => clearTimeout(timer);
  }, [autoplayEnabled, running, hasLost, hasCashedOut, multiplier, autoplayTarget]);

  function getTileClass(laneIndex, tileIndex) {
    const picked = selectedTileByLane[laneIndex] === tileIndex;
    const isSafeReveal = Array.isArray(safeTilesByLane[laneIndex]) && safeTilesByLane[laneIndex].includes(tileIndex);
    const isActiveLane = laneIndex === currentLane && running && !hasLost && !hasCashedOut;

    if (picked && laneIndex === crashLane) {
      return 'bg-red-600 border-red-300 lane-runner-tile-shake';
    }

    if (picked && isSafeReveal) {
      return 'bg-emerald-500 border-emerald-200 lane-runner-hop';
    }

    if (picked) {
      return 'bg-cyan-500 border-cyan-200 lane-runner-hop';
    }

    if (isSafeReveal) {
      return 'bg-emerald-900/70 border-emerald-600';
    }

    if (isActiveLane) {
      return 'bg-slate-700 border-cyan-400 hover:bg-slate-600 hover:scale-105';
    }

    return 'bg-slate-800 border-slate-600';
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-black pt-20 text-white">
      <NavigationBar currentPath="/casino/lane-runner" />
      <audio src="/sounds/coin-flip.mp3" ref={winSoundRef} preload="auto" />
      <audio src="/sounds/coin-flip.mp3" ref={loseSoundRef} preload="auto" />

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 pb-10 md:flex-row">
        <div className="w-full rounded-xl border border-cyan-500/30 bg-slate-900/60 p-4 md:w-80">
          <h1 className="mb-4 text-2xl font-bold text-yellow-300">Lane Runner 🐔</h1>
          <p className="mb-2 text-sm text-cyan-100">Cross lanes and cash out before a car wipes you out.</p>
          <p className="mb-3 text-sm text-yellow-200">Balance: {isBalanceLoading ? 'Loading...' : userTokens.toFixed(2)} tokens</p>

          <label className="mb-1 block text-sm">Bet Amount</label>
          <input
            className="mb-3 w-full rounded border border-slate-600 bg-slate-950 px-3 py-2"
            type="number"
            min="1"
            value={betAmount}
            onChange={(e) => setBetAmount(Math.max(1, Number(e.target.value) || 1))}
          />

          <label className="mb-1 block text-sm">Difficulty</label>
          <select className="mb-3 w-full rounded border border-slate-600 bg-slate-950 px-3 py-2" value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
            {Object.entries(LANE_RUNNER_DIFFICULTIES).map(([key, cfg]) => (
              <option key={key} value={key}>{cfg.label} ({Math.round(cfg.pFail * 100)}% fail)</option>
            ))}
          </select>

          <label className="mb-1 block text-sm">Client Seed</label>
          <input className="mb-3 w-full rounded border border-slate-600 bg-slate-950 px-3 py-2" value={clientSeed} onChange={(e) => setClientSeed(e.target.value)} />

          <label className="mb-1 block text-sm">Auto cashout at x</label>
          <input className="mb-3 w-full rounded border border-slate-600 bg-slate-950 px-3 py-2" type="number" min="1" step="0.1" value={autoplayTarget} onChange={(e) => setAutoplayTarget(Number(e.target.value) || 1)} />

          <div className="mb-3 flex items-center gap-2">
            <input id="autoplay" type="checkbox" checked={autoplayEnabled} onChange={(e) => setAutoplayEnabled(e.target.checked)} />
            <label htmlFor="autoplay" className="text-sm">Enable auto-play</label>
          </div>

          <button disabled={isLoading || running || betAmount > userTokens} onClick={startGame} className="mb-2 w-full rounded bg-cyan-500 px-3 py-2 font-semibold text-black disabled:opacity-50">Start Run</button>
          <button disabled={!running || hasLost || hasCashedOut || isLoading} onClick={cashOut} className="w-full rounded bg-emerald-500 px-3 py-2 font-semibold text-black disabled:opacity-50">Cash Out</button>

          {betAmount > userTokens && <p className="mt-2 text-xs text-red-400">Insufficient tokens for this bet.</p>}

          <div className="mt-4 space-y-1 text-sm">
            <p>Current lane: <b>{Math.min(currentLane + 1, MAX_LANES)}</b> / {MAX_LANES}</p>
            <p>Current multiplier: <b>x{multiplier.toFixed(4)}</b></p>
            <p>Potential payout: <b>{payout.toFixed(2)}</b></p>
            <p>Failure rate: <b>{(difficultyConfig.pFail * 100).toFixed(0)}%</b></p>
            <p>Displayed safe tiles per lane: <b>{difficultyConfig.safeTiles}</b></p>
          </div>

          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

          <div className="mt-4 rounded border border-slate-700 bg-slate-950/70 p-2 text-xs">
            <p className="font-semibold text-cyan-200">Provably fair</p>
            <p className="truncate">Client seed: {fairData?.clientSeed || '-'}</p>
            <p className="truncate">Server seed hash: {fairData?.serverSeedHash || '-'}</p>
            <p className="truncate">Nonce: {fairData?.nonce || '-'}</p>
            {fairData?.serverSeed && <p className="truncate text-emerald-300">Server seed: {fairData.serverSeed}</p>}
          </div>
        </div>

        <div className="flex-1 rounded-xl border border-slate-700 bg-slate-900/40 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xl font-bold text-cyan-300">Lane Grid</h2>
            {hasLost && (
              <div className="rounded bg-red-700 px-3 py-1 text-sm font-semibold text-white lane-runner-car-hit">🚗💥 The chicken got run over!</div>
            )}
            {hasCashedOut && (
              <div className="rounded bg-emerald-700 px-3 py-1 text-sm font-semibold text-white">✅ Cashed out safely</div>
            )}
          </div>

          <div className="space-y-2">
            {Array.from({ length: MAX_LANES }).map((_, laneIndex) => (
              <div key={laneIndex} className="rounded border border-slate-700 bg-slate-950/60 p-2">
                <div className="mb-1 text-xs text-slate-300">Lane {laneIndex + 1}</div>
                <div className="grid grid-cols-8 gap-1 md:grid-cols-12">
                  {Array.from({ length: LANE_RUNNER_TILES }).map((_, tileIndex) => (
                    <button
                      key={`${laneIndex}-${tileIndex}`}
                      onClick={() => (laneIndex === currentLane ? pickTile(tileIndex) : null)}
                      disabled={laneIndex !== currentLane || !running || hasLost || hasCashedOut || isLoading}
                      className={`relative h-8 rounded border text-[10px] transition-all duration-200 ${getTileClass(laneIndex, tileIndex)} ${animatingTile === `${laneIndex}-${tileIndex}` ? 'ring-2 ring-yellow-300' : ''}`}
                      title={`Lane ${laneIndex + 1} - Tile ${tileIndex + 1}`}
                    >
                      {selectedTileByLane[laneIndex] === tileIndex ? '🐔' : ''}
                      {laneIndex === crashLane && selectedTileByLane[laneIndex] === tileIndex && (
                        <span className="absolute inset-0 flex items-center justify-center text-base">🚗</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 rounded border border-slate-700 bg-slate-950/50 p-3">
            <h3 className="mb-2 text-sm font-semibold text-yellow-300">Recent Runs</h3>
            <div className="space-y-1 text-xs">
              {history.length === 0 && <p className="text-slate-400">No runs yet.</p>}
              {history.map((item) => (
                <p key={item.id} className="text-slate-200">
                  {item.result} • lane {item.lane} • x{Number(item.multiplier).toFixed(4)} • payout {Number(item.payout).toFixed(2)}
                </p>
              ))}
            </div>
          </div>

          <div className="mt-4 rounded border border-slate-700 bg-slate-950/50 p-3 text-xs text-slate-300">
            <p>Math: multiplier_n = RTP / (p_survive^n), with RTP = 0.96 and p_survive = 1 - p_fail.</p>
            <p>State trace entries: {outcomeSequence.length}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
