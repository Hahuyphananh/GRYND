"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import confetti from "canvas-confetti";
import { usePostHog } from "posthog-js/react";
import NavigationBar from "../../../components/navigation-bar";
import {
  ROULETTE_NUMBERS,
  RED_NUMBERS,
  COLORS,
  CHIP_VALUES,
} from "../../../lib/rouletteConfig";

// ─── Canvas constants ───────────────────────────────────────────
const CANVAS_SIZE = 420;
const WHEEL_RADIUS = CANVAS_SIZE / 2;
const BALL_RADIUS = 7;
const BALL_ORBIT_RADIUS = WHEEL_RADIUS - 24; // ball rides near the rim
const SEGMENT_ANGLE = (2 * Math.PI) / ROULETTE_NUMBERS.length;
const POINTER_ANGLE = -Math.PI / 2; // pointer is at the top of the canvas (canvas: +x = 0, +y down → top is −π/2)
const POINTER_RADIUS = BALL_ORBIT_RADIUS - 28; // where the ball settles inside the winning pocket

// Pocket color lookup (outside component to avoid recreation)
const isRedNum = (num) => RED_NUMBERS.includes(num);
const pocketColor = (num) => {
  if (num === 0) return COLORS.green;
  return isRedNum(num) ? COLORS.red : COLORS.black;
};

export default function RoulettePage() {
  const posthog = usePostHog();
  const [betAmount, setBetAmount] = useState(10);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [lastResults, setLastResults] = useState([]); // hot-numbers strip
  const [userTokens, setUserTokens] = useState(0);
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
  const [winningNumber, setWinningNumber] = useState(null); // highlight on grid
  const [newChipKeys, setNewChipKeys] = useState([]); // scale-in animation (new chips only)


  const canvasRef = useRef(null);
  const autoBetRef = useRef(autoBet);
  const userTokensRef = useRef(userTokens);
  const betsRef = useRef(bets); // avoid stale closure in auto-bet

  // Keep refs in sync
  useEffect(() => {
    autoBetRef.current = autoBet;
  }, [autoBet]);
  useEffect(() => {
    userTokensRef.current = userTokens;
  }, [userTokens]);
  useEffect(() => {
    betsRef.current = bets;
  }, [bets]);

  // ─── Fetch tokens ──────────────────────────────────────────────
  useEffect(() => {
    async function fetchTokens() {
      try {
        const res = await fetch("/api/get-user-tokens", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
        });
        const data = await res.json();
        if (data.success) setUserTokens(data.data.balance);
        else throw new Error(data.error || "Erreur inconnue");
      } catch {
        setError("Impossible de récupérer votre solde");
      }
    }
    fetchTokens();
  }, []);

  // ─── Canvas drawing ────────────────────────────────────────────

  /** Full wheel redraw with optional ball overlay */
  const drawWheel = useCallback(
    (angleOffset = 0, ballAngle = null, ballDist = null) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      const size = canvas.width;
      const radius = size / 2;

      ctx.clearRect(0, 0, size, size);

      // ── Outer rim ──────────────────────────────────────────
      ctx.save();
      ctx.translate(radius, radius);

      // Dark wood rim
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, 2 * Math.PI);
      ctx.fillStyle = COLORS.wheelBg;
      ctx.fill();
      ctx.strokeStyle = COLORS.wheelRim;
      ctx.lineWidth = 6;
      ctx.stroke();

      // Inner gold ring
      ctx.beginPath();
      ctx.arc(0, 0, radius - 10, 0, 2 * Math.PI);
      ctx.strokeStyle = COLORS.gold;
      ctx.lineWidth = 2;
      ctx.stroke();

      // ── Rotate wheel ───────────────────────────────────────
      ctx.rotate(angleOffset);

      // ── Segments ───────────────────────────────────────────
      ROULETTE_NUMBERS.forEach((num, i) => {
        const startAngle = i * SEGMENT_ANGLE;
        const endAngle = startAngle + SEGMENT_ANGLE;

        // Pocket
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, radius - 20, startAngle, endAngle);
        ctx.closePath();
        ctx.fillStyle = pocketColor(num);
        ctx.fill();

        // Pocket divider line
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, radius - 20, endAngle, endAngle);
        ctx.strokeStyle = COLORS.pocketDivider;
        ctx.lineWidth = 0.5;
        ctx.stroke();

        // Number label
        ctx.save();
        ctx.fillStyle = "#fff";
        ctx.font = "bold 11px sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.rotate(startAngle + SEGMENT_ANGLE / 2);
        ctx.fillText(num.toString(), radius - 30, 0);
        ctx.restore();
      });

      ctx.restore();

      // ── Ball (drawn in world space, over the rotated wheel) ──
      if (ballAngle !== null && ballDist !== null) {
        ctx.save();
        ctx.translate(radius, radius);
        const bx = Math.cos(ballAngle) * ballDist;
        const by = Math.sin(ballAngle) * ballDist;

        // Ball glow
        ctx.beginPath();
        ctx.arc(bx, by, BALL_RADIUS + 3, 0, 2 * Math.PI);
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.fill();

        // Ball body
        ctx.beginPath();
        ctx.arc(bx, by, BALL_RADIUS, 0, 2 * Math.PI);
        const ballGrad = ctx.createRadialGradient(
          bx - 2,
          by - 2,
          0,
          bx,
          by,
          BALL_RADIUS,
        );
        ballGrad.addColorStop(0, "#ffffff");
        ballGrad.addColorStop(0.6, "#e0e0e0");
        ballGrad.addColorStop(1, "#a0a0a0");
        ctx.fillStyle = ballGrad;
        ctx.fill();
        ctx.strokeStyle = "#888";
        ctx.lineWidth = 0.5;
        ctx.stroke();

        ctx.restore();
      }

      // ── Fixed pointer at top ───────────────────────────────
      ctx.save();
      ctx.translate(radius, 0);
      // Shadow
      ctx.beginPath();
      ctx.moveTo(0, 6);
      ctx.lineTo(-12, 28);
      ctx.lineTo(12, 28);
      ctx.closePath();
      ctx.fillStyle = COLORS.goldDark;
      ctx.fill();
      // Main pointer
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-12, 24);
      ctx.lineTo(12, 24);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, 24);
      grad.addColorStop(0, COLORS.gold);
      grad.addColorStop(1, COLORS.goldDark);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
    },
    [],
  );

  // ─── Initial draw & resize ────────────────────��────────────────
  useEffect(() => {
    drawWheel();
    const onResize = () => drawWheel();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [drawWheel]);

  // ─── Spin animation with ball ──────────────────────────────────
  // Normalize an angle into [0, 2π)
  const normAngle = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

  const spinWheel = (finalIndex) => {
    return new Promise((resolve) => {
      const fullRotations = 7;
      const duration = 4500; // ms — slightly longer for a more cinematic feel
      const ballOrbitEnd = 0.78; // fraction of duration when the ball begins to settle
      const start = performance.now();

      // ── Target wheel rotation ──
      // Segment `finalIndex` must end up centered under the pointer (top, −π/2).
      // Segment i's center angle in the unrotated wheel is (i · SEGMENT_ANGLE + SEGMENT_ANGLE/2),
      // so the wheel must rotate so that this center maps onto POINTER_ANGLE.
      const winningCenter = finalIndex * SEGMENT_ANGLE + SEGMENT_ANGLE / 2;
      const endRotation = normAngle(POINTER_ANGLE - winningCenter);

      // Random start rotation for visual variety per spin
      const startRotation = Math.random() * (2 * Math.PI);

      // Forward angular distance to travel: at least fullRotations, then land at endRotation.
      let delta = endRotation - startRotation;
      if (delta <= 0) delta += 2 * Math.PI;
      delta += fullRotations * 2 * Math.PI;

      const finalAngle = startRotation + delta;

      // Ball starts at a random orbital position (variety)
      const ballStartAngle = Math.random() * (2 * Math.PI);

      const animate = (now) => {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);

        // Wheel: ease-out cubic (decelerating, mimics real-wheel friction)
        const wheelEased = 1 - Math.pow(1 - progress, 3);
        const wheelAngle = startRotation + wheelEased * delta;

        // Ball: orbits opposite the wheel, then snaps into the winning pocket
        let ballAngle, ballDist;
        if (progress < ballOrbitEnd) {
          const orbitProgress = progress / ballOrbitEnd;
          const orbitEased = 1 - Math.pow(1 - orbitProgress, 2); // ease-out
          ballAngle = ballStartAngle - orbitEased * fullRotations * 2 * Math.PI;
          ballDist = BALL_ORBIT_RADIUS;
        } else {
          const dropProgress = (progress - ballOrbitEnd) / (1 - ballOrbitEnd);
          const dropEased = 1 - Math.pow(1 - dropProgress, 2); // ease-out
          // Drop straight inward from the rim to the pocket
          ballDist =
            BALL_ORBIT_RADIUS - dropEased * (BALL_ORBIT_RADIUS - POINTER_RADIUS);
          // Tiny wobble that decays fast (cubic) so the ball clearly settles inside the pocket
          // rather than straddling the divider between two pockets.
          const wobbleDecay = Math.pow(1 - dropProgress, 3);
          const wobble =
            Math.sin(dropProgress * Math.PI * 3) * wobbleDecay * 0.05;
          ballAngle = POINTER_ANGLE + wobble;
        }

        drawWheel(wheelAngle, ballAngle, ballDist);

        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          // Final frame: exact alignment, no wobble — guarantees the ball
          // lands exactly on the result regardless of floating-point drift.
          drawWheel(finalAngle, POINTER_ANGLE, POINTER_RADIUS);
          resolve();
        }
      };
      requestAnimationFrame(animate);
    });
  };

  // ─── Bet handling ──────────────────────────────────────────────
  const placeBet = (target) => {
    const amount = betAmount < 1 ? 1 : betAmount;
    if (betAmount < 1) setBetAmount(1);
    setBets((prev) => {
      const updated = {
        ...prev,
        [target]: (prev[target] || 0) + amount,
      };
      return updated;
    });
    // Track new chip for scale animation
    const key = `${target}-${Date.now()}`;
    setNewChipKeys((prev) => [...prev, key]);
    setTimeout(() => setNewChipKeys((prev) => prev.filter((k) => k !== key)), 350);
  };

  const resetBets = () => {
    setBets({});
    setError(null);
  };

  // ─── Spin ──────────────────────────────────────────────────────
  const handleSpin = async () => {
    const currentBets = betsRef.current;
    const totalBetAmount = Object.values(currentBets).reduce((a, b) => a + b, 0);
    if (spinning || totalBetAmount === 0) return;
    if (totalBetAmount > userTokensRef.current) {
      setError("Solde insuffisant pour cette mise");
      return;
    }

    setSpinning(true);
    setError(null);
    setWinningNumber(null);

    const response = await fetch("/api/roulette/save-game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bets: currentBets }),
    });
    const data = await response.json();
    if (!response.ok || !data?.success) {
      setError(data?.error || "Erreur lors du lancement");
      setSpinning(false);
      return;
    }

    // Animate the wheel + ball
    await spinWheel(data.data.spinResultIndex);

    const newBalance = Number(data.data.newBalance);
    const won = data.data.win;
    const winAmount = data.data.amount;

    setUserTokens(newBalance);
    setResult({
      number: data.data.spinResult,
      win: won,
      amount: winAmount,
    });
    setWinningNumber(data.data.spinResult);
    setLastResults((prev) => [data.data.spinResult, ...prev].slice(0, 10));
    setStats((prev) => ({
      biggestWin: won ? Math.max(prev.biggestWin, winAmount) : prev.biggestWin,
      totalBets: prev.totalBets + 1,
      totalWins: won ? prev.totalWins + 1 : prev.totalWins,
    }));
    posthog?.capture("roulette_game_ended", { result: won ? "win" : "loss", bet_amount: totalBetAmount, payout: winAmount, winning_number: data.data.spinResult });

    // Save bets + current auto-bet state for auto-bet continuation
    const savedBets = { ...currentBets };
    const currentAuto = autoBetRef.current;

    // Celebrate on win
    if (won) {
      confetti({
        particleCount: 80,
        spread: 70,
        origin: { y: 0.6 },
        colors: [COLORS.gold, "#FFD700", "#FFA500", "#FFFFFF"],
      });
      setTimeout(() => {
        confetti({
          particleCount: 40,
          spread: 50,
          origin: { y: 0.5, x: 0.3 },
          colors: [COLORS.gold, "#FFD700"],
        });
        confetti({
          particleCount: 40,
          spread: 50,
          origin: { y: 0.5, x: 0.7 },
          colors: [COLORS.gold, "#FFD700"],
        });
      }, 300);
    }

    setBets({});
    setSpinning(false);

    // Auto-bet continuation with balance check
    if (currentAuto?.enabled) {
      // Stop if balance is too low for the SAME bets
      if (newBalance < totalBetAmount) {
        setAutoBet((prev) => ({ ...prev, enabled: false }));
        setError("Auto-bet arrêté : solde insuffisant");
        return;
      }
      // Re-apply saved bets for the next spin
      setBets(savedBets);
      if (currentAuto.mode === "finite") {
        if (currentAuto.spinsLeft > 1) {
          setAutoBet((prev) => ({ ...prev, spinsLeft: prev.spinsLeft - 1 }));
          setTimeout(() => handleSpin(), 1500);
        } else {
          setAutoBet((prev) => ({ ...prev, enabled: false }));
          setBets({});
        }
      } else if (currentAuto.mode === "infinite") {
        setTimeout(() => handleSpin(), 1500);
      }
    }
  };


  // Clear winning highlight after a delay
  useEffect(() => {
    if (winningNumber !== null) {
      const timer = setTimeout(() => setWinningNumber(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [winningNumber]);

  // ─── Number grid ───────────────────────────────────────────────
  const renderNumberGrid = () => {
    const rows = [[], [], []];
    for (let i = 1; i <= 36; i++) {
      rows[(i - 1) % 3].push(i);
    }

    return (
      <div className="w-full overflow-x-auto pb-2">
        <div className="min-w-[320px] space-y-1">
          {/* Zero row */}
          <div className="flex justify-center mb-1">
            <button
              onClick={() => placeBet(0)}
              className={`relative w-12 h-12 sm:w-14 sm:h-14 flex items-center justify-center rounded-md border border-[#FFFF33]/30 text-sm font-bold transition-all duration-150
                bg-[#0d5e2e] text-white shadow-[0_0_12px_rgba(13,94,46,0.5)]
                hover:scale-105 hover:brightness-110 active:scale-95
                ${winningNumber === 0 ? "ring-3 ring-[#FFFF33] animate-pulse shadow-[0_0_25px_rgba(255,255,51,0.8)]" : ""}
              `}
            >
              0
              {bets[0] && (
                <span className={`absolute -top-2 -right-2 bg-[#FFFF33]/90 text-black text-[10px] sm:text-xs font-bold px-1.5 py-0.5 rounded-full shadow-[0_0_8px_rgba(255,255,51,0.5)] ${newChipKeys.some(k => k.startsWith("0-")) ? "animate-bet-chip" : ""}`}>
                  {bets[0]}
                </span>
              )}
            </button>
          </div>

          {rows.map((row, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-1 justify-center">
              {row.map((num) => {
                const red = isRedNum(num);
                const isWinner = winningNumber === num;

                return (
                  <button
                    key={num}
                    onClick={() => placeBet(num)}
                    className={`relative w-full aspect-square flex items-center justify-center rounded-md border text-[11px] sm:text-sm font-medium transition-all duration-150
                      ${
                        red
                          ? "bg-[#c0392b] border-red-400/40 text-white shadow-[0_0_10px_rgba(192,57,43,0.4)]"
                          : "bg-[#1a1a2e] border-[#FFFF33]/30 text-[#FFFF33] shadow-[0_0_8px_rgba(255,255,51,0.15)]"
                      }
                      hover:scale-105 hover:brightness-110 active:scale-95
                      ${isWinner ? "ring-3 ring-[#FFFF33] animate-pulse shadow-[0_0_25px_rgba(255,255,51,0.8)] z-10" : ""}
                    `}
                  >
                    {num}
                    {bets[num] && (
                      <span className={`absolute -top-2 -right-2 bg-[#FFFF33]/90 text-black text-[10px] sm:text-xs font-bold px-1.5 py-0.5 rounded-full shadow-[0_0_8px_rgba(255,255,51,0.5)] ${newChipKeys.some(k => k.startsWith(`${num}-`)) ? "animate-bet-chip" : ""}`}>
                        {bets[num]}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ─── Hot numbers strip ─────────────────────────────────────────
  const lastNumColor = (num) => {
    if (num === 0) return "bg-[#0d5e2e] text-white";
    return isRedNum(num)
      ? "bg-[#c0392b] text-white"
      : "bg-[#1a1a2e] text-[#FFFF33]";
  };

  // ─── Render ────────────────────────────────────────────────────
  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] pb-24 pt-20 text-white md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto mt-2 flex w-full max-w-[1300px] flex-col gap-4 px-3 sm:mt-6 sm:flex-row sm:gap-8 sm:p-6">
        {/* ── Left sidebar ──────────────────────────────────── */}
        <div className="flex w-full flex-shrink-0 flex-col items-start gap-3 sm:w-[260px] sm:gap-5">
          <h1 className="mt-2 w-full text-center text-2xl font-bold text-[#FFFF33] drop-shadow-[0_0_12px_rgba(255,255,51,0.6)] sm:text-3xl">
            🎰 Roulette Royale
          </h1>

          {/* Tokens */}
          <span className="inline-block w-full text-center px-4 py-2 bg-[#FFFF33]/15 border border-[#FFFF33]/40 text-[#fffec7] rounded-full font-extrabold text-lg shadow-[0_0_12px_rgba(255,255,51,0.4)]">
            Jetons : {userTokens.toLocaleString()}
          </span>

          {/* Quick-select chips */}
          <div className="w-full bg-[#001933] p-3 rounded-lg border border-[#FFFF33]/20">
            <p className="text-xs text-[#FFFF33]/70 mb-2 text-center">
              Valeur du jeton
            </p>
            <div className="flex flex-wrap gap-1.5 justify-center">
              {CHIP_VALUES.map((val) => (
                <button
                  key={val}
                  onClick={() => setBetAmount(val)}
                  className={`px-2.5 py-1 rounded-full text-xs font-bold border transition-all duration-150
                    ${
                      betAmount === val
                        ? "bg-[#FFFF33] text-black border-[#FFFF33] shadow-[0_0_12px_rgba(255,255,51,0.6)] scale-110"
                        : "bg-[#0a1a3a] text-[#FFFF33]/80 border-[#FFFF33]/30 hover:bg-[#FFFF33]/20 hover:border-[#FFFF33]/60"
                    }
                  `}
                >
                  {val}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 mt-2">
              <input
                type="number"
                min="0"
                value={betAmount}
                onChange={(e) => setBetAmount(parseInt(e.target.value) || 0)}
                onBlur={() => { if (!betAmount || betAmount < 1) setBetAmount(1); }}
                className="flex-1 rounded bg-[#0a1a3a] border border-[#FFFF33]/30 focus:border-[#FFFF33] focus:ring-1 focus:ring-[#FFFF33] px-2 py-1 text-white text-sm text-center"
              />
              <button onClick={() => setBetAmount(Math.max(1, Math.floor(userTokens / 2)))} className="px-2 py-1 rounded text-xs font-bold border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] hover:bg-[#FFFF33]/25 transition">½</button>
              <button onClick={() => setBetAmount(userTokens)} className="px-2 py-1 rounded text-xs font-bold border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] hover:bg-[#FFFF33]/25 transition">TOUT</button>
            </div>
          </div>

          {/* Spin & Reset */}
          <div className="flex flex-col gap-2 w-full">
            <button
              onClick={handleSpin}
              disabled={spinning}
              className={`px-6 py-3 rounded-full font-bold text-lg border border-[#FFFF33]/40 transition-all duration-200
                ${
                  spinning
                    ? "bg-gray-600 text-gray-300 cursor-not-allowed"
                    : "bg-[#FFFF33]/20 text-[#FFFF33] hover:bg-[#FFFF33]/35 shadow-[0_0_20px_rgba(255,255,51,0.5)] hover:shadow-[0_0_30px_rgba(255,255,51,0.7)] active:scale-95"
                }
              `}
            >
              {spinning ? "La roue tourne…" : "🎯 Tourner la Roue"}
            </button>
            <button
              onClick={resetBets}
              disabled={spinning}
              className="px-6 py-2 rounded-full font-bold border border-red-500/40 text-red-400 hover:bg-red-500/20 hover:text-red-200 transition shadow-[0_0_10px_rgba(255,0,0,0.3)]"
            >
              Réinitialiser les mises
            </button>
          </div>

          {/* Auto-bet */}
          <div className="bg-[#001933] p-3 rounded-lg border border-[#FFFF33]/25 w-full">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={autoBet.enabled}
                onChange={(e) =>
                  setAutoBet((prev) => ({ ...prev, enabled: e.target.checked }))
                }
                className="accent-[#FFFF33]"
              />
              <span className="text-[#FFFF33] font-semibold">Jeu Automatique</span>
            </label>

            {autoBet.enabled && (
              <div className="mt-3 flex flex-col gap-2">
                <select
                  value={autoBet.mode}
                  onChange={(e) =>
                    setAutoBet((prev) => ({ ...prev, mode: e.target.value }))
                  }
                  className="px-2 py-1.5 rounded border border-[#00e5ff]/30 bg-[#091737] text-white text-sm focus:border-[#00e5ff]"
                >
                  <option value="finite">Nombre défini</option>
                  <option value="infinite">Infini</option>
                </select>

                {autoBet.mode === "finite" && (
                  <input
                    type="number"
                    min="1"
                    value={autoBet.spinsLeft}
                    onChange={(e) =>
                      setAutoBet((prev) => ({
                        ...prev,
                        spinsLeft: Math.max(1, Number(e.target.value)),
                      }))
                    }
                    className="px-2 py-1.5 rounded border border-[#00e5ff]/30 bg-[#091737] text-white text-sm focus:border-[#00e5ff]"
                    placeholder="Nombre de tours"
                  />
                )}

                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setAutoBet((prev) => ({ ...prev, enabled: true }));
                      // Trigger first spin immediately
                      setTimeout(() => handleSpin(), 100);
                    }}
                    className="flex-1 px-3 py-1.5 rounded bg-yellow-400 text-black font-bold text-sm"
                  >
                    Démarrer
                  </button>
                  <button
                    onClick={() =>
                      setAutoBet((prev) => ({ ...prev, enabled: false }))
                    }
                    className="flex-1 px-3 py-1.5 rounded bg-red-500 text-white font-bold text-sm"
                  >
                    Arrêter
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Rules */}
          <div className="w-full">
            <button
              onClick={() => setShowRules(!showRules)}
              className="w-full flex items-center justify-between px-3 py-2.5 bg-[#FFFF33]/15 text-[#FFFF33] font-bold rounded-lg border border-[#FFFF33]/35 text-sm hover:bg-[#FFFF33]/25 transition"
            >
              <span>📖 Règles du Jeu</span>
              <span>{showRules ? "▲" : "▼"}</span>
            </button>

            {showRules && (
              <div className="mt-2 bg-[#020617] border border-[#FFFF33]/25 rounded-xl p-3 text-white text-xs sm:text-sm leading-relaxed max-h-56 overflow-y-auto">
                <h2 className="text-base font-bold text-yellow-400 mb-2 text-center">
                  Comment Jouer
                </h2>
                <div className="space-y-3">
                  <div>
                    <h3 className="text-yellow-400 font-semibold">🎯 Objectif</h3>
                    <p>Devinez où la bille va atterrir sur la roue.</p>
                  </div>
                  <div>
                    <h3 className="text-yellow-400 font-semibold">🎲 Mises</h3>
                    <ul className="list-disc ml-4">
                      <li>Numéro unique (×35)</li>
                      <li>Rouge / Noir / Pair / Impair (×2)</li>
                      <li>Douzaines (×3)</li>
                    </ul>
                  </div>
                  <div>
                    <h3 className="text-yellow-400 font-semibold">⚠️ Règle</h3>
                    <p>Le 0 (vert) fait perdre la plupart des mises.</p>
                  </div>
                </div>
              </div>
            )}
          </div>

      {/* Result */}
      {result && (
            <div
              className={`w-full p-3 rounded-lg border text-center font-bold text-sm transition-all duration-300 animate-fade-in
                ${
                  result.win
                    ? "bg-green-900/30 border-green-400/40 text-green-300 shadow-[0_0_20px_rgba(34,197,94,0.3)]"
                    : "bg-red-900/20 border-red-400/30 text-red-300"
                }
              `}
            >
              Résultat :{" "}
              <span
                className={`inline-block px-2 py-0.5 rounded text-sm font-extrabold ml-1 ${lastNumColor(result.number)}`}
              >
                {result.number}
              </span>
              {result.win
                ? ` — Gagné ${result.amount.toLocaleString()} jetons ! 🎉`
                : " — Perdu"}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="w-full bg-red-900/30 border border-red-400/30 text-red-300 p-2 rounded text-xs text-center">
              {error}
            </div>
          )}

          {/* Stats */}
          <div className="w-full bg-[#001933]/60 border border-[#FFFF33]/15 rounded-lg p-3 text-xs text-[#FFFF33]/70 space-y-1">
            <div className="flex justify-between">
              <span>Tours joués</span>
              <span className="text-white font-bold">{stats.totalBets}</span>
            </div>
            <div className="flex justify-between">
              <span>Victoires</span>
              <span className="text-green-400 font-bold">{stats.totalWins}</span>
            </div>
            <div className="flex justify-between">
              <span>Plus gros gain</span>
              <span className="text-[#FFFF33] font-bold">
                {stats.biggestWin.toLocaleString()}
              </span>
            </div>
          </div>
        </div>

        {/* ── Right side: wheel + table ──────────────────────── */}
        <div className="flex w-full min-w-0 flex-col items-center">
          {/* Hot numbers strip */}
          {lastResults.length > 0 && (
            <div className="w-full max-w-[440px] mb-3 flex items-center gap-2 overflow-x-auto px-1">
              <span className="text-[#FFFF33]/60 text-xs font-bold whitespace-nowrap">
                Historique
              </span>
              {lastResults.map((num, i) => (
                <span
                  key={i}
                  className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold flex-shrink-0 border border-white/10
                    ${lastNumColor(num)}
                    ${i === 0 ? "ring-2 ring-[#FFFF33] scale-110" : "opacity-70"}
                  `}
                >
                  {num}
                </span>
              ))}
            </div>
          )}

          {/* Wheel + pointer */}
          <div className="relative mx-auto w-full max-w-[420px] aspect-square">
            <canvas
              ref={canvasRef}
              width={CANVAS_SIZE}
              height={CANVAS_SIZE}
              className="w-full h-full rounded-full"
              style={{ maxWidth: CANVAS_SIZE, maxHeight: CANVAS_SIZE }}
            />
          </div>

          {/* Number grid */}
          <div className="w-full max-w-[440px] mt-4 px-1">
            {renderNumberGrid()}
          </div>

          {/* Betting zones */}
          <div className="mt-3 flex flex-wrap gap-1.5 justify-center w-full max-w-[440px] px-1">
            {[
              { key: "1-12", label: "1-12" },
              { key: "13-24", label: "13-24" },
              { key: "25-36", label: "25-36" },
              { key: "1-18", label: "1-18" },
              { key: "even", label: "Pair" },
              { key: "red", label: "Rouge" },
              { key: "black", label: "Noir" },
              { key: "odd", label: "Impair" },
              { key: "19-36", label: "19-36" },
              { key: "green", label: "Vert" },
            ].map(({ key, label }) => (
              <button
                key={key}
                onClick={() => placeBet(key)}
                className={`relative px-2.5 py-1.5 rounded border border-[#FFFF33]/30 text-xs sm:text-sm font-bold capitalize transition-all duration-150
                  hover:scale-105 hover:brightness-110 active:scale-95
                  ${
                    key === "red"
                      ? "bg-[#c0392b] text-white"
                      : key === "black"
                        ? "bg-[#1a1a2e] text-[#FFFF33]"
                        : key === "green"
                          ? "bg-[#0d5e2e] text-white"
                          : "bg-[#102542] text-white"
                  }
                  ${bets[key] ? "ring-2 ring-[#FFFF33] shadow-[0_0_15px_rgba(255,255,51,0.5)]" : ""}
                `}
              >
                {label}
                {bets[key] && (
                  <span className={`absolute -top-2 -right-2 bg-[#FFFF33]/90 text-black text-[10px] font-bold px-1.5 py-0.5 rounded-full shadow-[0_0_8px_rgba(255,255,51,0.5)] ${newChipKeys.some(k => k.startsWith(`${key}-`)) ? "animate-bet-chip" : ""}`}>
                    {bets[key]}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Bet-chip scale animation keyframes */}
      <style jsx>{`
        @keyframes betChipPop {
          0% { transform: scale(0); opacity: 0; }
          50% { transform: scale(1.3); }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes fadeIn {
          0% { opacity: 0; transform: translateY(8px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        .animate-bet-chip {
          animation: betChipPop 0.3s ease-out;
        }
        .animate-fade-in {
          animation: fadeIn 0.4s ease-out;
        }
      `}</style>
    </div>
  );
}
