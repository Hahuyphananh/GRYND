"use client";

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import NavigationBar from '../../../components/navigation-bar';
import GameTrack from './components/GameTrack';
import {
  DEFAULT_LANES,
  LANE_RUNNER_DIFFICULTIES,
  LANE_RUNNER_TILES,
  getMultiplier,
} from '../../../lib/laneRunner';

const MAX_LANES = DEFAULT_LANES;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const [selectedTileByLane, setSelectedTileByLane] = useState({});
  const [aimTile, setAimTile] = useState(Math.floor(LANE_RUNNER_TILES / 2));

  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const [fairData, setFairData] = useState(null);
  const [history, setHistory] = useState([]);

  const [autoplayTarget, setAutoplayTarget] = useState(2);
  const [autoplayEnabled, setAutoplayEnabled] = useState(false);

  const [userTokens, setUserTokens] = useState(0);
  const [isBalanceLoading, setIsBalanceLoading] = useState(false);

  const [crashLane, setCrashLane] = useState(null);

  const loseSoundRef = useRef(null);
  const winSoundRef = useRef(null);
  const [showCashoutPopup, setShowCashoutPopup] = useState(false);
  const [showWinPopup, setShowWinPopup] = useState(false);
  const [showLosePopup, setShowLosePopup] = useState(false);
  const [popupData, setPopupData] = useState(null);

  const difficultyConfig = useMemo(() => LANE_RUNNER_DIFFICULTIES[difficulty], [difficulty]);

  const laneMultipliers = useMemo(
    () => Array.from({ length: MAX_LANES }, (_, lane) => getMultiplier(lane + 1, difficultyConfig.pFail, difficulty)),
    [difficultyConfig.pFail, difficulty]
  );

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
    } catch (e) {
      console.error(e);
    } finally {
      setIsBalanceLoading(false);
    }
  }

  async function startGame() {
    setIsLoading(true);
    setError('');
    setHasLost(false);
    setHasCashedOut(false);
    setShowCashoutPopup(false);
    setShowWinPopup(false);
    setShowLosePopup(false);

    setCurrentLane(0);
    setMultiplier(1);
    setPayout(Number(betAmount));

    setSelectedTileByLane({});
    setSafeTilesByLane({});
    setOutcomeSequence([]);
    setCrashLane(null);
    setAimTile(Math.floor(LANE_RUNNER_TILES / 2));

    const res = await fetch('/api/lane-runner/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        action: 'start',
        betAmount,
        difficulty,
        clientSeed,
      }),
    });

    const json = await res.json();

    if (!res.ok || !json.success) {
      setError(json.error || 'Unable to start game');
      setRunning(false);
      setIsLoading(false);
      return;
    }

    setRunning(true);
    setPayout(Number(betAmount * json.data.multiplier || betAmount));
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

    const res = await fetch('/api/lane-runner/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ action: 'pick', tileIndex }),
    });

    const json = await res.json();
    await delay(220);
    setIsLoading(false);

    if (!res.ok || !json.success) {
      setError(json.error || 'Pick failed');
      return;
    }

    const data = json.data;

    setSelectedTileByLane((prev) => ({
      ...prev,
      [data.lane]: tileIndex,
    }));

    setSafeTilesByLane((prev) => ({
      ...prev,
      [data.lane]: data.safeTiles || [],
    }));

    setMultiplier(data.multiplier);
    setPayout(Number(betAmount * (data.multiplier ?? multiplier)));
    setCurrentLane(data.currentLane ?? data.lane);
    setOutcomeSequence((prev) => [...prev, data]);

    if (typeof data.newBalance === 'number') {
      setUserTokens(data.newBalance);
    }

    if (data.hasLost) {
      triggerLosePopup(data);
      setCrashLane(data.lane);
      setHasLost(true);
      setRunning(false);
      loseSoundRef.current?.play().catch(() => {});

      setHistory((prev) => [
        {
          id: Date.now(),
          result: 'lost',
          lane: data.lane + 1,
          multiplier: data.multiplier,
          payout: 0,
        },
        ...prev,
      ].slice(0, 10));
      return;
    }

    if (data.hasCashedOut) {
      triggerWinPopup(data);
      setHasCashedOut(true);
      setRunning(false);
      setShowCashoutPopup(true);

      setHistory((prev) => [
        {
          id: Date.now(),
          result: 'cashed_out',
          lane: data.currentLane,
          multiplier: data.multiplier,
          payout: data.payout,
        },
        ...prev,
      ].slice(0, 10));
      return;
    }

    winSoundRef.current?.play().catch(() => {});
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

    setPopupData({
      payout: json.data.payout,
      multiplier: json.data.multiplier,
    });

    setShowCashoutPopup(true);
    setMultiplier(json.data.multiplier);
    setPayout(Number(json.data.payout || betAmount * json.data.multiplier || 0));
    setUserTokens(Number(json.data.newBalance ?? userTokens));

    setHistory((prev) => [
      {
        id: Date.now(),
        result: 'cashed_out',
        lane: currentLane,
        multiplier: json.data.multiplier,
        payout: json.data.payout,
      },
      ...prev,
    ].slice(0, 10));
  }

  function triggerWinPopup(data) {
    setPopupData(data);
    setShowWinPopup(true);
  }

  function triggerLosePopup(data) {
    setPopupData(data);
    setShowLosePopup(true);
  }

  function pickByLaneClick(laneIndex, event) {
    if (laneIndex !== currentLane) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const pct = Math.min(0.999, Math.max(0, (event.clientY - rect.top) / rect.height));
    const tileIndex = Math.floor(pct * LANE_RUNNER_TILES);
    setAimTile(tileIndex);
    pickTile(tileIndex);
  }

  function stepForward() {
    pickTile(aimTile);
  }

  useEffect(() => {
    if (!autoplayEnabled || !running || hasLost || hasCashedOut) return;

    if (multiplier >= autoplayTarget) {
      cashOut();
      return;
    }

    const t = setTimeout(() => {
      pickTile(Math.floor(Math.random() * LANE_RUNNER_TILES));
    }, 600);

    return () => clearTimeout(t);
  }, [autoplayEnabled, running, hasLost, hasCashedOut, multiplier, autoplayTarget]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#050716] via-[#080c27] to-black pt-20 text-white">
      <NavigationBar currentPath="/casino/lane-runner" />
      <audio ref={winSoundRef} src="/sounds/coin-flip.mp3" />
      <audio ref={loseSoundRef} src="/sounds/coin-flip.mp3" />

      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 pb-10 md:flex-row">
        <div className="w-full rounded-xl border border-cyan-400/20 bg-slate-900/70 p-4 md:w-80">
          <h1 className="text-2xl font-black text-cyan-200">Lane Runner: Mission Style</h1>
          <p className="mt-2 text-sm">Balance: {isBalanceLoading ? '...' : userTokens.toFixed(2)}</p>

          <label className="mt-3 block text-xs uppercase text-white/60">Bet Amount</label>
          <input
            className="w-full rounded border border-white/15 bg-slate-950 p-2"
            type="number"
            min={1}
            value={betAmount}
            onChange={(e) => setBetAmount(Number(e.target.value))}
          />

          <label className="mt-3 block text-xs uppercase text-white/60">Difficulty</label>
          <select
            className="w-full rounded border border-white/15 bg-slate-950 p-2"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
          >
            {Object.entries(LANE_RUNNER_DIFFICULTIES).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>

          <label className="mt-3 block text-xs uppercase text-white/60">Client Seed</label>
          <input
            className="w-full rounded border border-white/15 bg-slate-950 p-2 text-xs"
            value={clientSeed}
            onChange={(e) => setClientSeed(e.target.value)}
          />

          <button
            onClick={startGame}
            disabled={running || isLoading}
            className="mt-3 w-full rounded bg-cyan-500 py-2 font-bold text-black transition hover:bg-cyan-400 disabled:opacity-60"
          >
            {isLoading && !running ? 'Starting...' : 'Start Run'}
          </button>

          <button
            onClick={stepForward}
            disabled={!running || isLoading}
            className="mt-2 w-full rounded bg-zinc-200 py-2 font-bold text-black transition hover:bg-white disabled:opacity-60"
          >
            Step Forward
          </button>

          <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
            <p className="rounded bg-black/30 p-2">Lane: {currentLane + 1}/{MAX_LANES}</p>
            <p className="rounded bg-black/30 p-2">x{multiplier.toFixed(4)}</p>
            <p className="col-span-2 rounded bg-black/30 p-2">Payout: {payout.toFixed(2)}</p>
          </div>

          <div className="mt-4 space-y-2 rounded bg-black/25 p-2 text-xs">
            <label className="flex items-center justify-between gap-2">
              <span>Autoplay</span>
              <input type="checkbox" checked={autoplayEnabled} onChange={(e) => setAutoplayEnabled(e.target.checked)} />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span>Auto cashout at</span>
              <input
                type="number"
                min="1"
                step="0.1"
                className="w-24 rounded bg-slate-900 p-1"
                value={autoplayTarget}
                onChange={(e) => setAutoplayTarget(Number(e.target.value))}
              />
            </label>
          </div>

          {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
          {fairData && <p className="mt-2 text-[11px] text-white/50">Fair nonce: {fairData.nonce}</p>}
        </div>

        <div className="flex-1">
          <GameTrack
            lanes={Array.from({ length: MAX_LANES }, (_, i) => i)}
            currentLane={currentLane}
            currentMultiplier={multiplier}
            running={running}
            hasLost={hasLost}
            hasCashedOut={hasCashedOut}
            crashLane={crashLane}
            laneMultipliers={laneMultipliers}
            onAttemptLane={(laneIndex, event) => pickByLaneClick(laneIndex, event)}
            onCashout={cashOut}
          />

          <motion.div className="mt-4 rounded-xl border border-white/10 bg-black/25 p-3 text-xs" layout>
            <p className="mb-2 text-sm font-semibold text-cyan-200">Recent Runs</p>
            {history.length === 0 && <p className="text-white/50">No runs yet.</p>}
            {history.map((h) => (
              <p key={h.id} className="border-b border-white/10 py-1 last:border-0">
                {h.result} • lane {h.lane} • x{h.multiplier?.toFixed?.(4)} • {h.payout}
              </p>
            ))}
          </motion.div>
        </div>
      </div>

      {showWinPopup && (
        <PopupShell tone="emerald" title="CASHED OUT!" onClose={() => setShowWinPopup(false)}>
          <p className="mt-2 text-black">+{popupData?.payout?.toFixed?.(2)} tokens</p>
          <p className="text-sm text-black">x{popupData?.multiplier?.toFixed?.(2)}</p>
        </PopupShell>
      )}

      {showLosePopup && (
        <PopupShell tone="red" title="CRASHED!" onClose={() => setShowLosePopup(false)}>
          <p className="mt-2 text-white">You lost this run.</p>
          <p className="text-sm text-white/85">Lane {popupData?.lane + 1}</p>
        </PopupShell>
      )}

      {showCashoutPopup && (
        <PopupShell tone="cyan" title="CASHED OUT" onClose={() => setShowCashoutPopup(false)}>
          <p className="mt-2 text-black">+{popupData?.payout?.toFixed?.(2)} tokens</p>
          <p className="text-sm text-black">x{popupData?.multiplier?.toFixed?.(2)}</p>
        </PopupShell>
      )}
    </div>
  );
}

function PopupShell({ title, children, tone, onClose }) {
  const palette = {
    red: 'bg-red-600 text-white',
    cyan: 'bg-cyan-500 text-black',
    emerald: 'bg-emerald-500 text-black',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <motion.div
        initial={{ opacity: 0, scale: 0.86, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className={`relative w-80 rounded-2xl p-8 text-center shadow-2xl ${palette[tone]}`}
      >
        <button onClick={onClose} className="absolute right-2 top-2 text-lg font-bold">
          ✕
        </button>
        <h2 className="text-2xl font-bold">{title}</h2>
        {children}
      </motion.div>
    </div>
  );
}
