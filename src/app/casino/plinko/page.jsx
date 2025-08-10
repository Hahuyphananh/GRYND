"use client";
import React, { useEffect, useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";

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

 const lowRiskMultipliers = [
  5, 3, 2, 1.5, 1.2, 1, 1, 1, 0.5, 0.3, 0.5, 1, 1, 1, 1.2, 1.5, 2, 3, 5,
];

const mediumRiskMultipliers = [
  10, 5, 3, 2, 1.5, 1.2, 1, 0.6, 0.4, 0.2, 0.4, 0.6, 1, 1.2, 1.5, 2, 3, 5, 10,
];

const highRiskMultipliers = [
  50, 25, 10, 5, 3, 1, 0.8, 0.5, 0.2, 0, 0.2, 0.5, 0.8, 1, 3, 5, 10, 25, 50,
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
          const lastPos = path[path.length - 1];

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
          const lastPos = path[path.length - 1];
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
            const lastPos = path[path.length - 1];
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

  const getMultiplierColor = (multiplier) => {
    if (multiplier >= 10) return "#FF4444";
    if (multiplier >= 5) return "#FF8C00";
    if (multiplier >= 3) return "#FFD700";
    if (multiplier >= 2) return "#4CAF50";
    return "#2196F3";
  };
const handleDrop = async () => {
  if (!isSignedIn) {
    setError("Vous devez être connecté pour jouer.");
    return;
  }

  if (userTokens < betAmount) {
    setError("Solde insuffisant");
    return;
  }

  setError(null);
  setShowResult(false);
  setIsProcessing(true);

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
    opacity: 1
  };

  setActiveBalls((prev) => [...prev, tempBall]);

  try {
    const response = await fetch("/api/play-plinko", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ betAmount, riskLevel }),  // <-- send riskLevel here
    });

    if (!response.ok) {
      throw new Error("Network response was not ok");
    }

    const data = await response.json();
    if (!data.success) throw new Error(data.error || "Game error");

    const { path, winAmount, multiplier, newBalance, finalPosition } = data.data;

    setGameResults((prev) => [...prev, winAmount]);
    setGameMultipliers((prev) => [...prev, multiplier]);
    setUserTokens(newBalance);
    setLastMultiplier(multiplier);

    setActiveBalls((prev) =>
      prev.map((ball) =>
        ball.id === tempBallId
          ? {
              ...ball,
              isTemp: false,
              fullPath: path,
              path: path,
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

    setTimeout(() => setShowResult(true), 3000);
  } catch (error) {
    console.error("Plinko error:", error);
    setError(error.message || "Erreur lors du lancement du jeu");
    setActiveBalls((prev) => prev.filter((b) => b.id !== tempBallId));
  } finally {
    setIsProcessing(false);
  }
};


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

return (
  <div className="h-screen flex bg-[#003366]">
    {/* Sidebar */}
    <aside
      ref={sidebarRef}
      className="flex flex-col w-64 p-6 bg-[#004B7C] text-white h-full"
    >
      <a
        href="/casino"
        className="inline-flex items-center rounded bg-[#2A2B30] px-4 py-2 mb-6 text-white hover:bg-[#3A3B40]"
      >
        <i className="fas fa-arrow-left mr-2"></i>
        Retour au Casino
      </a>

      <h1 className="mb-8 text-3xl font-bold">Plinko</h1>

      {/* Risk Level Selector */}
      <div className="mb-4">
  <label className="block mb-2 text-sm text-gray-300">Risk Level</label>
  <select
    value={riskLevel}
    onChange={(e) => setRiskLevel(e.target.value)}
    className="w-full rounded bg-[#1A1B1F] px-2 py-1 text-white"
  >
    <option value="low">Low Risk</option>
    <option value="medium">Medium Risk</option>
    <option value="high">High Risk</option>
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
        className={`w-full rounded px-4 py-2 text-white ${
          isProcessing ? "bg-gray-500 cursor-not-allowed" : "bg-[#4CAF50] hover:bg-[#45a049]"
        }`}
        onClick={handleDrop}
        disabled={isProcessing}
      >
        {isProcessing ? "En cours..." : "Lancer"}
      </button>

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
      className="flex-1 flex flex-col items-center justify-center min-h-0 p-4"
    >
      <div
        ref={boardAreaRef}
        className="flex-1 flex items-center justify-center w-full min-h-0"
        style={{ height: "100vh" }}
      >
        <div
          style={{ width: `${boardSize.width}px`, height: `${boardSize.height}px` }}
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
                    fill={getMultiplierColor(multiplier)}
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
                {ball.finalPosition && (
                  <circle
                    cx={ball.finalPosition.x}
                    cy={ball.finalPosition.y}
                    r={10}
                    fill="none"
                    stroke="rgba(0,255,0,0.5)"
                    strokeWidth="2"
                    strokeDasharray="5,5"
                  />
                )}
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
