"use client";

import React, { useState, useEffect, useRef } from "react";
import NavigationBar from "../../../components/navigation-bar";

export default function RoulettePage() {
  const [betAmount, setBetAmount] = useState(10);
  const [selectedBets, setSelectedBets] = useState([]);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);
  const [userTokens, setUserTokens] = useState(0);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState({
    biggestWin: 0,
    totalBets: 0,
    totalWins: 0,
  });
  const [autoBet, setAutoBet] = useState({
    enabled: false,
    mode: "finite",
    spinsLeft: 0,
  });
  const [bets, setBets] = useState({});
  const [showRules, setShowRules] = useState(false);

  const canvasRef = useRef(null);
  const autoBetRef = useRef(autoBet);

  const rouletteNumbers = [
    0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5,
    24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
  ];
  const redNumbers = [
    1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
  ];

  useEffect(() => {
    async function fetchTokens() {
      setLoading(true);
      try {
        const res = await fetch("/api/get-user-tokens", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
        });
        const data = await res.json();
        if (data.success) setUserTokens(data.data.balance);
        else throw new Error(data.error || "Unknown error");
      } catch (err) {
        setError("Impossible de récupérer votre solde de tokens");
      } finally {
        setLoading(false);
      }
    }
    fetchTokens();
  }, []);

  useEffect(() => {
    autoBetRef.current = autoBet;
  }, [autoBet]);

  // Draw wheel with numbers and triangle pointer
  const drawWheel = (angleOffset = 0) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const size = canvas.width;
    const radius = size / 2;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(radius, radius);
    ctx.rotate(angleOffset); // Rotate whole wheel by angleOffset

    const segmentAngle = (2 * Math.PI) / rouletteNumbers.length;
    rouletteNumbers.forEach((num, i) => {
      const startAngle = i * segmentAngle;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, startAngle, startAngle + segmentAngle);
      ctx.fillStyle =
        num === 0 ? "#0f0" : redNumbers.includes(num) ? "#c00" : "#000";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.stroke();

      // number text
      ctx.save();
      ctx.fillStyle = "#fff";
      ctx.rotate(startAngle + segmentAngle / 2);
      ctx.textAlign = "right";
      ctx.font = "bold 14px sans-serif";
      ctx.fillText(num.toString(), radius - 10, 5);
      ctx.restore();
    });

    ctx.restore();
  };

  useEffect(() => {
    drawWheel();
    const onResize = () => drawWheel();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const spinWheel = (finalIndex) => {
    return new Promise((resolve) => {
      const totalSegments = rouletteNumbers.length;
      const fullRotations = 6;
      const segmentAngle = (2 * Math.PI) / totalSegments;

      // Fixed final angle aligned to center of target segment (no randomness)
      const initialSegment0Offset = Math.PI / 2; // 90 degrees in radians

      const finalAngle =
        (totalSegments - finalIndex - 0.5) * segmentAngle -
        initialSegment0Offset;

      const totalAngle = fullRotations * 2 * Math.PI + finalAngle;
      const duration = 4000;
      const start = performance.now();

      const animate = (now) => {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        drawWheel(eased * totalAngle);
        if (progress < 1) requestAnimationFrame(animate);
        else resolve();
      };
      requestAnimationFrame(animate);
    });
  };

  const handleBetClick = (bet) => {
    setSelectedBets((prev) =>
      prev.includes(bet) ? prev.filter((b) => b !== bet) : [...prev, bet],
    );
  };

  const handleSpin = async () => {
    const totalBetAmount = Object.values(bets).reduce((a, b) => a + b, 0);
    if (spinning || totalBetAmount === 0) return;
    if (totalBetAmount > userTokens) {
      setError("Solde insuffisant pour cette mise");
      return;
    }

    setSpinning(true);
    setError(null);

    const response = await fetch("/api/roulette/save-game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bets }),
    });
    const data = await response.json();
    if (!response.ok || !data?.success) {
      setError(data?.error || "Erreur lors du spin");
      setSpinning(false);
      return;
    }

    await spinWheel(data.data.spinResultIndex);
    setUserTokens(Number(data.data.newBalance));
    setResult({
      number: data.data.spinResult,
      win: data.data.win,
      amount: data.data.amount,
    });
    setHistory((prev) => [data.data.spinResult, ...prev].slice(0, 10));
    setStats((prev) => ({
      biggestWin: data.data.win
        ? Math.max(prev.biggestWin, data.data.amount)
        : prev.biggestWin,
      totalBets: prev.totalBets + 1,
      totalWins: data.data.win ? prev.totalWins + 1 : prev.totalWins,
    }));
    setBets({});
    setSelectedBets([]);

    setSpinning(false);

    // Auto-bet continuation
    const currentAuto = autoBetRef.current;
    if (currentAuto && currentAuto.enabled) {
      if (currentAuto.mode === "finite") {
        if (currentAuto.spinsLeft > 1) {
          setAutoBet((prev) => ({ ...prev, spinsLeft: prev.spinsLeft - 1 }));
          setTimeout(() => handleSpin(), 1200);
        } else {
          setAutoBet((prev) => ({ ...prev, enabled: false }));
        }
      } else if (currentAuto.mode === "infinite") {
        setTimeout(() => handleSpin(), 1200);
      }
    }
  };

  const placeBet = (target) => {
    const amount = betAmount || 1; // Use current bet input as coin value
    setBets((prev) => ({
      ...prev,
      [target]: (prev[target] || 0) + amount,
    }));
  };

  const resetBets = () => {
    setBets({});
    setSelectedBets([]);
    setError(null); // optionally clear errors on reset
  };

  const renderNumberGrid = () => {
    const rows = [[], [], []];
    for (let i = 1; i <= 36; i++) {
      rows[(i - 1) % 3].push(i);
    }
    return (
      <div className="space-y-2">
        {rows.map((row, idx) => (
          <div key={idx} className="flex gap-1 justify-center">
            {row.map((num) => {
              const isRed = redNumbers.includes(num);
              const isBlack = !isRed; // for roulette numbers 1-36, black if not red
              return (
                <div key={num} className="relative">
                  <button
                    onClick={() => placeBet(num)}
                    className={`w-10 h-10 flex items-center justify-center rounded-lg border border-[#FFFF33]/40 text-sm font-medium
transition-all duration-150
${
  isRed
    ? "bg-red-600/80 text-white shadow-[0_0_10px_rgba(255,0,0,0.4)]"
    : "bg-black text-[#FFFF33] shadow-[0_0_10px_rgba(255,255,51,0.3)]"
}
hover:scale-105 hover:brightness-110 active:scale-95`}
                  >
                    {num}
                  </button>
                  {bets[num] && (
                    <span className="absolute -top-2 -right-2 bg-[#FFFF33]/80 text-[#000] border border-[#FFFF33]/40 shadow-[0_0_10px_rgba(255,255,51,0.4)] text-xs font-bold px-1.5 py-0.5 rounded-full border shadow-lg">
                      {bets[num]}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="min-h-screen flex bg-gradient-to-br from-[#001933] to-[#000d1a] text-white overflow-hidden">
      <NavigationBar currentPath="/casino" />
      {/* Container with responsive flex */}
      <div className="flex flex-col sm:flex-row gap-10 p-6 w-full max-w-[1200px] mx-auto mt-12">
        {/* Left sidebar */}
        <div className="flex flex-col items-start gap-6 w-full sm:w-[280px] flex-shrink-0">
          {/* Title below Retour au Casino */}
          <h1 className="text-3xl font-bold text-[#FFFF33] drop-shadow-[0_0_10px_rgba(255,255,51,0.6)] text-center w-full mt-3">
            🎰 Roulette Royale
          </h1>
          {/* Tokens display */}
          <span
            className="inline-block px-6 bg-[#FFFF33]/20 border border-[#FFFF33]/40 text-[#fffec7]
shadow-[0_0_12px_rgba(255,255,51,0.5)] py-2 rounded-full font-extrabold shadow-lg text-lg border-2"
          >
            Tokens: {userTokens}
          </span>

          {/* AutoBet controls */}
          <div className="bg-[#001933] p-4 rounded-lg border border-[#FFFF33]/30 w-full backdrop-blur-md shadow-[0_0_20px_rgba(255,255,51,0.15)]">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={autoBet.enabled}
                onChange={(e) =>
                  setAutoBet((prev) => ({ ...prev, enabled: e.target.checked }))
                }
              />
              Auto Bet
            </label>

            {autoBet.enabled && (
              <div className="mt-3 flex items-center gap-3 flex-wrap">
                <select
                  value={autoBet.mode}
                  onChange={(e) =>
                    setAutoBet((prev) => ({ ...prev, mode: e.target.value }))
                  }
                  className="px-2 py-1 rounded border border border-[#00e5ff]/30 bg-[#091737] text-white focus:border-[#00e5ff] focus:ring-1 focus:ring-[#00e5ff]"
                >
                  <option value="finite">Finite</option>
                  <option value="infinite">Infinite</option>
                </select>

                {autoBet.mode === "finite" && (
                  <input
                    type="number"
                    min="1"
                    value={autoBet.spinsLeft}
                    onChange={(e) =>
                      setAutoBet((prev) => ({
                        ...prev,
                        spinsLeft: Number(e.target.value),
                      }))
                    }
                    className="w-36 px-2 py-1 rounded border border border-[#00e5ff]/30 bg-[#091737] text-white focus:border-[#00e5ff] focus:ring-1 focus:ring-[#00e5ff]text-white"
                    placeholder="Number of spins"
                  />
                )}

                <button
                  onClick={() =>
                    setAutoBet((prev) => ({ ...prev, enabled: true }))
                  }
                  className="px-4 py-1 rounded bg-yellow-400 text-black font-bold"
                >
                  Start
                </button>
                <button
                  onClick={() =>
                    setAutoBet((prev) => ({ ...prev, enabled: false }))
                  }
                  className="px-4 py-1 rounded bg-red-500 text-white font-bold"
                >
                  Stop
                </button>
              </div>
            )}
          </div>

          {/* Bet amount input and Spin button stacked vertically */}
          <div className="flex flex-col gap-2 w-full">
            Montant
            <input
              type="number"
              min="1"
              value={betAmount}
              onChange={(e) => setBetAmount(Number(e.target.value))}
              className="w-full rounded bg-[#001933] border border-[#FFFF33]/30 focus:border-[#FFFF33] focus:ring-1 focus:ring-[#FFFF33] px-2 py-1 text-white"
            />
            <button
              onClick={handleSpin}
              disabled={spinning}
              className={`mt-3 px-6 py-2 rounded-full font-bold border border-[#FFFF33]/40 ${
                spinning
                  ? "bg-gray-600"
                  : "bg-[#FFFF33]/20 text-[#FFFF33] hover:bg-[#FFFF33]/35 shadow-[0_0_15px_rgba(255,255,51,0.5)]"
              }`}
            >
              {spinning ? "La roue tourne..." : "Tourner la Roue!"}
            </button>
            <button
              onClick={resetBets}
              disabled={spinning}
              className="mt-2 px-6 py-2 rounded-full font-bold border border-red-500/40 text-red-400 hover:bg-red-500/20 hover:text-red-200 transition shadow-[0_0_10px_rgba(255,0,0,0.4)]"
            >
              Réinitialiser les mises
            </button>
            {/* Rules Toggle */}
            <div className="w-full mt-4">
              <button
                onClick={() => setShowRules(!showRules)}
                className="w-full flex items-center justify-between px-4 py-3 bg-[#FFFF33]/20 text-[#FFFF33] font-bold rounded-lg border border-[#FFFF33]/40 shadow-[0_0_15px_rgba(255,255,51,0.4)] hover:bg-[#FFFF33]/35 transition"
              >
                <span>🎰 Game Rules</span>
                <span className="text-xl">{showRules ? "▲" : "▼"}</span>
              </button>

              {/* 👇 Fixed-height container = no layout shift */}
              {showRules && (
                <div className="mt-3 bg-[#020617] border border-[#FFFF33]/30 rounded-xl p-4 text-white shadow-[0_0_25px_rgba(255,255,51,0.15)] text-sm leading-relaxed max-h-64 overflow-y-auto backdrop-blur-md">
                  <h2 className="text-lg font-bold text-yellow-400 mb-3 text-center">
                    🎰 How to Play Roulette
                  </h2>
                  <p className="text-xs text-gray-400 mt-1 text-center mb-1">
                    Scroll to read all rules
                  </p>
                  <div className="space-y-4">
                    <div>
                      <h3 className="text-yellow-400 font-semibold">
                        🎯 Objective
                      </h3>
                      <p>
                        Predict where the ball will land on the spinning wheel.
                      </p>
                    </div>

                    <div>
                      <h3 className="text-yellow-400 font-semibold">🎲 Bets</h3>
                      <ul className="list-disc ml-5">
                        <li>Single number (x35)</li>
                        <li>Red / Black / Even / Odd (x2)</li>
                        <li>Ranges (x3)</li>
                      </ul>
                    </div>

                    <div>
                      <h3 className="text-yellow-400 font-semibold">⚠️ Rule</h3>
                      <p>0 (green) loses most bets.</p>
                    </div>

                    <div>
                      <h3 className="text-yellow-400 font-semibold">💡 Tips</h3>
                      <ul className="list-disc ml-5">
                        <li>Safer bets win more often</li>
                        <li>High-risk bets pay more</li>
                        <li>Manage your balance wisely</li>
                      </ul>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Result message */}
          {result && (
            <div className="mt-4 w-full bg-[#020617] p-3 rounded border border-[#FFFF33]/30 text-center text-[#FFFF33] font-bold shadow-[0_0_15px_rgba(255,255,51,0.3)]">
              Résultat:{" "}
              <span className="text-yellow-300 font-extrabold">
                {result.number}
              </span>
              {result.win ? ` - Gagné ${result.amount} tokens! 🎉` : " - Perdu"}
            </div>
          )}
        </div>

        {/* Right side (roulette + numbers + betting zones) */}
        <div className="flex flex-col items-center w-full sm:w-[680px] flex-shrink-0">
          <div className="relative mx-auto mt-5 w-full max-w-[360px] h-[400px] sm:w-[360px] sm:h-[400px]">
            <canvas
              ref={canvasRef}
              width={360}
              height={360}
              className="rounded-full shadow-[0_0_100px_rgba(255,255,51,0.25)]"
            />

            {/* SVG pointer above the wheel */}
            <svg
              width="40"
              height="20"
              viewBox="0 0 40 20"
              style={{
                position: "absolute",
                top: -20,
                left: "50%",
                transform: "translateX(-50%)",
                pointerEvents: "none",
                zIndex: 10,
              }}
            >
              <defs>
                <linearGradient id="goldGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#FFD700" />
                  <stop offset="100%" stopColor="#B8860B" />
                </linearGradient>
              </defs>
              <polygon
                points="20,20 40,0 0,0"
                fill="url(#goldGradient)"
                stroke="#B8860B"
                strokeWidth="1"
              />
            </svg>
          </div>

          <div className="w-full px-2">{renderNumberGrid()}</div>

          <div className=" mt-3 flex flex-wrap gap-2 justify-center w-full px-2">
            {[
              "1-12",
              "13-24",
              "25-36",
              "1-18",
              "even",
              "red",
              "black",
              "odd",
              "19-36",
              "green",
            ].map((zone) => (
              <button
                key={zone}
                onClick={() => placeBet(zone)}
                className={`relative px-3 py-2 rounded border border-[#FFFF33]/40 text-sm font-bold capitalize
    ${
      zone === "red"
        ? "bg-red-600"
        : zone === "black"
          ? "bg-black"
          : zone === "green"
            ? "bg-green-500"
            : "bg-[#102542]"
    }
    ${bets[zone] ? "ring-2 ring-[#FFFF33] shadow-[0_0_15px_rgba(255,255,51,0.6)]" : ""}`}
              >
                {zone}
                {bets[zone] && (
                  <span className="absolute -top-2 -right-2 text-xs bg-[#FFFF33]/80 text-[black] border border-[#FFFF33]/40 shadow-[0_0_10px_rgba(255,255,51,0.4)] font-bold px-1.5 py-0.5 rounded-full border shadow-lg">
                    {bets[zone]}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
