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
  const [selectedTileByLane, setSelectedTileByLane] = useState({});

  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

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
  const [showCashoutPopup, setShowCashoutPopup] = useState(false);

  const difficultyConfig = useMemo(
    () => LANE_RUNNER_DIFFICULTIES[difficulty],
    [difficulty]
  );

const difficultyStyle = useMemo(() => {
  switch (difficulty) {
    case 'easy':
      return {
        glow: 'shadow-green-400/20',
        bg: 'bg-gradient-to-b from-green-950/40 to-slate-900',
        label: '🟢 SAFE ROUTE',
        road: 'border-green-400/30',
      };
    case 'medium':
      return {
        glow: 'shadow-yellow-400/20',
        bg: 'bg-gradient-to-b from-yellow-950/40 to-slate-900',
        label: '🟡 HIGHWAY',
        road: 'border-yellow-400/30',
      };
    case 'hard':
      return {
        glow: 'shadow-orange-500/30',
        bg: 'bg-gradient-to-b from-orange-950/40 to-slate-900',
        label: '🟠 DANGER ZONE',
        road: 'border-orange-500/30',
      };
    case 'extreme':
      return {
        glow: 'shadow-red-500/40',
        bg: 'bg-gradient-to-b from-red-950/50 to-black',
        label: '🔴 WAR ZONE',
        road: 'border-red-500/40 animate-pulse',
      };
  }
}, [difficulty]);

  const [showWinPopup, setShowWinPopup] = useState(false);
const [showLosePopup, setShowLosePopup] = useState(false);
const [popupData, setPopupData] = useState(null);

  // ---------------- BALANCE ----------------
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

  // ---------------- START GAME ----------------
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

  // ---------------- PICK TILE ----------------
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
      setError(json.error || 'Pick failed');
      setAnimatingTile(null);
      return;
    }

    const data = json.data;

    setSelectedTileByLane(prev => ({
      ...prev,
      [data.lane]: tileIndex,
    }));

    setSafeTilesByLane(prev => ({
      ...prev,
      [data.lane]: data.safeTiles || [],
    }));

    setMultiplier(data.multiplier);
    setPayout(Number(betAmount * (data.multiplier ?? multiplier)));
    setCurrentLane(data.currentLane ?? data.lane);

    setOutcomeSequence(prev => [...prev, data]);

    if (typeof data.newBalance === 'number') {
      setUserTokens(data.newBalance);
    }

    if (data.hasLost) {
      triggerLosePopup(data);
      setCrashLane(data.lane);
      setHasLost(true);
      setRunning(false);
      loseSoundRef.current?.play().catch(() => {});

      setHistory(prev => [
        {
          id: Date.now(),
          result: 'lost',
          lane: data.lane + 1,
          multiplier: data.multiplier,
          payout: 0,
        },
        ...prev,
      ].slice(0, 10));

      setAnimatingTile(null);
      return;
    }

    if (data.hasCashedOut) {
      triggerWinPopup(data);
      setHasCashedOut(true);
      setRunning(false);

      triggerWinPopup({
  payout: json.data.payout,
  multiplier: json.data.multiplier,
});

      setHistory(prev => [
        {
          id: Date.now(),
          result: 'cashed_out',
          lane: data.currentLane,
          multiplier: data.multiplier,
          payout: data.payout,
        },
        ...prev,
      ].slice(0, 10));

      setAnimatingTile(null);
      return;
    }

    winSoundRef.current?.play().catch(() => {});
    setTimeout(() => setAnimatingTile(null), 250);
  }

  // ---------------- CASHOUT ----------------
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

    setHistory(prev => [
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

  // ---------------- AUTOPLAY ----------------
  useEffect(() => {
    if (!autoplayEnabled || !running || hasLost || hasCashedOut) return;

    if (multiplier >= autoplayTarget) {
      cashOut();
      return;
    }

    const t = setTimeout(() => {
      pickTile(Math.floor(Math.random() * LANE_RUNNER_TILES));
    }, 450);

    return () => clearTimeout(t);
  }, [autoplayEnabled, running, hasLost, hasCashedOut, multiplier, autoplayTarget]);

  // ---------------- TILE STYLE ----------------
  function getTileClass(laneIndex, tileIndex) {
    const picked = selectedTileByLane[laneIndex] === tileIndex;
    const isSafe = safeTilesByLane[laneIndex]?.includes(tileIndex);
    const isActive = laneIndex === currentLane && running;

    if (picked && laneIndex === crashLane) return 'bg-red-600';
    if (picked && isSafe) return 'bg-emerald-500';
    if (picked) return 'bg-cyan-500';
    if (isSafe) return 'bg-emerald-900/70';
    if (isActive) return 'bg-slate-700 hover:bg-slate-600';

    return 'bg-slate-800';
  }

  // ================= UI =================
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-black pt-20 text-white">
      <NavigationBar currentPath="/casino/lane-runner" />

      <audio ref={winSoundRef} src="/sounds/coin-flip.mp3" />
      <audio ref={loseSoundRef} src="/sounds/coin-flip.mp3" />

      <div className="mx-auto flex max-w-7xl flex-col md:flex-row gap-6 px-4 pb-10">

        {/* LEFT PANEL */}
        <div className="w-full md:w-80 bg-slate-900/60 border border-cyan-500/30 p-4 rounded-xl">
          <h1 className="text-2xl font-bold text-yellow-300">Lane Runner 🐔</h1>

          <p className="text-sm mt-2">Balance: {isBalanceLoading ? '...' : userTokens.toFixed(2)}</p>

          <input className="w-full mt-3 p-2 bg-slate-950 border rounded"
            type="number"
            value={betAmount}
            onChange={(e) => setBetAmount(Number(e.target.value))}
          />

          <select className="w-full mt-3 p-2 bg-slate-950 border rounded"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
          >
            {Object.entries(LANE_RUNNER_DIFFICULTIES).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>

          <button onClick={startGame} disabled={running || isLoading}
            className="w-full mt-3 bg-cyan-500 text-black py-2 rounded">
            Start
          </button>

          <button onClick={cashOut} disabled={!running}
            className="w-full mt-2 bg-emerald-500 text-black py-2 rounded">
            Cash Out
          </button>

          <p className="mt-3 text-xs">Lane: {currentLane + 1}/{MAX_LANES}</p>
          <p className="text-xs">x{multiplier.toFixed(4)}</p>
          <p className="text-xs">Payout: {payout.toFixed(2)}</p>

          {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
        </div>

        {/* RIGHT PANEL (HORIZONTAL PROGRESSION FIX) */}
        <div className={`flex-1 border rounded-xl p-4 overflow-x-auto transition 
${difficultyStyle.bg} ${difficultyStyle.glow} ${difficultyStyle.road}`}>
          <h2 className="text-cyan-300 font-bold mb-4">Lane Progress</h2>
          <p className="text-xs mb-4 opacity-80">
  Mode: {difficultyStyle.label}
</p>

          <div className="flex gap-2">
            {Array.from({ length: MAX_LANES }).map((_, laneIndex) => {
              const isCurrent = laneIndex === currentLane;
              const isPassed = laneIndex < currentLane;
              const isCrash = laneIndex === crashLane;
              const isJackpot = laneIndex === MAX_LANES - 1;

              return (
                <div
  className={`
    w-16 h-10 relative rounded-md border transition-all duration-300
    ${isJackpot ? 'bg-gradient-to-r from-yellow-400 to-yellow-600 shadow-lg animate-pulse' : ''}
    ${isCrash ? 'bg-red-700' : ''}
    ${isPassed ? 'bg-emerald-600' : ''}
    ${isCurrent ? 'bg-cyan-500 scale-110 shadow-[0_0_12px_#22d3ee]' : ''}
    ${!isPassed && !isCurrent ? 'bg-slate-800' : ''}
  `}
>
  {/* ROAD MARKINGS */}
  <div className="absolute inset-0 flex items-center justify-center">
    <div className="w-full h-[2px] bg-white/20" />
  </div>

  {/* PLAYER / OBJECTS */}
  <div className="absolute inset-0 flex items-center justify-center">
    {isJackpot && <span className="text-xl">💰</span>}
    {isCurrent && !hasLost && !hasCashedOut && <span className="text-xl animate-bounce">🐔</span>}
    {isPassed && !isCurrent && <span className="text-lg">🛣️</span>}
    {isCrash && <span className="text-xl">🚗</span>}
  </div>
</div>
              );
            })}
          </div>

          <button
            onClick={() => pickTile(currentLane)}
            disabled={!running}
            className="mt-4 w-full bg-cyan-400 text-black py-3 rounded font-bold"
          >
            Step Forward
          </button>

          {/* HISTORY */}
          <div className="mt-6 text-xs">
            {history.map(h => (
              <p key={h.id}>
                {h.result} • lane {h.lane} • x{h.multiplier?.toFixed?.(4)} • {h.payout}
              </p>
            ))}
          </div>
        </div>

      </div>
      {/* WIN POPUP */}
{showWinPopup && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in">
    <div className="relative rounded-2xl bg-emerald-500 p-8 text-center shadow-2xl animate-bounce w-80">

      {/* CLOSE BUTTON */}
      <button
        onClick={() => {
          setShowWinPopup(false);
          setPopupData(null);
        }}
        className="absolute top-2 right-2 text-black text-lg font-bold hover:scale-110"
      >
        ✕
      </button>

      <h2 className="text-2xl font-bold">CASHED OUT!</h2>

      <p className="mt-2 text-black">
        +{popupData?.payout?.toFixed?.(2)} tokens
      </p>

      <p className="text-sm">
        x{popupData?.multiplier?.toFixed?.(2)}
      </p>

      {/* REPLAY BUTTON */}
      <button
        onClick={() => {
          setShowWinPopup(false);
          setPopupData(null);
          startGame();
        }}
        className="mt-4 w-full bg-black text-white py-2 rounded font-bold hover:bg-slate-800"
      >
        🔁 Replay
      </button>

    </div>
  </div>
)}

{/* LOSE POPUP */}
{showLosePopup && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 animate-fade-in">
    <div className="relative rounded-2xl bg-red-600 p-8 text-center shadow-2xl animate-pulse w-80">

      {/* CLOSE BUTTON */}
      <button
        onClick={() => {
          setShowLosePopup(false);
          setPopupData(null);
        }}
        className="absolute top-2 right-2 text-white text-lg font-bold hover:scale-110"
      >
        ✕
      </button>

      <h2 className="text-2xl font-bold">CRASHED!</h2>

      <p className="mt-2 text-white">
        You lost this run
      </p>

      <p className="text-sm opacity-80">
        lane {popupData?.lane + 1}
      </p>
    </div>
  </div>
)}
{/* CASHOUT POPUP */}
{showCashoutPopup && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 animate-fade-in">
    <div className="relative w-80 rounded-2xl bg-cyan-500 p-8 text-center shadow-2xl">

      {/* CLOSE */}
      <button
        onClick={() => {
          setShowCashoutPopup(false);
          setPopupData(null);
        }}
        className="absolute top-2 right-2 text-black text-lg font-bold hover:scale-110"
      >
        ✕
      </button>

      <h2 className="text-2xl font-bold">CASHED OUT</h2>

      <p className="mt-2 text-black">
        +{popupData?.payout?.toFixed?.(2)} tokens
      </p>

      <p className="text-sm text-black">
        x{popupData?.multiplier?.toFixed?.(2)}
      </p>

    </div>
  </div>
)}
    </div>
  );
}