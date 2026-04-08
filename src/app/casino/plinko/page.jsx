"use client";
import React, { useEffect, useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";
import NavigationBar from "../../../components/navigation-bar";

function MainComponent() {
  const { isSignedIn, user } = useUser();
  const [betAmount, setBetAmount] = useState(1);
  const [activeBalls, setActiveBalls] = useState([]);
  const [gameResults, setGameResults] = useState([]);
  const [gameMultipliers, setGameMultipliers] = useState([]);
  const [userTokens, setUserTokens] = useState(null);
  const [error, setError] = useState(null);
  const [lastMultiplier, setLastMultiplier] = useState(null);
  const [showResult, setShowResult] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [riskLevel, setRiskLevel] = useState("medium");
  const saveTimeoutRef = useRef(null);
const pendingBallsRef = useRef([]);
const [autoEnabled, setAutoEnabled] = useState(false);
const [autoBetCount, setAutoBetCount] = useState(10);
const [autoDelay, setAutoDelay] = useState(400); // ms between drops
const [autoStopLoss, setAutoStopLoss] = useState(0);
const [autoTakeProfit, setAutoTakeProfit] = useState(0);
const autoIntervalRef = useRef(null);
const [autoRunning, setAutoRunning] = useState(false);
const [autoInfinite, setAutoInfinite] = useState(false);
const [showRules, setShowRules] = useState(false);

const lowRiskMultipliers = [
  20, 10, 6, 4, 2.5, 1.6, 1.2, 1, 0.7, 0.4,
  0.7, 1, 1.2, 1.6, 2.5, 4, 6, 10, 20
];

const mediumRiskMultipliers = [
  120, 40, 15, 6, 3, 1.8, 1.1, 0.6, 0.3, 0.1,
  0.3, 0.6, 1.1, 1.8, 3, 6, 15, 40, 120
];


const highRiskMultipliers = [
  1000, 250, 80, 25, 8, 2.5, 1, 0.3, 0, 0,
  0, 0.3, 1, 2.5, 8, 25, 80, 250, 1000
];


const multipliersByRisk = {
  low: lowRiskMultipliers,
  medium: mediumRiskMultipliers,
  high: highRiskMultipliers,
};
const multipliers = multipliersByRisk[riskLevel];


  const svgRef = useRef(null);
  const boardAreaRef = useRef(null);
  const sidebarRef = useRef(null);
  const mainRef = useRef(null);
  const [boardSize, setBoardSize] = useState({ width: 500, height: 500, scale: 1 });

  // Keep board sized to available area so nothing overflows the page
  useEffect(() => {
    if (!boardAreaRef.current) return;

    const updateSize = () => {
      const rect = boardAreaRef.current.getBoundingClientRect();
      const availableW = rect.width;
      const availableH = rect.height;
      const scale = Math.max(0.2, Math.min(availableW / 500, availableH / 500, 1));
      setBoardSize({ width: 500 * scale, height: 500 * scale, scale });
    };

    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(boardAreaRef.current);
    window.addEventListener("resize", updateSize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", updateSize);
    };
  }, []);

  useEffect(() => {
    if (isSignedIn && user) {
      fetchUserTokens();
    }
  }, [isSignedIn, user]);

  useEffect(() => {
    const animationFrameIds = new Map();

    const easeOutQuad = (t) => t * (2 - t);

    const animateBall = (ball) => {
      if (ball.isTemp && !ball.fullPath) {
        const elapsedTime = performance.now() - ball.startTime;
        const floatY = Math.sin(elapsedTime / 200) * 0;
        setActiveBalls((prev) =>
          prev.map((b) =>
            b.id === ball.id
              ? { ...b, position: { x: ball.position.x, y: ball.position.y + floatY } }
              : b
          )
        );
        animationFrameIds.set(ball.id, requestAnimationFrame(() => animateBall(ball)));
        return;
      }

      const path = ball.fullPath || ball.path;
      if (!path || ball.currentPathIndex >= path.length - 1) {
        if (!ball.hasShownResult && ball.winAmount !== undefined) {
          const lastPos =
  ball.finalPosition ??
  (path && path.length ? path[path.length - 1] : { x: ball.position.x, y: ball.position.y });


          const resultDiv = document.createElement("div");
          resultDiv.className =
            "absolute transform -translate-x-1/2 bg-[#2A2B30] p-4 rounded-lg shadow-lg text-center z-50 animate-fadeInOut";

          const svgElement = svgRef.current;
          if (svgElement) {
            const svgRect = svgElement.getBoundingClientRect();
            const scale = svgRect.width / 500;

            const screenX = svgRect.left + lastPos.x * scale;
            const screenY = svgRect.top + lastPos.y * scale;

            resultDiv.style.left = `${screenX}px`;
            resultDiv.style.top = `${screenY - 60}px`;

            resultDiv.innerHTML = `
              <div class="text-xl font-bold text-[#FFD700]">x${ball.multiplier}</div>
              <div class="text-2xl font-bold text-green-500">+${ball.winAmount.toFixed(2)}</div>
            `;

            document.body.appendChild(resultDiv);
            setTimeout(() => resultDiv.remove(), 2000);
          }

          setActiveBalls((prev) => prev.map((b) => (b.id === ball.id ? { ...b, hasShownResult: true } : b)));
        }

        if (!ball.finalBounce) {
          const lastPos =
  ball.finalPosition ??
  (path && path.length ? path[path.length - 1] : { x: ball.position.x, y: ball.position.y });

          setActiveBalls((prev) =>
            prev.map((b) =>
              b.id === ball.id
                ? {
                    ...b,
                    finalBounce: true,
                    position: { x: lastPos.x, y: lastPos.y - 15 },
                    bounceStartTime: performance.now(),
                  }
                : b
            )
          );
          animationFrameIds.set(ball.id, requestAnimationFrame(() => animateBall({ ...ball, finalBounce: true })));
          return;
        }

        if (ball.finalBounce) {
          const elapsedTime = performance.now() - ball.bounceStartTime;
          const bounceDuration = 150;
          const progress = Math.min(1, elapsedTime / bounceDuration);

          if (progress < 1) {
            const lastPos =
  ball.finalPosition ??
  (path && path.length ? path[path.length - 1] : { x: ball.position.x, y: ball.position.y });

            const bounceHeight = Math.sin(progress * Math.PI) * 15;
            setActiveBalls((prev) =>
              prev.map((b) => (b.id === ball.id ? { ...b, position: { x: lastPos.x, y: lastPos.y - bounceHeight } } : b))
            );
            animationFrameIds.set(ball.id, requestAnimationFrame(() => animateBall(ball)));
          } else {
            animationFrameIds.delete(ball.id);
            setTimeout(() => {
              setActiveBalls((prev) => prev.filter((b) => b.id !== ball.id));
              setShowHistory(true);
            }, 100);
          }
          return;
        }

        animationFrameIds.delete(ball.id);
        return;
      }

      const currentPos = path[ball.currentPathIndex];
      const nextPos = path[ball.currentPathIndex + 1];
      const elapsedTime = performance.now() - ball.startTime;
      const totalTime = 200;
      const progress = Math.min(1, elapsedTime / totalTime);

      const easeProgress = easeOutQuad(progress);
      const bounceHeight = Math.sin(progress * Math.PI) * 5;
      const x = currentPos.x + (nextPos.x - currentPos.x) * easeProgress;
      const y = currentPos.y + (nextPos.y - currentPos.y) * easeProgress - bounceHeight;

      setActiveBalls((prev) =>
        prev.map((b) =>
          b.id === ball.id
            ? {
                ...b,
                position: { x, y },
                currentPathIndex: progress >= 1 ? b.currentPathIndex + 1 : b.currentPathIndex,
                startTime: progress >= 1 ? performance.now() : b.startTime,
                path: ball.fullPath || ball.path,
              }
            : b
        )
      );

      if (progress < 1 || ball.currentPathIndex < path.length - 1) {
        animationFrameIds.set(ball.id, requestAnimationFrame(() => animateBall(ball)));
      }
    };

    activeBalls.forEach((ball) => {
      if (!animationFrameIds.has(ball.id)) {
        animationFrameIds.set(ball.id, requestAnimationFrame(() => animateBall(ball)));
      }
    });

    return () => {
      animationFrameIds.forEach((frameId) => cancelAnimationFrame(frameId));
    };
  }, [activeBalls]);

  const fetchUserTokens = async () => {
    try {
      const response = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });

      if (!response.ok) throw new Error("Failed to fetch tokens");

      const data = await response.json();
      if (data.success) {
        setUserTokens(data.data.balance);
      }
    } catch (error) {
      setError("Impossible de récupérer votre solde");
    }
  };

 const getMultiplierColorByIndex = (index, total) => {
  // Distance from center (0 → center, 1 → edge)
  const center = (total - 1) / 2;
  const distance = Math.abs(index - center) / center;

  // Yellow → Red interpolation
  const start = { r: 255, g: 215, b: 0 };   // #e6c400 (yellow)
  const end   = { r: 255, g: 68,  b: 68 };  // #450000 (red)

  const r = Math.round(start.r + (end.r - start.r) * distance);
  const g = Math.round(start.g + (end.g - start.g) * distance);
  const b = Math.round(start.b + (end.b - start.b) * distance);

  return `rgb(${r}, ${g}, ${b})`;
};

const handleDrop = async () => {

    if (isProcessing) return;   // ✅ ADD THIS LINE
  setIsProcessing(true);
  if (!isSignedIn) {
    setError("Vous devez être connecté pour jouer.");
    return;
  }

 if (userTokens < betAmount) {
  setError("Solde insuffisant");
  setIsProcessing(false);
  return;
}

  setError(null);
  setShowResult(false);

  // Generate a unique temp ball
  const tempBallId = Date.now() + Math.random();
  const tempBall = {
    id: tempBallId,
    position: { x: 250, y: 30 },
    path: [
      { x: 250, y: 30 },
      { x: 250, y: 50 }
    ],
    currentPathIndex: 0,
    startTime: performance.now(),
    isTemp: true,
    opacity: 1,
  };

  setActiveBalls((prev) => [...prev, tempBall]);

  // Immediately deduct the bet locally
  setUserTokens((prev) => (prev !== null ? prev - betAmount : prev));

  try {
    const response = await fetch("/api/play-plinko", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ betAmount, riskLevel }),
    });

    if (!response.ok) throw new Error("Erreur réseau");

    const data = await response.json();
    if (!data.success) throw new Error(data.error || "Erreur du jeu");

    const { path, winAmount, multiplier, newBalance, finalPosition } = data.data;

    // Update game data
    setGameResults((prev) => [...prev, winAmount]);
    setGameMultipliers((prev) => [...prev, multiplier]);
    // 🧠 Queue the ball result for batch saving
pendingBallsRef.current.push({
  betAmount,
  multiplier,
  winAmount,
});

// Reset timer if it exists
if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

// Schedule save in 5 seconds
saveTimeoutRef.current = setTimeout(async () => {
  const pending = [...pendingBallsRef.current];
  if (pending.length === 0) return;

  const totalBet = pending.reduce((sum, b) => sum + b.betAmount, 0);
  const totalPayout = pending.reduce((sum, b) => sum + b.winAmount, 0);
  const multipliers = pending.map((b) => b.multiplier);

  try {
    await fetch("/api/plinko/save-games", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ totalBet, totalPayout, multipliers }),
    });
    console.log("✅ Saved Plinko batch:", pending);
  } catch (err) {
    console.error("Failed to save Plinko games:", err);
  } finally {
    pendingBallsRef.current = [];
    saveTimeoutRef.current = null;
  }
}, 5000);

    setUserTokens(newBalance);
    setLastMultiplier(multiplier);

  // Extend path to include finalPosition so ball lands exactly on the multiplier
const adjustedPath = Array.isArray(path) ? [...path] : [];
const lastPoint = adjustedPath[adjustedPath.length - 1];
if (
  !lastPoint ||
  lastPoint.x !== finalPosition.x ||
  lastPoint.y !== finalPosition.y
) {
  adjustedPath.push({ x: finalPosition.x, y: finalPosition.y });
}

setActiveBalls((prev) =>
  prev.map((ball) =>
    ball.id === tempBallId
      ? {
          ...ball,
          isTemp: false,
          fullPath: adjustedPath,
          path: adjustedPath,
          finalPosition,
          currentPathIndex: 0,
          startTime: performance.now(),
          winAmount,
          multiplier,
          hasShownResult: false,
        }
      : ball
  )
);

    // Show result per-ball
    setTimeout(() => setShowResult(true), 1500);
} catch (error) {
  console.error("Plinko error:", error);
  setError(error.message || "Erreur lors du lancement du jeu");
  setActiveBalls((prev) => prev.filter((b) => b.id !== tempBallId));
} finally {
  setIsProcessing(false);   // ✅ THIS IS VERY IMPORTANT
}
};

const startAutoBet = () => {
  if (autoRunning) return;

  let betsPlaced = 0;
  let sessionProfit = 0;

  setAutoRunning(true);

  autoIntervalRef.current = setInterval(async () => {
    if (isProcessing) return;

    // Stop if not infinite AND reached bet count
    if (!autoInfinite && betsPlaced >= autoBetCount) {
      stopAutoBet();
      return;
    }

    // Stop if no balance
    if (userTokens < betAmount) {
      stopAutoBet();
      return;
    }

    const beforeBalance = userTokens;

    await handleDrop();

    betsPlaced++;

    const afterBalance = userTokens;
    const profitChange = afterBalance - beforeBalance;
    sessionProfit += profitChange;

    // Stop Loss
    if (autoStopLoss && sessionProfit <= -autoStopLoss) {
      stopAutoBet();
    }

    // Take Profit
    if (autoTakeProfit && sessionProfit >= autoTakeProfit) {
      stopAutoBet();
    }

  }, autoDelay);
};

const stopAutoBet = () => {
  if (autoIntervalRef.current) {
    clearInterval(autoIntervalRef.current);
    autoIntervalRef.current = null;
  }
  setAutoRunning(false);
};
useEffect(() => {
  return () => {
    if (autoIntervalRef.current) {
      clearInterval(autoIntervalRef.current);
    }
  };
}, []);

  const totalWinAmount = gameResults.reduce((sum, amount) => sum + amount, 0);

  // In your useEffect where you set boardSize (adjust base from 500 to 800):
const baseSize = 800;  // <-- bigger base size for scaling

useEffect(() => {
  if (!boardAreaRef.current) return;

  const updateSize = () => {
    const rect = boardAreaRef.current.getBoundingClientRect();
    const availableW = rect.width;
    const availableH = rect.height;
    const scale = Math.max(0.2, Math.min(availableW / baseSize, availableH / baseSize, 1));
    setBoardSize({ width: baseSize * scale, height: baseSize * scale, scale });
  };

  updateSize();
  const ro = new ResizeObserver(updateSize);
  ro.observe(boardAreaRef.current);
  window.addEventListener("resize", updateSize);
  return () => {
    ro.disconnect();
    window.removeEventListener("resize", updateSize);
  };
}, []);

const scaledBoardSize = {
  width: boardSize.width * 0.95,   // 90% of original width
  height: boardSize.height * 0.95  // 90% of original height
};

return (
  <div className="h-screen flex bg-[#030817] overflow-hidden">
    <NavigationBar currentPath="/casino" />
    {/* Sidebar */}
    <aside
      ref={sidebarRef}
      className="flex flex-col w-64 p-6 bg-[#004B7C] text-white overflow-y-auto"
    >

      <h1 className="mb-8 text-3xl font-bold mt-12">Plinko</h1>

      {/* Risk Level Selector */}
      <div className="mb-4">
  <label className="block mb-2 text-sm text-gray-300">Niveau de Risque</label>
  <select
    value={riskLevel}
    onChange={(e) => setRiskLevel(e.target.value)}
    className="w-full rounded bg-[#1A1B1F] px-2 py-1 text-white"
  >
    <option value="low">Risque Faible</option>
    <option value="medium">Risque Moyen</option>
    <option value="high">Risque Élevé</option>
  </select>
</div>

      {user && (
        <div className="mb-6">
          <span className="text-[#FFD700]">
            <i className="fas fa-coins mr-2"></i>
            {userTokens !== null ? userTokens : "..."}
          </span>
        </div>
      )}

      <label className="mb-2 block text-sm text-gray-300">Montant du pari</label>

      <div className="mb-4 flex items-center gap-2">
        <button
          onClick={() => setBetAmount((prev) => Math.max(1, prev - 1))}
          className="rounded bg-[#FFD700] px-3 py-1 text-black hover:bg-[#FFD700]/80"
        >
          -
        </button>
        <input
          type="number"
          value={betAmount}
          onChange={(e) => setBetAmount(Math.max(1, Number(e.target.value)))}
          className="w-20 rounded bg-[#1A1B1F] px-2 py-1 text-center text-white"
        />
        <button
          onClick={() => setBetAmount((prev) => prev + 1)}
          className="rounded bg-[#FFD700] px-3 py-1 text-black hover:bg-[#FFD700]/80"
        >
          +
        </button>
      </div>

   <button
  className="w-full rounded px-4 py-2 text-white bg-[#4CAF50] hover:bg-[#45a049] active:scale-95 transition-transform"
  onClick={handleDrop}
  disabled={autoRunning}
>
  Lancer
</button>
<div className="mt-6 rounded-lg bg-[#1A1B1F] p-4">
  <h3 className="text-[#FFD700] font-bold mb-3">Auto Bet</h3>

 <label className="text-sm text-gray-300">Nombre de paris</label>

<div className="flex items-center gap-2 mb-2">
  <input
    type="number"
    value={autoBetCount}
    disabled={autoInfinite}
    onChange={(e) => setAutoBetCount(Number(e.target.value))}
    className="w-full rounded bg-black px-2 py-1 text-white disabled:opacity-40"
  />

 <label className="flex items-center gap-2 cursor-pointer text-xs">
  <span>Infini</span>
  <div
    onClick={() => setAutoInfinite(!autoInfinite)}
    className={`w-10 h-5 flex items-center rounded-full p-1 transition ${
      autoInfinite ? "bg-[#FFD700]" : "bg-gray-600"
    }`}
  >
    <div
      className={`bg-white w-4 h-4 rounded-full shadow-md transform transition ${
        autoInfinite ? "translate-x-5" : ""
      }`}
    />
  </div>
</label>

</div>

  <label className="text-sm text-gray-300">Délai (ms)</label>
  <input
    type="number"
    value={autoDelay}
    onChange={(e) => setAutoDelay(Number(e.target.value))}
    className="w-full mb-2 rounded bg-black px-2 py-1 text-white"
  />

  <label className="text-sm text-gray-300">Stop Loss (optionnel)</label>
  <input
    type="number"
    value={autoStopLoss}
    onChange={(e) => setAutoStopLoss(Number(e.target.value))}
    className="w-full mb-2 rounded bg-black px-2 py-1 text-white"
  />

  <label className="text-sm text-gray-300">Take Profit (optionnel)</label>
  <input
    type="number"
    value={autoTakeProfit}
    onChange={(e) => setAutoTakeProfit(Number(e.target.value))}
    className="w-full mb-4 rounded bg-black px-2 py-1 text-white"
  />

  {!autoRunning ? (
    <button
      onClick={startAutoBet}
      className="w-full rounded bg-[#FFD700] px-4 py-2 text-black hover:bg-[#FFD700]/80"
    >
      Démarrer Auto
    </button>
  ) : (
    <button
      onClick={stopAutoBet}
      className="w-full rounded bg-red-600 px-4 py-2 text-white hover:bg-red-700"
    >
      Stop
    </button>
  )}
</div>

{/* Rules Section */}
<div className="mb-4 mt-4 bg-[#1A1B1F] rounded-lg border border-yellow-400">
  <button
    onClick={() => setShowRules((prev) => !prev)}
    className="w-full flex justify-between items-center px-4 py-2 font-bold text-yellow-400"
  >
    📜 Plinko Rules
    <span>{showRules ? "▲" : "▼"}</span>
  </button>

  {showRules && (
    <div className="px-4 pb-4 text-sm text-gray-300 space-y-2">
      <p>
        🎯 Drop a ball from the top and watch it bounce through the pins.
      </p>
      <p>
        💰 The slot where the ball lands determines your <strong>multiplier</strong>.
      </p>
      <p>
        ⚠️ Higher multipliers are on the edges, but are <strong>harder to hit</strong>.
      </p>
      <p>
        🎚️ Choose a <strong>risk level</strong> to change the multiplier distribution.
      </p>
      <p>
        🤖 Use <strong>Auto Bet</strong> to automatically drop multiple balls.
      </p>
      <p>
        📉 You can configure <strong>stop loss</strong> and <strong>take profit</strong> for safer autoplay.
      </p>
    </div>
  )}
</div>

      {showResult && lastMultiplier && gameResults.length > 0 && (
        <div className="mt-6 rounded-lg bg-[#2A2B30] p-4 text-center shadow-lg">
          <div className="mb-2 text-2xl font-bold text-[#FFD700]">x{lastMultiplier}</div>
          <div className="text-2xl font-bold text-green-500">
            +{gameResults[gameResults.length - 1].toFixed(2)} tokens
          </div>
        </div>
      )}

      {error && <div className="mt-4 text-red-500">{error}</div>}

      {showHistory && gameResults.length > 0 && (
        <div className="mt-4">
          <p className="text-xl font-bold text-[#FFD700]">
            Dernier gain : {gameResults[gameResults.length - 1].toFixed(2)} tokens
            <span className="ml-2 text-white">(x{gameMultipliers[gameMultipliers.length - 1]})</span>
          </p>
          <p className="text-white">Total gagné : {totalWinAmount.toFixed(2)} tokens</p>
        </div>
      )}
    </aside>

    {/* Main Plinko game container */}
    <main
      ref={mainRef}
      className="flex-1 flex flex-col items-center justify-center min-h-0 overflow-hidden p-4"
    >
      <div
  ref={boardAreaRef}
  className="flex-1 flex items-center justify-center w-full min-h-0 overflow-hidden"
>

        <div
  style={{
    width: `${scaledBoardSize.width}px`,
    height: `${scaledBoardSize.height}px`
  }}
  className="relative flex-grow"
>

          <svg
            ref={svgRef}
            viewBox="0 0 500 500"
            width="100%"
            height="100%"
            preserveAspectRatio="xMidYMid meet"
          >
            {/* Pins */}
            {Array.from({ length: 19 }).map((_, row) =>
              Array.from({ length: row + 2 }).map((_, col) => (
                <g key={`pin-${row}-${col}`}>
                  <circle
                    cx={250 - (row + 1) * 12 + col * 24}
                    cy={50 + row * 22}
                    r={4}
                    fill="url(#pinGlow)"
                  />
                  <circle
                    cx={250 - (row + 1) * 12 + col * 24}
                    cy={50 + row * 22}
                    r={2}
                    fill="#FFD700"
                  />
                </g>
              ))
            )}

            {/* Multipliers */}
            {multipliers.map((multiplier, i) => {
              const slotWidth = 500 / multipliers.length;
              const x = i * slotWidth + slotWidth / 2;
              return (
                <g key={`mult-${i}`}>
                  <rect
                    x={i * slotWidth}
                    y={460}
                    width={slotWidth}
                    height={30}
                    fill={getMultiplierColorByIndex(i, multipliers.length)}
                  />
                  <text
                    x={x}
                    y={480}
                    textAnchor="middle"
                    fill="white"
                    fontSize="10"
                  >
                    {multiplier}x
                  </text>
                </g>
              );
            })}

            {/* Balls */}
            {activeBalls.map((ball) => (
              <g key={ball.id} className="ball-container">
                <circle
                  cx={ball.position.x}
                  cy={ball.position.y + 3}
                  r={8}
                  fill="rgba(0,0,0,0.3)"
                />
                <circle
                  cx={ball.position.x}
                  cy={ball.position.y}
                  r={8}
                  fill="url(#ballGlow)"
                  style={{ opacity: ball.opacity || 1 }}
                />
                <circle
                  cx={ball.position.x}
                  cy={ball.position.y}
                  r={6}
                  fill="url(#ballGradient)"
                  style={{ opacity: ball.opacity || 1 }}
                />
                <circle
                  cx={ball.position.x - 2}
                  cy={ball.position.y - 2}
                  r={2}
                  fill="rgba(255,255,255,0.8)"
                />
              </g>
            ))}

            <defs>
              <radialGradient id="ballGradient" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#FFD700" stopOpacity="1" />
                <stop offset="100%" stopColor="#FFA500" stopOpacity="0.6" />
              </radialGradient>
              <radialGradient id="ballGlow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#FFD700" stopOpacity="1" />
                <stop offset="100%" stopColor="#FFA500" stopOpacity="0" />
              </radialGradient>
              <radialGradient id="pinGlow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#FFD700" stopOpacity="0.8" />
                <stop offset="100%" stopColor="#FFA500" stopOpacity="0" />
              </radialGradient>
            </defs>
          </svg>
        </div>
      </div>
    </main>
  </div>
);

}

export default MainComponent;
