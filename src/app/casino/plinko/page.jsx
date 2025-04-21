"use client";
import React from "react";
import { useUser } from '@clerk/nextjs'
import { useState, useEffect  } from "react";

function MainComponent() {
  const { data: user } = useUser();
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

  const multipliers = [
    10, 5, 3, 2, 1.5, 1.2, 1, 0.6, 0.4, 0.2, 0.4, 0.6, 1, 1.2, 1.5, 2, 3, 5, 10,
  ];

  useEffect(() => {
    if (user) {
      fetchUserTokens();
    }
  }, [user]);

  useEffect(() => {
    const animationFrameIds = new Map();

    const animateBall = (ball) => {
      if (ball.isTemp && !ball.fullPath) {
        const elapsedTime = performance.now() - ball.startTime;
        const floatY = Math.sin(elapsedTime / 200) * 0;
        setActiveBalls((prev) =>
          prev.map((b) =>
            b.id === ball.id
              ? {
                  ...b,
                  position: { x: ball.position.x, y: ball.position.y + floatY },
                }
              : b
          )
        );
        animationFrameIds.set(
          ball.id,
          requestAnimationFrame(() => animateBall(ball))
        );
        return;
      }

      const path = ball.fullPath || ball.path;
      if (!path || ball.currentPathIndex >= path.length - 1) {
        if (!ball.hasShownResult && ball.winAmount !== undefined) {
          const lastPos = path[path.length - 1];

          const resultDiv = document.createElement("div");
          resultDiv.className =
            "fixed transform -translate-x-1/2 bg-[#2A2B30] p-4 rounded-lg shadow-lg text-center z-50 animate-fadeInOut";

          const svgElement = document.querySelector("svg");
          const svgRect = svgElement.getBoundingClientRect();
          const scale = svgRect.width / 500;

          const screenX = svgRect.left + lastPos.x * scale;
          const screenY = svgRect.top + lastPos.y * scale;

          resultDiv.style.left = `${screenX}px`;
          resultDiv.style.top = `${screenY - 60}px`;

          resultDiv.innerHTML = `
            <div class="text-xl font-bold text-[#FFD700]">x${
              ball.multiplier
            }</div>
            <div class="text-2xl font-bold text-green-500">+${ball.winAmount.toFixed(
              2
            )}</div>
          `;

          document.body.appendChild(resultDiv);
          setTimeout(() => resultDiv.remove(), 2000);

          setActiveBalls((prev) =>
            prev.map((b) =>
              b.id === ball.id ? { ...b, hasShownResult: true } : b
            )
          );
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
          animationFrameIds.set(
            ball.id,
            requestAnimationFrame(() =>
              animateBall({ ...ball, finalBounce: true })
            )
          );
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
              prev.map((b) =>
                b.id === ball.id
                  ? {
                      ...b,
                      position: { x: lastPos.x, y: lastPos.y - bounceHeight },
                    }
                  : b
              )
            );
            animationFrameIds.set(
              ball.id,
              requestAnimationFrame(() => animateBall(ball))
            );
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
      const y =
        currentPos.y + (nextPos.y - currentPos.y) * easeProgress - bounceHeight;

      setActiveBalls((prev) =>
        prev.map((b) =>
          b.id === ball.id
            ? {
                ...b,
                position: { x, y },
                currentPathIndex:
                  progress >= 1 ? b.currentPathIndex + 1 : b.currentPathIndex,
                startTime: progress >= 1 ? performance.now() : b.startTime,
                path: ball.fullPath || ball.path,
              }
            : b
        )
      );

      if (progress < 1 || ball.currentPathIndex < path.length - 1) {
        animationFrameIds.set(
          ball.id,
          requestAnimationFrame(() => animateBall(ball))
        );
      }
    };

    const easeOutQuad = (t) => t * (2 - t);

    activeBalls.forEach((ball) => {
      if (!animationFrameIds.has(ball.id)) {
        animationFrameIds.set(
          ball.id,
          requestAnimationFrame(() => animateBall(ball))
        );
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
    if (!user) {
      window.location.href = "/account/signin?callbackUrl=/casino/plinko";
      return;
    }

    if (userTokens < betAmount) {
      setError("Solde insuffisant");
      return;
    }

    setError(null);
    setShowResult(false);

    const startPosition = 7;
    const initialBallPosition = { x: 250 + (Math.random() * 100 - 50), y: 30 };
    const initialPath = [
      { x: initialBallPosition.x, y: initialBallPosition.y },
      { x: 250, y: 50 },
    ];

    const tempBallId = Date.now() + Math.random();
    const tempBall = {
      id: tempBallId,
      position: initialBallPosition,
      path: initialPath,
      currentPathIndex: 0,
      startTime: performance.now(),
      opacity: 1,
      isTemp: true,
    };

    setActiveBalls((prev) => [...prev, tempBall]);

    try {
      const response = await fetch("/api/play-plinko", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          startPosition,
          betAmount,
        }),
      });

      if (!response.ok) {
        throw new Error("Erreur lors du lancement du jeu");
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      setGameResults((prev) => [...prev, data.winAmount]);
      setGameMultipliers((prev) => [...prev, data.multiplier]);
      setLastMultiplier(data.multiplier);
      fetchUserTokens();

      setActiveBalls((prev) =>
        prev.map((ball) =>
          ball.id === tempBallId
            ? {
                ...ball,
                isTemp: false,
                fullPath: data.path,
                path: data.path,
                currentPathIndex: 0,
                startTime: performance.now(),
                winAmount: data.winAmount,
                multiplier: data.multiplier,
                hasShownResult: false,
              }
            : ball
        )
      );
    } catch (error) {
      console.error(error);
    }
  };

  const totalWinAmount = gameResults.reduce((sum, amount) => sum + amount, 0);

  return (
    <div className="min-h-screen bg-[#003366]">
      <div className="pt-8">
        <div className="container mx-auto px-4">
          <a
            href="/casino"
            className="mb-4 inline-flex items-center rounded bg-[#2A2B30] px-4 py-2 text-white hover:bg-[#3A3B40]"
          >
            <i className="fas fa-arrow-left mr-2"></i>
            Retour au Casino
          </a>
        </div>
        <main className="container mx-auto max-w-6xl px-4 py-8">
          <h1 className="mb-8 text-center text-4xl font-bold text-[#FFD700]">
            Plinko
          </h1>

          <div className="flex flex-col gap-8 md:flex-row">
            <div className="w-full rounded-lg bg-[#2A2B30] p-4 md:w-64">
              {user && (
                <div className="mb-4">
                  <span className="text-[#FFD700]">
                    <i className="fas fa-coins mr-2"></i>
                    {userTokens !== null ? userTokens : "..."}
                  </span>
                </div>
              )}

              <label className="mb-2 block text-sm text-gray-300">
                Montant du pari
              </label>
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
                  onChange={(e) =>
                    setBetAmount(Math.max(1, Number(e.target.value)))
                  }
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
                  isProcessing
                    ? "bg-gray-500 cursor-not-allowed"
                    : "bg-[#4CAF50] hover:bg-[#45a049]"
                }`}
                onClick={handleDrop}
                disabled={isProcessing}
              >
                {isProcessing ? "En cours..." : "Lancer"}
              </button>

              {showResult && lastMultiplier && gameResults.length > 0 && (
                <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 transform rounded-lg bg-[#2A2B30] p-6 text-center shadow-lg">
                  <div className="mb-2 text-2xl font-bold text-[#FFD700]">
                    x{lastMultiplier}
                  </div>
                  <div className="text-3xl font-bold text-green-500">
                    +{gameResults[gameResults.length - 1].toFixed(2)} tokens
                  </div>
                </div>
              )}

              {error && <div className="mt-4 text-red-500">{error}</div>}

              {showHistory && gameResults.length > 0 && (
                <div className="mt-4">
                  <p className="text-xl font-bold text-[#FFD700]">
                    Dernier gain :{" "}
                    {gameResults[gameResults.length - 1].toFixed(2)} tokens
                    <span className="ml-2 text-white">
                      (x{gameMultipliers[gameMultipliers.length - 1]})
                    </span>
                  </p>
                  <p className="text-white">
                    Total gagné : {totalWinAmount.toFixed(2)} tokens
                  </p>
                </div>
              )}
            </div>

            <div className="flex-1">
              <div className="relative aspect-square max-w-3xl rounded-lg bg-[#1A1B1F] p-8">
                <svg viewBox="0 0 500 500" className="h-full w-full">
                  {Array.from({ length: 19 }).map((_, row) =>
                    Array.from({ length: row + 2 }).map((_, col) => (
                      <g key={`pin-${row}-${col}`}>
                        <circle
                          cx={250 - (row + 1) * 12 + col * 24}
                          cy={50 + row * 22}
                          r={4}
                          fill="url(#pinGlow)"
                          className="pin"
                        />
                        <circle
                          cx={250 - (row + 1) * 12 + col * 24}
                          cy={50 + row * 22}
                          r={2}
                          fill="#FFD700"
                          className="pin"
                        />
                      </g>
                    ))
                  )}

                  {multipliers.map((multiplier, i) => {
                    const totalWidth = (multipliers.length - 1) * 24;
                    const startX = 250 - totalWidth / 2;
                    const x = startX + i * 24;

                    return (
                      <g key={`multiplier-${i}`}>
                        <rect
                          x={x - 10}
                          y={460}
                          width={20}
                          height={30}
                          rx={2}
                          fill={getMultiplierColor(multiplier)}
                          className="multiplier-slot"
                        />
                        <text
                          x={x}
                          y={480}
                          textAnchor="middle"
                          fill="white"
                          fontSize="10"
                          className="multiplier-text"
                        >
                          {multiplier}x
                        </text>
                      </g>
                    );
                  })}

                  {activeBalls.map((ball, index) => (
                    <g key={index} className="ball-container">
                      <circle
                        cx={ball.position.x}
                        cy={ball.position.y + 3}
                        r={8}
                        fill="rgba(0,0,0,0.3)"
                        className="ball-shadow"
                      />
                      <circle
                        cx={ball.position.x}
                        cy={ball.position.y}
                        r={8}
                        fill="url(#ballGlow)"
                        className="ball-glow"
                        style={{
                          opacity: ball.opacity || 1,
                        }}
                      />
                      <circle
                        cx={ball.position.x}
                        cy={ball.position.y}
                        r={6}
                        fill="url(#ballGradient)"
                        className="ball"
                        style={{
                          opacity: ball.opacity || 1,
                        }}
                      />
                      <circle
                        cx={ball.position.x - 2}
                        cy={ball.position.y - 2}
                        r={2}
                        fill="rgba(255,255,255,0.8)"
                        className="ball-highlight"
                      />
                    </g>
                  ))}

                  <defs>
                    <radialGradient id="pinGlow">
                      <stop offset="0%" stopColor="#FFD700" stopOpacity="0.3" />
                      <stop offset="100%" stopColor="#FFD700" stopOpacity="0" />
                    </radialGradient>

                    <radialGradient id="ballGradient">
                      <stop offset="0%" stopColor="#FFD700" />
                      <stop offset="70%" stopColor="#FFA500" />
                      <stop offset="100%" stopColor="#FF8C00" />
                    </radialGradient>

                    <filter id="ballGlow">
                      <feGaussianBlur stdDeviation="2" result="coloredBlur" />
                      <feFlood
                        floodColor="#FFD700"
                        floodOpacity="0.5"
                        result="glowColor"
                      />
                      <feComposite
                        in="glowColor"
                        in2="coloredBlur"
                        operator="in"
                        result="softGlow"
                      />
                      <feMerge>
                        <feMergeNode in="softGlow" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                  </defs>
                </svg>
              </div>
            </div>
          </div>
        </main>
      </div>

      <style jsx global>{`
        .ball-container {
          filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.3));
        }

        .ball {
          transition: transform 0.1s ease-out;
        }

        .ball-glow {
          filter: url(#ballGlow);
        }

        .pin {
          transition: transform 0.2s ease-out, opacity 0.2s ease-out;
        }

        .pin:hover {
          transform: scale(1.5);
          opacity: 0.8;
        }

        .multiplier-slot {
          transition: transform 0.2s ease-out;
        }

        .multiplier-slot:hover {
          transform: translateY(-2px);
        }

        @keyframes bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-5px); }
        }

        @keyframes glow {
          0%, 100% { filter: brightness(1); }
          50% { filter: brightness(1.3); }
        }

        .ball.bouncing {
          animation: bounce 0.5s ease-out;
        }

        .ball-glow.active {
          animation: glow 1s infinite;
        }

        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-20px); }
          to { opacity: 1; transform: translateY(0); }
        }

        @keyframes fadeOut {
          from { opacity: 1; transform: translateY(0); }
          to { opacity: 0; transform: translateY(20px); }
        }

        .animate-fadeInOut {
          animation: fadeIn 0.3s ease-out, fadeOut 0.3s ease-in 1.7s;
        }
      `}</style>
    </div>
  );
}

export default MainComponent;