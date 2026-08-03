"use client";
import React, { useState, useEffect, useRef } from "react";
import BetPanel from "../../../components/BetPanel";
import BetStatus from "../../../components/BetStatus";
import Link from "next/link";
import NavigationBar from "../../../components/navigation-bar";
import { usePostHog } from "posthog-js/react";
import { motion, AnimatePresence } from "framer-motion";
import { celebrateWin, gameOverModal } from "../../../lib/animations";
import { playCardDraw, playVictory, playDefeat } from "../../../lib/gameAudio";
import CrashEngine from "../../../components/games/crash-engine/CrashEngine";
import CashoutButton from "../../../components/games/crash-engine/CashoutButton";
import Rocket from "../../../components/games/crash-engine/Rocket";
import { CRASH_MIN, CRASH_RANGE } from "../../../lib/games/crash/constants";

export default function Page() {
  const posthog = usePostHog();
  const [displayMultiplier, setDisplayMultiplier] = useState(1.0);
  const [isCrashed, setIsCrashed] = useState(false);
  const [gameRunning, setGameRunning] = useState(false);
  const [crashPoint, setCrashPoint] = useState(0);
  const [betAmount, setBetAmount] = useState(0);
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
  const [cashoutPopupAmount, setCashoutPopupAmount] = useState(0);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const resultCelebratedRef = useRef(false);
  const crashEngineRef = useRef(null);
  const [showRules, setShowRules] = useState(false);

  // Server-authoritative crash point (received from API)
  const serverCrashPointRef = useRef(0);

  const countdownRef = useRef(null);

  useEffect(() => {
    if (isCountingDown && countdown > 0) {
      countdownRef.current = setTimeout(() => {
        setCountdown((prev) => prev - 1);
        playCardDraw();
      }, 1000);
    } else if (isCountingDown && countdown === 0) {
      setIsCountingDown(false);
      actuallyStartGame();
      resultCelebratedRef.current = false;
    }
    return () => clearTimeout(countdownRef.current);
  }, [isCountingDown, countdown]);

  function initiateCountdown() {
    if (!hasBet || !betAmount || betAmount <= 0) {
      setError("You must place a bet before starting the game!");
      return;
    }
    setError(null);
    setCountdown(3);
    setIsCountingDown(true);
  }

  function actuallyStartGame() {
    // Use server-authoritative crash point
    const generatedCrashPoint = serverCrashPointRef.current || 2.0;
    setCrashPoint(generatedCrashPoint);
    setIsCrashed(false);
    setDisplayMultiplier(1.0);
    setGameRunning(true);
    setCashedOut(false);
    setFinalMultiplier(null);
    setShowCashoutPopup(false);
    setCashoutPopupMultiplier(null);
  }

  function startGame() {
    initiateCountdown();
  }

  function resetBet() {
    setBetAmount(0);
    setHasBet(false);
    setError(null);
  }

  // ── Casino callbacks: CrashEngine → page.jsx casino logic ──────────────

  function handleCrash(lossMultiplier) {
    setIsCrashed(true);
    setGameRunning(false);
    setDisplayMultiplier(lossMultiplier);
    setCrashHistory((prev) => [lossMultiplier, ...prev.slice(0, 10)]);
    setFinalMultiplier(lossMultiplier);

    setRefreshCounter((prev) => prev + 1);
    resetBet();
    resultCelebratedRef.current = false;
    playDefeat();
    posthog?.capture("crash_game_ended", { result: "loss", bet_amount: betAmount, multiplier: lossMultiplier });
  }

  function handleCashoutClick(multiplier) {
    settleCashOut(multiplier);
  }

  function handleMultiplierUpdate(multiplier, crashed) {
    setDisplayMultiplier(multiplier);
    setIsCrashed(crashed);

    // Auto-cashout detection — now handled by the casino layer, not the engine
    if (!crashed && !cashedOut && autoCashout > 0 && multiplier >= autoCashout) {
      crashEngineRef.current?.cashout();
    }
  }

  // ── Casino betting / settlement (unchanged core logic) ─────────────────

  async function placeBet(amount, autoCashoutValue) {
    setBetAmount(amount);
    setAutoCashout(autoCashoutValue);
    setHasBet(true);
    setCashedOut(false);
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/crash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          betAmount: amount,
          multiplier: 0,
          immediateDeduct: true,
        }),
      });

      const data = await res.json();

      if (data.success) {
        // Store server-authoritative crash point
        if (typeof data.crashPoint === "number") {
          serverCrashPointRef.current = data.crashPoint;
        } else {
          // Fallback if API doesn't return crashPoint (for backwards compat)
          serverCrashPointRef.current = Number((Math.random() * CRASH_RANGE + CRASH_MIN).toFixed(2));
        }
        setRefreshCounter((prev) => prev + 1);
        posthog?.capture("crash_game_started", { bet_amount: amount, auto_cashout: autoCashoutValue });
      } else {
        setError(data.error || "Failed to place bet");
        resetBet();
      }
    } catch (err) {
      console.error("Error placing bet:", err);
      setError("Network error placing bet");
      resetBet();
    } finally {
      setLoading(false);
    }
  }

  async function settleCashOut(cashoutMultiplier) {
    if (cashedOut) return;

    setCashedOut(true);
    const winMultiplier = parseFloat(cashoutMultiplier.toFixed(2));
    setFinalMultiplier(winMultiplier);
    setGameRunning(false);
    setDisplayMultiplier(winMultiplier);

    try {
      const res = await fetch("/api/crash/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          betAmount,
          multiplier: winMultiplier,
          gameWon: true,
        }),
      });

      const data = await res.json();

      if (data.success) {
        // Celebrate only AFTER confirmed API success
        if (!resultCelebratedRef.current) {
          resultCelebratedRef.current = true;
          celebrateWin();
          playVictory();
        }
        const winAmount = betAmount * winMultiplier;
        setCashoutPopupMultiplier(winMultiplier);
        setCashoutPopupAmount(winAmount);
        setShowCashoutPopup(true);
        posthog?.capture("crash_game_ended", { result: "win", bet_amount: betAmount, multiplier: winMultiplier, payout: winAmount });
      } else {
        setError(data.error || "Cashout failed");
        // Revert state
        setCashedOut(false);
      }
    } catch (err) {
      console.error("Crash win network error:", err);
      setError("Network error during cashout");
      setCashedOut(false);
    }

    setRefreshCounter((prev) => prev + 1);
    resetBet();
  }

  return (
    <div className="flex min-h-screen flex-col items-center overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-4 md:pb-8">
      <NavigationBar currentPath="/casino" />
      <div className="mt-4 flex w-full max-w-7xl flex-col gap-4 lg:mt-8 lg:flex-row">
        {/* Left Panel - BetPanel + Crash History */}
        <div
          className="bg-[#050d1f]/80 
border border-[#00e5ff]/40 
backdrop-blur-xl
shadow-[0_0_25px_rgba(0,229,255,0.25),inset_0_0_25px_rgba(0,229,255,0.08)]
p-4 rounded-2xl
relative overflow-hidden w-full lg:w-1/4 flex flex-col"
        >
          <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent opacity-70" />
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
                    mult < 2
                      ? "bg-red-900/40 border border-red-500/60 text-red-200 shadow-[0_0_8px_rgba(255,0,0,0.3)]"
                      : mult < 5
                        ? "bg-cyan-900/40 border border-cyan-400/60 text-cyan-200 shadow-[0_0_8px_rgba(0,229,255,0.3)]"
                        : "bg-yellow-900/40 border border-yellow-400/60 text-yellow-200 shadow-[0_0_8px_rgba(255,215,0,0.3)]"
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

        {/* Center — Crash Engine */}
        <div
          className="relative bg-[#050d1f]/80 
border border-[#00e5ff]/40 
backdrop-blur-xl
shadow-[0_0_25px_rgba(0,229,255,0.25),inset_0_0_25px_rgba(0,229,255,0.08)]
p-4 rounded-2xl
relative overflow-hidden w-full lg:w-2/4 h-[600px] overflow-hidden flex items-center justify-center"
        >
          <div className="absolute inset-0 space-bg" />

          {isCountingDown && (
            <div className="absolute inset-0 bg-black bg-opacity-60 z-50 flex items-center justify-center">
              <div className="text-8xl font-bold text-white animate-pulse">
                {countdown > 0 ? countdown : "GO"}
              </div>
            </div>
          )}

          {/* Loading overlay */}
          {loading && (
            <div className="absolute inset-0 bg-black/40 z-40 flex items-center justify-center">
              <span className="inline-block w-10 h-10 border-3 border-[#00e5ff] border-t-transparent rounded-full animate-spin"></span>
            </div>
          )}

          {/* ── CrashEngine replaces the old canvas + multiplier + Y-axis + explosion ── */}
          <CrashEngine
            ref={crashEngineRef}
            crashPoint={crashPoint}
            running={gameRunning}
            onCashout={handleCashoutClick}
            onCrash={handleCrash}
            onMultiplierUpdate={handleMultiplierUpdate}
          />
        </div>

        {/* Right Panel */}
        <div
          className="bg-[#050d1f]/80 
border border-[#00e5ff]/40 
backdrop-blur-xl
shadow-[0_0_25px_rgba(0,229,255,0.25),inset_0_0_25px_rgba(0,229,255,0.08)]
p-4 rounded-2xl
relative overflow-hidden w-full lg:w-1/4 flex flex-col"
        >
          <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent opacity-70" />

          {/* Error display */}
          {error && (
            <div className="mb-3 bg-red-900/30 border border-red-400/40 text-red-300 p-2 rounded text-xs text-center">
              {error}
            </div>
          )}

          <div className="mb-6 flex flex-col gap-3">
            {!gameRunning && !isCountingDown && (
              <button
                onClick={startGame}
                className={`px-4 py-3 rounded-lg font-bold text-lg w-full ${
                  hasBet && betAmount > 0
                    ? "bg-gradient-to-r from-[#00e5ff] to-[#007cf0] text-white border border-[#00e5ff] shadow-[0_0_18px_rgba(0,229,255,0.5)] hover:shadow-[0_0_30px_rgba(0,229,255,0.9)] hover:scale-105 transition-all duration-300 shadow-[0_0_16px_rgba(255,215,0,0.45)]"
                    : "bg-gray-500 cursor-not-allowed"
                }`}
                disabled={!hasBet || !betAmount || betAmount <= 0}
              >
                {!hasBet || !betAmount || betAmount <= 0
                  ? "Place Bet First"
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
              <CashoutButton
                onCashout={() => crashEngineRef.current?.cashout()}
                disabled={isCrashed || cashedOut}
              />
            )}
            <Link
              href="/casino"
              className="bg-gradient-to-r from-[#ff4fd8] to-[#ff00aa]
text-white
border border-[#ff4fd8]
shadow-[0_0_18px_rgba(255,79,216,0.5)]
hover:shadow-[0_0_30px_rgba(255,79,216,0.9)]
hover:scale-105
transition-all duration-300 hover:bg-[#ffe14f] text-[#030817] px-4 py-3 rounded-lg font-bold text-lg text-center shadow-[0_0_14px_rgba(255,215,0,0.45)]"
            >
              Return to Casino
            </Link>
          </div>

          <BetStatus
            hasBet={hasBet}
            betAmount={betAmount}
            cashedOut={cashedOut}
            multiplier={displayMultiplier}
          />
        </div>
      </div>

      <AnimatePresence>
        {showCashoutPopup && cashoutPopupMultiplier !== null && (
          <motion.div
            key="crash-cashout"
            {...gameOverModal.backdrop}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm"
          >
            <motion.div
              {...gameOverModal.panel}
              className="relative w-full max-w-sm overflow-hidden rounded-3xl border-4 border-amber-400 bg-gradient-to-b from-[#1a3a1a] to-[#0d2b0d] p-6 text-center shadow-[0_0_60px_rgba(251,191,36,0.4)]"
            >
              <Rocket animate size="text-7xl" />
              <motion.h2
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.5, duration: 0.4 }}
                className="mt-3 text-3xl font-black text-amber-300 uppercase"
              >
                Cash Out!
              </motion.h2>
              <motion.p
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.6, duration: 0.4 }}
                className="mt-2 text-xl font-bold text-green-400"
              >
                {cashoutPopupMultiplier.toFixed(2)}x
              </motion.p>
              <motion.p
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.7, duration: 0.4 }}
                className="text-2xl font-black text-[#FFD700]"
              >
                +{cashoutPopupAmount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })} tokens
              </motion.p>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 1.0 }}
                className="mt-3 flex justify-center gap-1"
              >
                {["✨", "🌟", "✨", "🌟", "✨"].map((s, i) => (
                  <motion.span key={i} className="text-xl" animate={{ y: [0, -6, 0], opacity: [0.4, 1, 0.4] }} transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.12 }}>{s}</motion.span>
                ))}
              </motion.div>
              <motion.div
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.8, duration: 0.4 }}
                className="mt-6"
              >
                <button
                  onClick={() => setShowCashoutPopup(false)}
                  className="rounded-xl border-b-4 border-amber-700 bg-amber-400 px-8 py-3 text-lg font-black text-black shadow-[0_0_25px_rgba(251,191,36,0.5)] transition active:translate-y-[2px]"
                >
                  Nice!
                </button>
              </motion.div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

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
              🚀 The multiplier starts at <strong>1.00x</strong> and increases
              over time.
            </p>
            <p>
              💥 The game can <strong>crash at any moment</strong> — if it
              crashes before you cash out, you lose your bet.
            </p>
            <p>
              💰 Click <strong>Cash Out</strong> before the crash to secure your
              winnings.
            </p>
            <p>
              ⚙️ You can set an <strong>auto cashout</strong> to automatically
              exit at a chosen multiplier.
            </p>
            <p>
              📈 The longer you wait, the higher the multiplier… but the higher
              the risk.
            </p>
          </div>
        )}
      </div>


    </div>
  );
}
