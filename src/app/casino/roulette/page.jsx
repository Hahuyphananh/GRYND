"use client";

import React, { useState, useEffect, useRef } from "react";

export default function RoulettePage() {
  const [betAmount, setBetAmount] = useState(10);
  const [selectedBets, setSelectedBets] = useState([]);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);
  const [userTokens, setUserTokens] = useState(0);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState({ biggestWin: 0, totalBets: 0, totalWins: 0 });
  const [autoBet, setAutoBet] = useState({ enabled: false, mode: "finite", spinsLeft: 0 });

  const canvasRef = useRef(null);
  const autoBetRef = useRef(autoBet);

  const rouletteNumbers = [
    0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23,
    10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
  ];
  const redNumbers = [
    1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
  ];

  useEffect(() => {
    async function fetchTokens() {
      setLoading(true);
      try {
        const res = await fetch("/api/get-user-tokens", { method: "POST" });
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
  ctx.rotate(angleOffset);  // Rotate whole wheel by angleOffset

  const segmentAngle = (2 * Math.PI) / rouletteNumbers.length;
  rouletteNumbers.forEach((num, i) => {
    const startAngle = i * segmentAngle;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius, startAngle, startAngle + segmentAngle);
    ctx.fillStyle = num === 0 ? "#0f0" : redNumbers.includes(num) ? "#c00" : "#000";
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
      const finalAngle = (totalSegments - finalIndex - 0.5) * segmentAngle;

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
      prev.includes(bet) ? prev.filter((b) => b !== bet) : [...prev, bet]
    );
  };

  const handleSpin = async () => {
    if (spinning || selectedBets.length === 0) return;
    if (betAmount > userTokens) {
      setError("Solde insuffisant pour cette mise");
      return;
    }
    setSpinning(true);
    setError(null);

    const spinResultIndex = Math.floor(Math.random() * rouletteNumbers.length);
    const spinResult = rouletteNumbers[spinResultIndex];
    await spinWheel(spinResultIndex);

    let win = false;
    let winAmount = 0;

    selectedBets.forEach((bet) => {
      if (typeof bet === "number" && bet === spinResult) {
        win = true;
        winAmount += betAmount * 35;
      }
      if (bet === "red" && redNumbers.includes(spinResult)) {
        win = true;
        winAmount += betAmount * 2;
      }
      if (bet === "black" && spinResult !== 0 && !redNumbers.includes(spinResult)) {
        win = true;
        winAmount += betAmount * 2;
      }
      if (bet === "green" && spinResult === 0) {
        win = true;
        winAmount += betAmount * 35;
      }
      if (bet === "even" && spinResult % 2 === 0 && spinResult !== 0) {
        win = true;
        winAmount += betAmount * 2;
      }
      if (bet === "odd" && spinResult % 2 === 1) {
        win = true;
        winAmount += betAmount * 2;
      }
      if (bet === "1-12" && spinResult >= 1 && spinResult <= 12) {
        win = true;
        winAmount += betAmount * 3;
      }
      if (bet === "13-24" && spinResult >= 13 && spinResult <= 24) {
        win = true;
        winAmount += betAmount * 3;
      }
      if (bet === "25-36" && spinResult >= 25 && spinResult <= 36) {
        win = true;
        winAmount += betAmount * 3;
      }
      if (bet === "1-18" && spinResult >= 1 && spinResult <= 18) {
        win = true;
        winAmount += betAmount * 2;
      }
      if (bet === "19-36" && spinResult >= 19 && spinResult <= 36) {
        win = true;
        winAmount += betAmount * 2;
      }
    });

    // Deduct bet cost
    await fetch("/api/tokens/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: -betAmount * selectedBets.length }),
    });
    setUserTokens((prev) => prev - betAmount * selectedBets.length);

    // Credit win if any
    if (win) {
      await fetch("/api/tokens/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: winAmount }),
      });
      setUserTokens((prev) => prev + winAmount);
    }

    setResult({ number: spinResult, win, amount: winAmount });
    setHistory((prev) => [spinResult, ...prev].slice(0, 10));
    setStats((prev) => ({
      biggestWin: win ? Math.max(prev.biggestWin, winAmount) : prev.biggestWin,
      totalBets: prev.totalBets + 1,
      totalWins: win ? prev.totalWins + 1 : prev.totalWins,
    }));

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

  const renderNumberGrid = () => {
    const rows = [[], [], []];
    for (let i = 1; i <= 36; i++) {
      rows[(i - 1) % 3].push(i);
    }
    return (
      <div className="space-y-2">
        {rows.map((row, idx) => (
          <div key={idx} className="flex gap-1 justify-center">
            {row.map((num) => (
              <div
                key={num}
                onClick={() => handleBetClick(num)}
                className={`w-10 h-10 flex items-center justify-center rounded cursor-pointer border border-yellow-400 font-bold text-sm
                  ${num === 0 ? "bg-green-500" : redNumbers.includes(num) ? "bg-red-600" : "bg-black"}
                  ${selectedBets.includes(num) ? "ring-2 ring-yellow-300" : ""}`}
              >
                {num}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#001933] to-[#000d1a] text-white">
      <div className="container mx-auto py-6 px-4">
        <div className="grid grid-cols-3 items-center mb-6">
          <div>
            <a
              href="/casino"
              className="inline-flex items-center text-yellow-400 hover:text-yellow-300 transition"
            >
              <svg
                className="w-6 h-6 mr-2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10 19l-7-7m0 0l7-7m-7 7h18"
                />
              </svg>
              Retour au Casino
            </a>
          </div>

          <h1 className="text-3xl font-bold text-yellow-400 text-center">
            🎰 Roulette Royale
          </h1>

          <div className="flex justify-end">
            <span className="inline-block bg-gradient-to-r from-yellow-400 via-yellow-300 to-yellow-500 text-black px-6 py-2 rounded-full font-extrabold shadow-lg text-lg border-2 border-yellow-400">
              Tokens: {userTokens}
            </span>
          </div>
        </div>

       <div style={{ position: "relative", width: 360, height: 400, margin: "0 auto" }}>
  <canvas
    ref={canvasRef}
    width={360}
    height={360}
    className="rounded-full"
  />
  
  {/* SVG pointer above the wheel */}
  <svg
    width="40"
    height="20"
    viewBox="0 0 40 20"
    style={{
      position: "absolute",
      top: -20,  // 20px above the canvas top edge
      left: "50%",
      transform: "translateX(-50%)",
      pointerEvents: "none", // allows clicks to pass through
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


        {renderNumberGrid()}

        <div className="mt-4 flex flex-wrap gap-2 justify-center">
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
              onClick={() => handleBetClick(zone)}
              className={`px-3 py-2 rounded border border-yellow-400 text-sm font-bold capitalize
                ${
                  zone === "red"
                    ? "bg-red-600"
                    : zone === "black"
                    ? "bg-black"
                    : zone === "green"
                    ? "bg-green-500"
                    : "bg-[#102542]"
                }
                ${selectedBets.includes(zone) ? "ring-2 ring-yellow-300" : ""}`}
            >
              {zone}
            </button>
          ))}
        </div>

        <div className="mt-6 flex gap-4 justify-center items-center">
          <input
            type="number"
            min="1"
            value={betAmount}
            onChange={(e) => setBetAmount(Number(e.target.value))}
            className="w-24 rounded border-2 border-yellow-400 bg-[#102542] text-white px-2 py-1"
          />
          <button
            onClick={handleSpin}
            disabled={spinning}
            className={`px-6 py-2 rounded-full font-bold border-2 border-yellow-400 ${
              spinning
                ? "bg-gray-600"
                : "bg-yellow-400 text-black hover:bg-yellow-300"
            }`}
          >
            {spinning ? "La roue tourne..." : "Tourner la Roue!"}
          </button>
        </div>

        <div className="mt-6 flex justify-center">
          <div className="bg-[#0a1e3a] p-4 rounded-lg border border-yellow-400">
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
              <div className="mt-3 flex items-center gap-3">
                <select
                  value={autoBet.mode}
                  onChange={(e) =>
                    setAutoBet((prev) => ({ ...prev, mode: e.target.value }))
                  }
                  className="px-2 py-1 rounded border border-yellow-400 bg-[#102542]"
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
                    className="w-36 px-2 py-1 rounded border border-yellow-400 bg-[#102542] text-white"
                    placeholder="Number of spins"
                  />
                )}

                <button
                  onClick={() => setAutoBet((prev) => ({ ...prev, enabled: true }))}
                  className="px-4 py-1 rounded bg-yellow-400 text-black font-bold"
                >
                  Start
                </button>
                <button
                  onClick={() => setAutoBet((prev) => ({ ...prev, enabled: false }))}
                  className="px-4 py-1 rounded bg-red-500 text-white font-bold"
                >
                  Stop
                </button>
              </div>
            )}
          </div>
        </div>

        {result && (
          <div className="mt-4 text-center">
            Résultat:{" "}
            <span className="text-yellow-300 font-bold">{result.number}</span>
            {result.win ? ` - Gagné ${result.amount} tokens! 🎉` : " - Perdu"}
          </div>
        )}
      </div>
    </div>
  );
}
