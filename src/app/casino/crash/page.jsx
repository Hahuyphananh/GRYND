"use client";
import React, { useState, useEffect, useRef } from "react";
import BetPanel from "../../../components/BetPanel";
import PlayerList from "../../../components/PlayerList";
import Link from "next/link";
import NavigationBar from "../../../components/navigation-bar";

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const GRAPH_PADDING = 40;
const GROWTH_RATE = 0.33;
const UI_MULTIPLIER_UPDATE_MS = 80;
const TRAIL_FADE_ALPHA = 0.12;

export default function Page() {
  const [displayMultiplier, setDisplayMultiplier] = useState(1.0);
  const [isCrashed, setIsCrashed] = useState(false);
  const [gameRunning, setGameRunning] = useState(false);
  const [crashPoint, setCrashPoint] = useState(0);
  const [betAmount, setBetAmount] = useState("");
  const [autoCashout, setAutoCashout] = useState(2.0);
  const [hasBet, setHasBet] = useState(false);
  const [cashedOut, setCashedOut] = useState(false);
  const [crashHistory, setCrashHistory] = useState([]);
  const [finalMultiplier, setFinalMultiplier] = useState(null);
  const [countdown, setCountdown] = useState(0);
  const [isCountingDown, setIsCountingDown] = useState(false);
  const [refreshCounter, setRefreshCounter] = useState(0);
  const [showCashoutPopup, setShowCashoutPopup] = useState(false);
  const [cashoutPopupMultiplier, setCashoutPopupMultiplier] = useState(null);
  const fixedMaxMultiplierRef = useRef(2);
  const [showRules, setShowRules] = useState(false);

  const countdownRef = useRef(null);
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const betStateRef = useRef({ hasBet: false, autoCashout: 0, cashedOut: false });
  const animationStateRef = useRef({
    startTime: 0,
    currentMultiplier: 1,
    displayMultiplier: 1,
    crashPoint: 0,
    curvePoints: [],
    crashed: false,
    crashAt: null,
    crashCanvasPoint: null,
    explosionProgress: 0,
    lastUiUpdateAt: 0,
  });

  useEffect(() => {
    betStateRef.current = { hasBet, autoCashout, cashedOut };
  }, [hasBet, autoCashout, cashedOut]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    drawCanvasFrame(performance.now());
  }, []);

  useEffect(() => {
    if (isCountingDown && countdown > 0) {
      countdownRef.current = setTimeout(() => {
        setCountdown((prev) => prev - 1);
      }, 1000);
    } else if (isCountingDown && countdown === 0) {
      setIsCountingDown(false);
      actuallyStartGame();
    }
    return () => clearTimeout(countdownRef.current);
  }, [isCountingDown, countdown]);

  function initiateCountdown() {
    if (!hasBet || !betAmount || betAmount === "0") {
      alert("You must place a bet before starting the game!");
      return;
    }
    setCountdown(3);
    setIsCountingDown(true);
  }

  function actuallyStartGame() {
    const generatedCrashPoint = generateCrashPoint();
    const startTime = performance.now();

fixedMaxMultiplierRef.current = Math.max(autoCashout || 2, 2);

    setDisplayMultiplier(1.0);
    setIsCrashed(false);
    setCrashPoint(generatedCrashPoint);
    setGameRunning(true);
    setCashedOut(false);
    setFinalMultiplier(null);
    setShowCashoutPopup(false);
    setCashoutPopupMultiplier(null);

    animationStateRef.current = {
      startTime,
      currentMultiplier: 1,
      displayMultiplier: 1,
      crashPoint: generatedCrashPoint,
      curvePoints: [{ x: GRAPH_PADDING, y: CANVAS_HEIGHT - GRAPH_PADDING }],
      crashed: false,
      crashAt: null,
      crashCanvasPoint: null,
      explosionProgress: 0,
      lastUiUpdateAt: 0,
    };

    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(animationLoop);
  }

  function startGame() {
    initiateCountdown();
  }

  function resetBet() {
    setBetAmount("");
    setHasBet(false);
  }

  async function crash() {
    const state = animationStateRef.current;
    const lossMultiplier = parseFloat(state.currentMultiplier.toFixed(2));
    const crashCanvasPoint = toCanvasPoint(lossMultiplier);

    setIsCrashed(true);
    setGameRunning(false);
    setDisplayMultiplier(lossMultiplier);
    setCrashHistory((prev) => [lossMultiplier, ...prev.slice(0, 10)]);
    setFinalMultiplier(lossMultiplier);
    setCrashPoint(state.crashPoint);

    animationStateRef.current = {
      ...state,
      crashed: true,
      crashAt: performance.now(),
      crashCanvasPoint,
      explosionProgress: 0,
    };

    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(drawFrozenCrashFrame);

    try {
      const res = await fetch("/api/crash/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          betAmount: parseFloat(betAmount),
          multiplier: lossMultiplier,
          gameWon: false,
        }),
      });

      await res.json(); // even if not used, consume the response
    } catch (err) {
      console.error("Crash loss network error:", err);
    }

    setRefreshCounter((prev) => prev + 1); // 🔁 trigger BetPanel to refresh
    resetBet();
  }

 async function placeBet(amount, autoCashoutValue) {
  setBetAmount(amount.toString());
  setAutoCashout(autoCashoutValue);
  setHasBet(true);
  setCashedOut(false);

  try {
    const res = await fetch("/api/crash/settle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        betAmount: amount,
        multiplier: 0,
        gameWon: false,
        immediateDeduct: true
      }),
    });
    const data = await res.json();
    if (data.success) {
      setRefreshCounter(prev => prev + 1);
    }
  } catch (err) {
    console.error("Error deducting on bet:", err);
  }
}


  async function settleCashOut(cashoutMultiplier) {
    const state = animationStateRef.current;
    if (state.crashed || betStateRef.current.cashedOut) return;

    betStateRef.current = { ...betStateRef.current, cashedOut: true };
    setCashedOut(true);
    const winMultiplier = parseFloat(cashoutMultiplier.toFixed(2));
    setFinalMultiplier(winMultiplier);
    setGameRunning(false);
    setDisplayMultiplier(winMultiplier);

    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    animationStateRef.current = { ...state, crashed: true };
    drawCanvasFrame(performance.now());

    try {
      const res = await fetch("/api/crash/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          betAmount: parseFloat(betAmount),
          multiplier: winMultiplier,
          gameWon: true,
        }),
      });

      await res.json();
    } catch (err) {
      console.error("Crash win network error:", err);
    }

    setRefreshCounter((prev) => prev + 1);
    resetBet();
    setCashoutPopupMultiplier(winMultiplier);
    setShowCashoutPopup(true);
  }

  async function cashOut() {
    if (!gameRunning || isCrashed || cashedOut) return;
    await settleCashOut(animationStateRef.current.currentMultiplier);
  }

  function generateCrashPoint() {
    const r = Math.random();
    if (r < 0.01) return parseFloat((Math.random() * 50 + 10).toFixed(2));
    if (r < 0.1) return parseFloat((Math.random() * 5 + 2).toFixed(2));
    return parseFloat((Math.random() * 2 + 1).toFixed(2));
  }

function toCanvasPoint(mult) {
  const maxX = CANVAS_WIDTH - GRAPH_PADDING;
  const minX = GRAPH_PADDING;
  const maxY = CANVAS_HEIGHT - GRAPH_PADDING;
  const minY = GRAPH_PADDING;

  const state = animationStateRef.current;

  // ✅ FIXED X progression (time-based, NOT tied to crash)
  const elapsed = Math.log(Math.max(mult, 1.0001)) / GROWTH_RATE;

  const MAX_TIME = 8; // seconds to reach right side (tweak this)
  const progress = Math.min(elapsed / MAX_TIME, 1);

  const x = minX + progress * (maxX - minX);

  // ✅ FIXED Y scale (based on autoCashout)
  const maxMultiplier = fixedMaxMultiplierRef.current;

  const normalized = (mult - 1) / (maxMultiplier - 1);
  const y = maxY - Math.max(0, Math.min(1, normalized)) * (maxY - minY);

  return { x, y };
}

  function getCurveColor(mult) {
    if (mult < 2) return "#22c55e";
    if (mult < 5) return "#facc15";
    return "#ef4444";
  }

  function drawGrid(ctx) {
    ctx.save();
    ctx.strokeStyle = "rgba(148, 163, 184, 0.18)";
    ctx.lineWidth = 1;
    for (let x = GRAPH_PADDING; x <= CANVAS_WIDTH - GRAPH_PADDING; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, GRAPH_PADDING);
      ctx.lineTo(x, CANVAS_HEIGHT - GRAPH_PADDING);
      ctx.stroke();
    }
    for (let y = GRAPH_PADDING; y <= CANVAS_HEIGHT - GRAPH_PADDING; y += 40) {
      ctx.beginPath();
      ctx.moveTo(GRAPH_PADDING, y);
      ctx.lineTo(CANVAS_WIDTH - GRAPH_PADDING, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawSmoothCurve(ctx, points, mult) {
    if (points.length < 2) return;
    const gradient = ctx.createLinearGradient(0, CANVAS_HEIGHT, CANVAS_WIDTH, 0);
    gradient.addColorStop(0, "#22c55e");
    gradient.addColorStop(0.55, "#facc15");
    gradient.addColorStop(1, "#ef4444");

    ctx.strokeStyle = gradient;
    ctx.lineWidth = 4;
    ctx.shadowColor = getCurveColor(mult);
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    for (let i = 1; i < points.length - 1; i += 1) {
      const xc = (points[i].x + points[i + 1].x) / 2;
      const yc = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }

    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function drawCrashExplosion(ctx, point, progress) {
    if (!point) return;
    const radius = 20 + progress * 70;
    const alpha = Math.max(0, 0.75 - progress * 0.75);
    const explosionGradient = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
    explosionGradient.addColorStop(0, `rgba(239, 68, 68, ${alpha})`);
    explosionGradient.addColorStop(0.4, `rgba(239, 68, 68, ${alpha * 0.5})`);
    explosionGradient.addColorStop(1, "rgba(239, 68, 68, 0)");
    ctx.fillStyle = explosionGradient;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawCanvasFrame(now) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const state = animationStateRef.current;

    if (state.curvePoints.length <= 1) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(2, 6, 23, 1)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawGrid(ctx);
      return;
    }

    ctx.fillStyle = `rgba(2, 6, 23, ${TRAIL_FADE_ALPHA})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawGrid(ctx);
    drawSmoothCurve(ctx, state.curvePoints, state.currentMultiplier);

    const last = state.curvePoints[state.curvePoints.length - 1];
    ctx.fillStyle = getCurveColor(state.currentMultiplier);
    ctx.shadowColor = getCurveColor(state.currentMultiplier);
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(last.x, last.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    if (state.crashed && state.crashCanvasPoint) {
      const progress = Math.min((now - state.crashAt) / 700, 1);
      state.explosionProgress = progress;
      drawCrashExplosion(ctx, state.crashCanvasPoint, progress);
    }
  }

  function drawFrozenCrashFrame(now) {
    drawCanvasFrame(now);
    const { explosionProgress } = animationStateRef.current;
    if (explosionProgress < 1) {
      rafRef.current = requestAnimationFrame(drawFrozenCrashFrame);
    }
  }

  function animationLoop(now) {
    const state = animationStateRef.current;
    const elapsedSeconds = (now - state.startTime) / 1000;
    const deterministicMultiplier = Math.exp(GROWTH_RATE * elapsedSeconds);
    const roundedMultiplier = parseFloat(deterministicMultiplier.toFixed(4));
    const didCrash = roundedMultiplier >= state.crashPoint;

    state.currentMultiplier = didCrash ? state.crashPoint : roundedMultiplier;
    state.displayMultiplier = parseFloat(state.currentMultiplier.toFixed(2));
    const currentPoint = toCanvasPoint(state.currentMultiplier);
    state.curvePoints.push(currentPoint);
    if (state.curvePoints.length > 450) {
      state.curvePoints.shift();
    }

    if (now - state.lastUiUpdateAt > UI_MULTIPLIER_UPDATE_MS) {
      state.lastUiUpdateAt = now;
      setDisplayMultiplier(state.displayMultiplier);
    }

    drawCanvasFrame(now);

    const liveBetState = betStateRef.current;
    if (
      liveBetState.hasBet &&
      liveBetState.autoCashout <= state.currentMultiplier &&
      !liveBetState.cashedOut
    ) {
      settleCashOut(state.currentMultiplier);
      return;
    }

    if (didCrash) {
      crash();
      return;
    }

    rafRef.current = requestAnimationFrame(animationLoop);
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#001933] to-[#000d1a] text-white flex flex-col items-center p-4">
 <NavigationBar currentPath="/casino" />
      <div className="flex flex-col lg:flex-row w-full max-w-7xl gap-4 mt-16">
        {/* Left Panel - BetPanel + Crash History */}
        <div className="bg-[#0b224f]/85 border border-[#00e5ff]/30 shadow-[0_0_18px_rgba(0,229,255,0.18)] p-4 rounded-lg w-full lg:w-1/4 flex flex-col">
          <BetPanel
            placeBet={placeBet}
            hasBet={hasBet}
            gameRunning={gameRunning || isCountingDown}
            isCrashed={isCrashed}
            refreshTrigger={refreshCounter}
          />

          <div className="mt-6 pt-4 border-t border-[#00e5ff]/25">
            <h3 className="text-lg font-bold mb-3">Recent Crashes</h3>
            <div className="flex flex-wrap gap-2">
              {crashHistory.map((mult, index) => (
                <div
                  key={index}
                  className={`px-3 py-1 rounded-full text-sm font-bold ${
                    mult < 2 ? "bg-red-500" : mult < 5 ? "bg-[#00e5ff] text-[#001933]" : "bg-[#FFD700] text-[#030817]"
                  }`}
                >
                  {mult}x
                </div>
              ))}
              {crashHistory.length === 0 && (
                <div className="text-gray-400 text-sm">No history yet</div>
              )}
            </div>
          </div>
        </div>

        {/* Center */}
<div className="relative bg-[#0b224f]/85 border border-[#00e5ff]/30 shadow-[0_0_18px_rgba(0,229,255,0.18)] p-4 rounded-lg w-full lg:w-2/4 h-[600px] overflow-hidden flex items-center justify-center">

  {/* Space background (NEW — does not affect anything else) */}
  <div className="absolute inset-0 space-bg" />

          {isCountingDown && (
            <div className="absolute inset-0 bg-black bg-opacity-60 z-50 flex items-center justify-center">
              <div className="text-8xl font-bold text-white animate-pulse">{countdown > 0 ? countdown : "GO"}</div>
            </div>
          )}

          <canvas ref={canvasRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} className="absolute bottom-0 left-0 z-0" />

        <div className="absolute right-2 top-0 bottom-0 flex flex-col justify-between z-10 py-6">
  {(() => {
    const maxMultiplier = fixedMaxMultiplierRef.current;
    const steps = 6;

    return Array.from({ length: steps + 1 }, (_, i) => {
      const value = 1 + ((maxMultiplier - 1) * (steps - i)) / steps;

      return (
        <div key={i} className="text-sm text-gray-400">
          {value.toFixed(2)}x
        </div>
      );
    });
  })()} 
</div>

          {isCrashed && <div className="absolute top-20 text-6xl">💥</div>}

          <div className="text-5xl font-bold z-30 mt-12">
            {isCrashed ? "CRASHED!" : `${displayMultiplier.toFixed(2)}x`}
          </div>
        </div>

        {/* Right Panel */}
        <div className="bg-[#0b224f]/85 border border-[#00e5ff]/30 shadow-[0_0_18px_rgba(0,229,255,0.18)] p-4 rounded-lg w-full lg:w-1/4 flex flex-col">
          <div className="mb-6 flex flex-col gap-3">
            {!gameRunning && !isCountingDown && (
              <button
                onClick={startGame}
                className={`px-4 py-3 rounded-lg font-bold text-lg w-full ${
                  hasBet && betAmount && betAmount !== "0"
                    ? "bg-[#FFD700] text-[#030817] hover:bg-[#ffe14f] shadow-[0_0_16px_rgba(255,215,0,0.45)]"
                    : "bg-gray-500 cursor-not-allowed"
                }`}
                disabled={!hasBet || !betAmount || betAmount === "0"}
              >
                {!hasBet || !betAmount || betAmount === "0"
                  ? "Place Bet First"
                  : isCrashed
                  ? "Start New Game"
                  : "Start Game"}
              </button>
            )}
            {isCountingDown && (
              <button
                disabled
                className="bg-[#3a4852] cursor-not-allowed px-4 py-3 rounded-lg font-bold text-lg w-full"
              >
                Starting in {countdown}...
              </button>
            )}
            {gameRunning && (
              <button
                onClick={cashOut}
                className="bg-[#00e5ff] text-[#001933] hover:bg-[#49eeff] px-4 py-3 rounded-lg font-bold text-lg w-full shadow-[0_0_14px_rgba(0,229,255,0.4)]"
              >
                💰 Cash Out
              </button>
            )}
            <Link
              href="/casino"
              className="bg-[#FFD700] hover:bg-[#ffe14f] text-[#030817] px-4 py-3 rounded-lg font-bold text-lg text-center shadow-[0_0_14px_rgba(255,215,0,0.45)]"
            >
              Return to Casino
            </Link>
          </div>

          <PlayerList
            hasBet={hasBet}
            betAmount={betAmount}
            cashedOut={cashedOut}
            multiplier={displayMultiplier}
          />
        </div>
      </div>

      {showCashoutPopup && cashoutPopupMultiplier !== null && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center px-4">
          <div className="bg-[#08142f] border border-[#00e5ff]/40 rounded-xl p-6 text-center w-full max-w-sm shadow-[0_0_20px_rgba(0,229,255,0.22)]">
            <h3 className="text-2xl font-bold text-[#FFD700] mb-2">Cash Out Successful</h3>
            <p className="text-lg mb-6">You cashed out at {cashoutPopupMultiplier.toFixed(2)}x.</p>
            <button
              onClick={() => setShowCashoutPopup(false)}
              className="bg-[#FFD700] hover:bg-[#ffe14f] px-4 py-2 rounded-lg font-bold text-[#030817]"
            >
              Close
            </button>
          </div>
        </div>
      )}
                {/* Rules Section */}
<div className="mt-4 bg-[#08142f] rounded-lg border border-[#00e5ff]/30 shadow-[0_0_14px_rgba(0,229,255,0.15)]">
  <button
    onClick={() => setShowRules((prev) => !prev)}
    className="w-full flex justify-between items-center px-4 py-2 font-bold text-[#FFD700]"
  >
    📜 Crash Rules
    <span>{showRules ? "▲" : "▼"}</span>
  </button>

  {showRules && (
    <div className="px-4 pb-4 text-sm text-gray-300 space-y-2">
      <p>
        🚀 The multiplier starts at <strong>1.00x</strong> and increases over time.
      </p>
      <p>
        💥 The game can <strong>crash at any moment</strong> — if it crashes before you cash out, you lose your bet.
      </p>
      <p>
        💰 Click <strong>Cash Out</strong> before the crash to secure your winnings.
      </p>
      <p>
        ⚙️ You can set an <strong>auto cashout</strong> to automatically exit at a chosen multiplier.
      </p>
      <p>
        📈 The longer you wait, the higher the multiplier… but the higher the risk.
      </p>
    </div>
  )}
</div>
    </div>
  );
}
