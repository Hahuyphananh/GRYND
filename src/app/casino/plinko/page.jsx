"use client";
import React, { useEffect, useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";
import NavigationBar from "../../../components/navigation-bar";
import { playCardDraw, playVictory, playDefeat } from "../../../lib/gameAudio";
import { CHIP_VALUES } from "../../../lib/rouletteConfig";

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
  const [autoBetCount, setAutoBetCount] = useState(10);
  const [autoDelay, setAutoDelay] = useState(400);
  const [autoStopLoss, setAutoStopLoss] = useState(0);
  const [autoTakeProfit, setAutoTakeProfit] = useState(0);
  const autoIntervalRef = useRef(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoInfinite, setAutoInfinite] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [loading, setLoading] = useState(false);

  // ── Refs to avoid stale closures in auto-bet intervals ──
  const isProcessingRef = useRef(false);
  const userTokensRef = useRef(userTokens);
  const betAmountRef = useRef(betAmount);
  const autoSessionProfitRef = useRef(0);

  useEffect(() => { isProcessingRef.current = isProcessing; }, [isProcessing]);
  useEffect(() => { userTokensRef.current = userTokens; }, [userTokens]);
  useEffect(() => { betAmountRef.current = betAmount; }, [betAmount]);

  const lowRiskMultipliers = [
    20, 10, 6, 4, 2.5, 1.6, 1.2, 1, 0.7, 0.4, 0.7, 1, 1.2, 1.6, 2.5, 4, 6, 10, 20,
  ];

  const mediumRiskMultipliers = [
    120, 40, 15, 6, 3, 1.8, 1.1, 0.6, 0.3, 0.1, 0.3, 0.6, 1.1, 1.8, 3, 6, 15, 40, 120,
  ];

  const highRiskMultipliers = [
    1000, 250, 80, 25, 8, 2.5, 1, 0.3, 0, 0, 0, 0.3, 1, 2.5, 8, 25, 80, 250, 1000,
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
  const [boardSize, setBoardSize] = useState({
    width: 500,
    height: 500,
    scale: 1,
  });

  // ── Board sizing (single ResizeObserver, no duplication) ──
  const baseSize = 800;

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
        const floatY = Math.sin(elapsedTime / 300) * 3;
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
          const lastPos =
            ball.finalPosition ??
            (path && path.length
              ? path[path.length - 1]
              : { x: ball.position.x, y: ball.position.y });

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

          setActiveBalls((prev) =>
            prev.map((b) => (b.id === ball.id ? { ...b, hasShownResult: true } : b))
          );
        }

        if (!ball.finalBounce) {
          const lastPos =
            ball.finalPosition ??
            (path && path.length
              ? path[path.length - 1]
              : { x: ball.position.x, y: ball.position.y });

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
            requestAnimationFrame(() => animateBall({ ...ball, finalBounce: true }))
          );
          return;
        }

        if (ball.finalBounce) {
          const elapsedTime = performance.now() - ball.bounceStartTime;
          const bounceDuration = 150;
          const progress = Math.min(1, elapsedTime / bounceDuration);

          if (progress < 1) {
            const lastPos =
              ball.finalPosition ??
              (path && path.length
                ? path[path.length - 1]
                : { x: ball.position.x, y: ball.position.y });

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
        animationFrameIds.set(
          ball.id,
          requestAnimationFrame(() => animateBall(ball))
        );
      }
    };

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

  const getMultiplierColorByIndex = (index, total) => {
    const center = (total - 1) / 2;
    const distance = Math.abs(index - center) / center;

    const start = { r: 0, g: 229, b: 255 };
    const end = { r: 255, g: 0, b: 128 };

    const r = Math.round(start.r + (end.r - start.r) * distance);
    const g = Math.round(start.g + (end.g - start.g) * distance);
    const b = Math.round(start.b + (end.b - start.b) * distance);

    return `rgb(${r}, ${g}, ${b})`;
  };

  // Returns { success, newBalance, winAmount } so auto-bet can use it directly
  const handleDrop = async () => {
    if (isProcessingRef.current) return { success: false };
    isProcessingRef.current = true;
    setIsProcessing(true);
    setLoading(true);

    if (!isSignedIn) {
      setError("Vous devez être connecté pour jouer.");
      isProcessingRef.current = false;
      setIsProcessing(false);
      setLoading(false);
      return { success: false };
    }

    const currentBet = betAmountRef.current;
    const currentTokens = userTokensRef.current;

    if (currentTokens === null || currentTokens < currentBet) {
      setError("Solde insuffisant");
      isProcessingRef.current = false;
      setIsProcessing(false);
      setLoading(false);
      return { success: false };
    }

    setError(null);
    setShowResult(false);

    // Play drop sound
    playCardDraw();

    const tempBallId = Date.now() + Math.random();
    const tempBall = {
      id: tempBallId,
      position: { x: 250, y: 30 },
      path: [
        { x: 250, y: 30 },
        { x: 250, y: 50 },
      ],
      currentPathIndex: 0,
      startTime: performance.now(),
      isTemp: true,
      opacity: 1,
    };

    setActiveBalls((prev) => [...prev, tempBall]);

    // Immediately deduct the bet locally (functional update for safety)
    setUserTokens((prev) => (prev !== null ? prev - currentBet : prev));

    try {
      const response = await fetch("/api/play-plinko", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ betAmount: currentBet, riskLevel }),
      });

      if (!response.ok) throw new Error("Erreur réseau");

      const data = await response.json();
      if (!data.success) throw new Error(data.error || "Erreur du jeu");

      const { path, winAmount, multiplier, newBalance, finalPosition } = data.data;

      // Update game data
      setGameResults((prev) => [...prev, winAmount]);
      setGameMultipliers((prev) => [...prev, multiplier]);

      // Queue the ball result for batch saving
      pendingBallsRef.current.push({
        betAmount: currentBet,
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
        const multipliersArr = pending.map((b) => b.multiplier);

        try {
          await fetch("/api/plinko/save-games", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ totalBet, totalPayout, multipliers: multipliersArr }),
          });
        } catch (err) {
          console.error("Failed to save Plinko games:", err);
        } finally {
          pendingBallsRef.current = [];
          saveTimeoutRef.current = null;
        }
      }, 5000);

      // Play sound based on result
      if (winAmount > currentBet) {
        setTimeout(() => playVictory(), 800);
      } else if (winAmount === 0 && currentBet > 0) {
        setTimeout(() => playDefeat(), 800);
      }

      setUserTokens(newBalance);
      setLastMultiplier(multiplier);

      // Extend path to include finalPosition
      const adjustedPath = Array.isArray(path) ? [...path] : [];
      const lastPoint = adjustedPath[adjustedPath.length - 1];
      if (!lastPoint || lastPoint.x !== finalPosition.x || lastPoint.y !== finalPosition.y) {
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

      setTimeout(() => setShowResult(true), 1500);

      return { success: true, newBalance, winAmount, betAmount: currentBet };
    } catch (err) {
      console.error("Plinko error:", err);
      setError(err.message || "Erreur lors du lancement du jeu");
      // 🔴 Restore the balance that was deducted locally
      setUserTokens((prev) => (prev !== null ? prev + currentBet : prev));
      setActiveBalls((prev) => prev.filter((b) => b.id !== tempBallId));
      return { success: false };
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
      setLoading(false);
    }
  };

  const startAutoBet = () => {
    if (autoRunning) return;

    let betsPlaced = 0;
    let sessionProfit = 0;
    autoSessionProfitRef.current = 0;

    setAutoRunning(true);

    autoIntervalRef.current = setInterval(async () => {
      if (isProcessingRef.current) return { success: false };

      // Stop if not infinite AND reached bet count
      if (!autoInfinite && betsPlaced >= autoBetCount) {
        stopAutoBet();
        return;
      }

      const currentBal = userTokensRef.current;
      const currentBet = betAmountRef.current;

      // Stop if no balance
      if (currentBal === null || currentBal < currentBet) {
        stopAutoBet();
        return;
      }

      const beforeBalance = userTokensRef.current;

      const result = await handleDrop();

      // Only count successful bets toward the limit and profit
      if (result.success) {
        betsPlaced++;
        const afterBalance = result.newBalance;
        const profitChange = (afterBalance ?? 0) - (beforeBalance ?? 0);
        sessionProfit += profitChange;
        autoSessionProfitRef.current = sessionProfit;

        // Stop Loss
        if (autoStopLoss > 0 && sessionProfit <= -autoStopLoss) {
          stopAutoBet();
        }

        // Take Profit
        if (autoTakeProfit > 0 && sessionProfit >= autoTakeProfit) {
          stopAutoBet();
        }
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

  const scaledBoardSize = {
    width:
      typeof window !== "undefined" && window.innerWidth < 768
        ? boardSize.width * 1.12
        : boardSize.width * 0.95,
    height:
      typeof window !== "undefined" && window.innerWidth < 768
        ? boardSize.height * 1.12
        : boardSize.height * 0.95,
  };

  return (
    <div
      className="
flex min-h-screen flex-col lg:flex-row
overflow-x-hidden
bg-gradient-to-br from-[#020617] via-[#071A3A] to-[#0A2A5C]

pt-[72px]
sm:pt-[76px]
lg:h-screen
"
    >
      <NavigationBar currentPath="/casino" />
      {/* Sidebar */}
      <aside
        ref={sidebarRef}
        className="
flex w-full flex-col
border-b border-[#00E5FF]/20
bg-gradient-to-b from-[#020617] via-[#071A3A] to-[#0A2A5C]
text-white backdrop-blur-md

px-3 py-3
gap-3

lg:w-64 lg:overflow-y-auto
lg:border-b-0 lg:border-r
lg:p-6 order-2 lg:order-none
"
      >
        <h1 className="text-2xl lg:text-3xl font-bold mt-4 lg:mt-12 text-[#00E5FF] drop-shadow-[0_0_10px_#00E5FF] text-center">
          Plinko
        </h1>

        {/* Risk Level Selector */}
        <div className="mb-4">
          <label className="block mb-2 text-sm text-gray-300">Niveau de Risque</label>
          <select
            value={riskLevel}
            onChange={(e) => setRiskLevel(e.target.value)}
            className="w-full rounded bg-[#020617] border border-[#00E5FF]/20 focus:border-[#00E5FF] focus:ring-1 focus:ring-[#00E5FF] px-2 py-1 text-white"
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
              {userTokens !== null ? userTokens.toLocaleString() : "..."}
            </span>
          </div>
        )}

        <label className="mb-2 block text-sm text-gray-300">Montant du pari</label>

        {/* ── Quick chip values ── */}
        <div className="flex flex-wrap gap-1.5 justify-center mb-2">
          {CHIP_VALUES.map((val) => (
            <button
              key={val}
              onClick={() => setBetAmount(val)}
              className={`px-2 py-0.5 rounded-full text-xs font-bold border transition-all duration-150
                ${
                  betAmount === val
                    ? "bg-[#FFFF33] text-black border-[#FFFF33] shadow-[0_0_10px_rgba(255,255,51,0.6)] scale-110"
                    : "bg-[#0a1a3a] text-[#FFFF33]/80 border-[#FFFF33]/30 hover:bg-[#FFFF33]/20 hover:border-[#FFFF33]/60"
                }
              `}
            >
              {val}
            </button>
          ))}
        </div>

        <div className="mb-2 flex items-center gap-2">
          <button
            onClick={() => setBetAmount((prev) => Math.max(1, prev - 1))}
            className="
h-10 min-w-[42px]
rounded-xl
border border-[#FFFF33]/40
bg-[#FFFF33]/20
text-base font-bold
text-[#fffec7]
hover:bg-[#FFFF33]/35
active:scale-95
transition
"
          >
            -
          </button>
          <input
            type="number"
            min="0"
            value={betAmount}
            onChange={(e) => {
              const v = parseInt(e.target.value);
              setBetAmount(isNaN(v) ? 0 : v);
            }}
            onBlur={() => {
              if (!betAmount || betAmount < 1) setBetAmount(1);
            }}
            className="
flex-1 h-10
rounded-xl
bg-[#020617]
border border-[#00E5FF]/20
focus:border-[#00E5FF]
focus:ring-1 focus:ring-[#00E5FF]
px-2
text-center text-white
"
          />
          <button
            onClick={() => setBetAmount((prev) => prev + 1)}
            className="
h-10 min-w-[42px]
rounded-xl
border border-[#FFFF33]/40
bg-[#FFFF33]/20
text-base font-bold
text-[#fffec7]
hover:bg-[#FFFF33]/35
active:scale-95
transition
"
          >
            +
          </button>
        </div>

        {/* ── ½ and ALL-IN buttons ── */}
        <div className="flex gap-2 mb-3">
          <button
            onClick={() => {
              if (userTokens) setBetAmount(Math.max(1, Math.floor(userTokens / 2)));
            }}
            className="flex-1 px-2 py-1.5 rounded-lg border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] text-xs font-bold hover:bg-[#FFFF33]/25 transition"
          >
            ½
          </button>
          <button
            onClick={() => {
              if (userTokens) setBetAmount(Math.max(1, userTokens));
            }}
            className="flex-1 px-2 py-1.5 rounded-lg border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] text-xs font-bold hover:bg-[#FFFF33]/25 transition"
          >
            TOUT
          </button>
          <button
            onClick={() => setBetAmount((prev) => prev * 2)}
            className="flex-1 px-2 py-1.5 rounded-lg border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] text-xs font-bold hover:bg-[#FFFF33]/25 transition"
          >
            2×
          </button>
        </div>

        {/* ── Drop button with loading state ── */}
        <button
          className="
w-full h-12
rounded-2xl
border border-[#FFFF33]/40
bg-[#FFFF33]/20
px-4
text-base font-bold
text-[#d8fbff]
hover:bg-[#FFFF33]/35
active:scale-[0.98]
transition
shadow-[0_0_15px_rgba(255,255,51,0.15)]
disabled:opacity-50 disabled:cursor-not-allowed
"
          onClick={handleDrop}
          disabled={autoRunning || loading}
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <span className="inline-block w-4 h-4 border-2 border-[#d8fbff] border-t-transparent rounded-full animate-spin"></span>
              Lancement...
            </span>
          ) : (
            "Lancer"
          )}
        </button>

        {/* ── Auto Bet ── */}
        <div className="mt-6 rounded-lg bg-[#020617] border border-[#00E5FF]/20 focus:border-[#00E5FF] focus:ring-1 focus:ring-[#00E5FF] p-4">
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
                  autoInfinite
                    ? "bg-[#f5ff3b]/30 border border-[#f5ff3b]/50 shadow-[0_0_10px_rgba(245,255,59,0.5)]"
                    : "bg-[#091737] border border-[#00e5ff]/30"
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
              className="w-full rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 px-4 py-2 text-sm font-medium text-[#d8fbff] hover:bg-[#00e5ff]/35 active:scale-95 transition"
            >
              Démarrer Auto
            </button>
          ) : (
            <button
              onClick={stopAutoBet}
              className="w-full rounded-lg border border-red-500/40 bg-red-500/20 px-4 py-2 text-sm font-medium text-red-200 hover:bg-red-500/35"
            >
              Stop
            </button>
          )}
        </div>

        {/* Rules Section */}
        <div className="mb-4 mt-4 bg-[#020617] border border-[#00E5FF]/20 focus:border-[#00E5FF] focus:ring-1 focus:ring-[#00E5FF] rounded-lg border border-yellow-400">
          <button
            onClick={() => setShowRules((prev) => !prev)}
            className="w-full flex justify-between items-center px-4 py-2 rounded-lg border border-[#FFFF33]/40 bg-[#FFFF33]/10 text-[#fffec7] font-medium hover:bg-[#FFFF33]/20"
          >
            📜 Plinko Rules
            <span>{showRules ? "▲" : "▼"}</span>
          </button>

          {showRules && (
            <div className="px-4 pb-4 text-sm text-gray-300 space-y-2">
              <p>🎯 Drop a ball from the top and watch it bounce through the pins.</p>
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
                📉 You can configure <strong>stop loss</strong> and <strong>take profit</strong> for
                safer autoplay.
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

        {/* ── Session History ── */}
        {showHistory && gameResults.length > 0 && (
          <div className="mt-4">
            <p className="text-xl font-bold text-[#FFD700]">
              Dernier gain : {gameResults[gameResults.length - 1].toFixed(2)} tokens
              <span className="ml-2 text-white">
                (x{gameMultipliers[gameMultipliers.length - 1]})
              </span>
            </p>
            <p className="text-white">Total gagné : {totalWinAmount.toFixed(2)} tokens</p>

            {/* Mini multiplier history strip */}
            {gameMultipliers.length > 1 && (
              <div className="mt-3 flex flex-wrap gap-1 items-center">
                <span className="text-xs text-gray-400 mr-1">Session:</span>
                {gameMultipliers.slice(-10).map((m, i) => (
                  <span
                    key={i}
                    className={`inline-flex items-center justify-center min-w-[32px] h-6 px-1.5 rounded text-[10px] font-bold ${
                      m > 1
                        ? "bg-green-500/20 text-green-400 border border-green-500/30"
                        : m === 0
                        ? "bg-red-500/20 text-red-400 border border-red-500/30"
                        : "bg-gray-500/20 text-gray-400 border border-gray-500/30"
                    }`}
                  >
                    {m}x
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </aside>

      {/* Main Plinko game container */}
      <main
        ref={mainRef}
        className="
flex-1 flex flex-col
items-center justify-start lg:justify-center
min-h-0 overflow-hidden
px-2 pb-6 pt-0

order-1 lg:order-none
lg:p-4
"
      >
        <div
          ref={boardAreaRef}
          className="
flex flex-1
items-start lg:items-center
justify-center
w-full
overflow-hidden
"
        >
          <div
            style={{
              width: `${scaledBoardSize.width}px`,
              height: `${scaledBoardSize.height}px`,
            }}
            className="
relative
w-full
max-w-[430px]
sm:max-w-[500px]
mx-auto
"
          >
            <svg
              ref={svgRef}
              viewBox="0 0 500 540"
              width="100%"
              height="100%"
              preserveAspectRatio="xMidYMid meet"
            >
              {/* Pins */}
              {Array.from({ length: 19 }).map((_, row) =>
                Array.from({ length: row + 2 }).map((_, col) => (
                  <g key={`pin-${row}-${col}`}>
                    {/* Glow */}
                    <circle
                      cx={250 - (row + 1) * 12 + col * 24}
                      cy={50 + row * 22}
                      r={1}
                      fill="#00E5FF"
                      opacity="0.15"
                    />

                    {/* Core */}
                    <circle
                      cx={250 - (row + 1) * 12 + col * 24}
                      cy={50 + row * 22}
                      r={window.innerWidth < 768 ? 3.8 : 3}
                      fill="#00E5FF"
                      style={{
                        filter: "drop-shadow(0 0 6px #00E5FF) drop-shadow(0 0 12px #00E5FF)",
                      }}
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
                      x={i * slotWidth + 1}
                      y={475}
                      width={slotWidth - 2}
                      height={36}
                      rx={10}
                      fill={getMultiplierColorByIndex(i, multipliers.length)}
                      style={{
                        filter: "drop-shadow(0 0 10px rgba(255,255,255,0.15))",
                        opacity: 0.9,
                      }}
                    />
                    <text
                      x={x}
                      y={495}
                      textAnchor="middle"
                      fontSize="11"
                      fontWeight="bold"
                      fill="#ffffff"
                      style={{
                        paintOrder: "stroke",
                        stroke: "#000",
                        strokeWidth: "2px",
                        filter: "drop-shadow(0 0 2px rgba(0,0,0,0.8))",
                      }}
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
