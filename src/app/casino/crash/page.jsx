"use client";
import React, { useState, useEffect, useRef } from "react";
import BetPanel from "../../../components/BetPanel";
import PlayerList from "../../../components/PlayerList";
import Link from "next/link";

export default function Page() {
  const [multiplier, setMultiplier] = useState(1.0);
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

  const intervalRef = useRef(null);
  const countdownRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    if (gameRunning && !isCrashed) {
      intervalRef.current = setInterval(() => {
        setMultiplier((prev) =>
          parseFloat((prev + 0.01 * Math.pow(prev, 1.05)).toFixed(2))
        );
      }, 50);
    }
    return () => clearInterval(intervalRef.current);
  }, [gameRunning, isCrashed]);

  useEffect(() => {
    if (multiplier >= crashPoint && crashPoint !== 0) {
      crash();
    }
    if (hasBet && autoCashout <= multiplier && !cashedOut) {
      cashOut();
    }
    drawTrail();
  }, [multiplier]);

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
    setCountdown(5);
    setIsCountingDown(true);
  }

  function actuallyStartGame() {
    setMultiplier(1.0);
    setIsCrashed(false);
    setCrashPoint(generateCrashPoint());
    setGameRunning(true);
    setCashedOut(false);
    setFinalMultiplier(null);

    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
    }
  }

  function startGame() {
    initiateCountdown();
  }

  function resetBet() {
    setBetAmount("");
    setHasBet(false);
  }

  async function crash() {
    setIsCrashed(true);
    clearInterval(intervalRef.current);
    setGameRunning(false);

    const lossMultiplier = parseFloat(multiplier.toFixed(2));
    setCrashHistory((prev) => [lossMultiplier, ...prev.slice(0, 10)]);
    setFinalMultiplier(lossMultiplier);

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


  async function cashOut() {
    if (!gameRunning || isCrashed || cashedOut) return;

    setCashedOut(true);
    const winMultiplier = parseFloat(multiplier.toFixed(2));
    setFinalMultiplier(winMultiplier);
    clearInterval(intervalRef.current);
    setGameRunning(false);

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
    alert(`You cashed out at ${winMultiplier}x!`);
  }

  function generateCrashPoint() {
    const r = Math.random();
    if (r < 0.01) return (Math.random() * 50 + 10).toFixed(2);
    if (r < 0.1) return (Math.random() * 5 + 2).toFixed(2);
    return (Math.random() * 2 + 1).toFixed(2);
  }

  function drawTrail() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (gameRunning && !isCrashed) {
      ctx.strokeStyle = "white";
      ctx.lineWidth = 2;
      ctx.beginPath();
      const startX = 20;
      const startY = canvas.height - 20;
      const currentX = startX + multiplier * 20;
      const currentY = startY - multiplier * 15;

      ctx.moveTo(startX, startY);
      ctx.lineTo(currentX, currentY);
      ctx.stroke();
    }
  }

  return (
    <div className="min-h-screen bg-[#0e0e0e] text-white flex flex-col items-center p-4">
      <div className="mb-6">
        <a
          href="/casino"
          className="inline-flex items-center text-yellow-400 hover:text-yellow-300"
        >
          <svg className="w-6 h-6 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Retour au Casino
        </a>
      </div>

      <div className="flex flex-col lg:flex-row w-full max-w-7xl gap-4">
        {/* Left Panel - BetPanel + Crash History */}
        <div className="bg-[#1f1f1f] p-4 rounded-lg w-full lg:w-1/4 flex flex-col">
          <BetPanel
            placeBet={placeBet}
            hasBet={hasBet}
            gameRunning={gameRunning || isCountingDown}
            isCrashed={isCrashed}
            refreshTrigger={refreshCounter}
          />

          <div className="mt-6 pt-4 border-t border-gray-700">
            <h3 className="text-lg font-bold mb-3">Recent Crashes</h3>
            <div className="flex flex-wrap gap-2">
              {crashHistory.map((mult, index) => (
                <div
                  key={index}
                  className={`px-3 py-1 rounded-full text-sm font-bold ${
                    mult < 2 ? "bg-red-500" : mult < 5 ? "bg-green-500" : "bg-yellow-500"
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
        <div className="relative bg-[#1f1f1f] p-4 rounded-lg w-full lg:w-2/4 h-[600px] overflow-hidden flex items-center justify-center">
          {isCountingDown && (
            <div className="absolute inset-0 bg-black bg-opacity-60 z-50 flex items-center justify-center">
              <div className="text-8xl font-bold text-white animate-pulse">{countdown}</div>
            </div>
          )}

          <canvas ref={canvasRef} width={800} height={600} className="absolute bottom-0 left-0 z-0" />

          <div className="absolute right-2 top-0 bottom-0 flex flex-col justify-between z-10 py-6">
            {[100, 50, 20, 10, 5, 2, 1].map((value) => (
              <div key={value} className="text-sm text-gray-400">
                {value.toFixed(2)}x
              </div>
            ))}
          </div>

          {/* Rocket trail */}
          {gameRunning && !isCrashed && (
            <div
              className="absolute z-20"
              style={{
                left: `${Math.min(multiplier * 5, 80)}%`,
                bottom: `${Math.min(multiplier * 5, 80)}%`,
                transform: `translate(-50%, 50%) scale(${1 + multiplier / 20})`,
                transition: "left 0.2s linear, bottom 0.2s linear, transform 0.2s linear",
                opacity: 1,
              }}
            >
              <div className="text-6xl">🚀</div>
            </div>
          )}

          {(isCrashed || cashedOut) && (
            <div
              className="absolute z-20"
              style={{
                left: `${Math.min((finalMultiplier || multiplier) * 5, 80)}%`,
                bottom: `${Math.min((finalMultiplier || multiplier) * 5, 80)}%`,
                transform: `translate(-50%, 50%) scale(${1 + (finalMultiplier || multiplier) / 20})`,
                opacity: 0.4,
              }}
            >
              <div className="text-6xl">🚀</div>
              <div className="mt-2 font-bold bg-black bg-opacity-70 px-2 py-1 rounded text-center">
                {finalMultiplier?.toFixed(2)}x
              </div>
            </div>
          )}

          {isCrashed && <div className="absolute top-20 text-6xl">💥</div>}

          <div className="text-5xl font-bold z-30 mt-12">
            {isCrashed ? "CRASHED!" : `${multiplier.toFixed(2)}x`}
          </div>
        </div>

        {/* Right Panel */}
        <div className="bg-[#1f1f1f] p-4 rounded-lg w-full lg:w-1/4 flex flex-col">
          <div className="mb-6 flex flex-col gap-3">
            {!gameRunning && !isCountingDown && (
              <button
                onClick={startGame}
                className={`px-4 py-3 rounded-lg font-bold text-lg w-full ${
                  hasBet && betAmount && betAmount !== "0"
                    ? "bg-green-500 hover:bg-green-600"
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
                className="bg-gray-500 cursor-not-allowed px-4 py-3 rounded-lg font-bold text-lg w-full"
              >
                Starting in {countdown}...
              </button>
            )}
            {gameRunning && (
              <button
                onClick={cashOut}
                className="bg-yellow-500 hover:bg-yellow-600 px-4 py-3 rounded-lg font-bold text-lg w-full"
              >
                💰 Cash Out
              </button>
            )}
            <Link
              href="/casino"
              className="bg-blue-500 hover:bg-blue-600 px-4 py-3 rounded-lg font-bold text-lg text-center"
            >
              Return to Casino
            </Link>
          </div>

          <PlayerList
            hasBet={hasBet}
            betAmount={betAmount}
            cashedOut={cashedOut}
            multiplier={multiplier}
          />
        </div>
      </div>
    </div>
  );
}
