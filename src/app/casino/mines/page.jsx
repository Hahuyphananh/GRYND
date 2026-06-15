"use client";
import React, { useState, useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { usePostHog } from "posthog-js/react";
import NavigationBar from "../../../components/navigation-bar";
import { getMinesMultiplier } from "../../../lib/minesMath";
import { celebrateWin, gameOverModal } from "../../../lib/animations";
import { playCardDraw, playVictory, playDefeat } from "../../../lib/gameAudio";
import { CHIP_VALUES } from "../../../lib/rouletteConfig";

export default function MinesGamePage() {
  const posthog = usePostHog();
  const GRID_SIZE = 5;
  const [totalMines, setTotalMines] = useState(3);
  const [grid, setGrid] = useState(Array(GRID_SIZE ** 2).fill("diamond"));
  const [revealed, setRevealed] = useState(Array(GRID_SIZE ** 2).fill(false));
  const [gameOver, setGameOver] = useState(false);
  const [multiplier, setMultiplier] = useState(1);
  const [hasWon, setHasWon] = useState(false);
  const [autoplayEnabled, setAutoplayEnabled] = useState(false);
  const [revealedCount, setRevealedCount] = useState(0);
  const [showAllMines, setShowAllMines] = useState(false);
  const [autoCashoutAt, setAutoCashoutAt] = useState(2.0);
  const [autoplaySpeed, setAutoplaySpeed] = useState(500);
  const [autoplaySettings, setAutoplaySettings] = useState(false);
  const [userTokens, setUserTokens] = useState(0);
  const [loading, setLoading] = useState(false);
  const [betAmount, setBetAmount] = useState(10);
  const [error, setError] = useState(null);
  const [gameStarted, setGameStarted] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showResultModal, setShowResultModal] = useState(false);
  const resultCelebratedRef = useRef(false);
  const [sessionResults, setSessionResults] = useState([]); // history of multipliers hit

  // ── Refs for stale closure safety ──
  const isProcessingRef = useRef(false);
  const userTokensRef = useRef(userTokens);
  const betAmountRef = useRef(betAmount);
  const gameOverRef = useRef(gameOver);
  const autoplayEnabledRef = useRef(autoplayEnabled);
  const multiplierRef = useRef(multiplier);
  const revealedCountRef = useRef(revealedCount);

  useEffect(() => { userTokensRef.current = userTokens; }, [userTokens]);
  useEffect(() => { betAmountRef.current = betAmount; }, [betAmount]);
  useEffect(() => { gameOverRef.current = gameOver; }, [gameOver]);
  useEffect(() => { autoplayEnabledRef.current = autoplayEnabled; }, [autoplayEnabled]);
  useEffect(() => { multiplierRef.current = multiplier; }, [multiplier]);
  useEffect(() => { revealedCountRef.current = revealedCount; }, [revealedCount]);

  const autoplayTimerRef = useRef(null);

  // Fetch user tokens
  useEffect(() => {
    async function fetchTokens() {
      setLoading(true);
      try {
        const response = await fetch("/api/get-user-tokens", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
        });
        const data = await response.json();
        if (data.success) {
          setUserTokens(data.data.balance);
        } else {
          throw new Error(data.error || "Unknown error");
        }
      } catch (err) {
        console.error("Error fetching tokens:", err);
        setError("Impossible de récupérer votre solde de tokens");
      } finally {
        setLoading(false);
      }
    }
    fetchTokens();
  }, []);

  // Handle autoplay timer
  useEffect(() => {
    if (autoplayEnabled && !gameOver) {
      startAutoplay();
    } else {
      stopAutoplay();
    }
    return () => stopAutoplay();
  }, [autoplayEnabled, gameOver]);

  // Regenerate grid when totalMines changes — also reset game state since server session is stale
  useEffect(() => {
    setGrid(Array(GRID_SIZE ** 2).fill("diamond"));
    setRevealed(Array(GRID_SIZE ** 2).fill(false));
    revealedRef.current = Array(GRID_SIZE ** 2).fill(false);
    setGameOver(false);
    setMultiplier(1);
    setHasWon(false);
    setRevealedCount(0);
    setShowAllMines(false);
    setGameStarted(false); // require fresh "NEW GAME" after mine count change
    setAutoplayEnabled(false);
  }, [totalMines]);

  function handleCustomMineInput(e) {
    e.preventDefault();
    const inputField = document.getElementById("custom-mine-input");
    const mineCount = parseInt(inputField.value, 10);

    if (isNaN(mineCount) || mineCount < 1) {
      setError("Please enter a valid number (1-24)");
      return;
    }

    const maxMines = GRID_SIZE * GRID_SIZE - 1;
    const finalMineCount = Math.min(Math.max(1, mineCount), maxMines);
    setTotalMines(finalMineCount);
    inputField.value = "";
    setError(null);
  }

  // ── Autoplay: calls the reveal API for each cell ──
  async function autoplayRevealCell() {
    if (!autoplayEnabledRef.current) return;
    if (gameOverRef.current) {
      stopAutoplay();
      return;
    }
    if (isProcessingRef.current) return;

    isProcessingRef.current = true;

    try {
      // Check cashout condition
      if (multiplierRef.current >= autoCashoutAt && revealedCountRef.current > 0) {
        await handleCashOut();
        stopAutoplay();
        return;
      }

      // Find all unrevealed cells
      const unrevealed = [];
      for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
        if (!revealedRef.current[i]) {
          unrevealed.push(i);
        }
      }

      if (unrevealed.length === 0) {
        stopAutoplay();
        return;
      }

      const randomIndex = Math.floor(Math.random() * unrevealed.length);
      const cellIndex = unrevealed[randomIndex];

      // Call the reveal API
      const revealRes = await fetch("/api/mines/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ index: cellIndex }),
      });
      const revealData = await revealRes.json();

      if (!revealData.success) {
        console.error("Autoplay reveal failed:", revealData.error);
        return;
      }

      // Update local revealed state
      const newRevealed = [...revealedRef.current];
      newRevealed[cellIndex] = true;
      setRevealed(newRevealed);
      revealedRef.current = newRevealed;
      playCardDraw();

      if (revealData.data?.mineHit) {
        // Mine hit — game over
        setGameOver(true);
        setMultiplier(0);
        setShowAllMines(true);
        setAutoplayEnabled(false);
        setShowResultModal(true);
        gameOverRef.current = true;

        if (Array.isArray(revealData.data.minePositions)) {
          const nextGrid = Array(GRID_SIZE * GRID_SIZE).fill("diamond");
          revealData.data.minePositions.forEach((pos) => {
            if (Number.isInteger(pos) && pos >= 0 && pos < nextGrid.length)
              nextGrid[pos] = "mine";
          });
          setGrid(nextGrid);
        }          // Record in session history
        setSessionResults((prev) => [...prev, { multiplier: 0, result: "loss" }]);
        playDefeat();
        posthog?.capture("mines_game_ended", { result: "loss", bet_amount: betAmountRef.current, multiplier: 0, mines: totalMines, revealed: revealedCountRef.current });
        return;
      }

      // Diamond revealed
      const newRevealedCount = revealedCountRef.current + 1;
      setRevealedCount(newRevealedCount);
      revealedCountRef.current = newRevealedCount;

      const newMultiplier = calculateMultiplier(totalMines, newRevealedCount);
      setMultiplier(newMultiplier);
      multiplierRef.current = newMultiplier;

      // Check win condition
      const safeCells = GRID_SIZE * GRID_SIZE - totalMines;
      if (newRevealedCount >= safeCells) {
        setHasWon(true);
        setGameOver(true);
        setShowAllMines(true);
        setAutoplayEnabled(false);
        setShowResultModal(true);
        gameOverRef.current = true;
        setSessionResults((prev) => [...prev, { multiplier: newMultiplier, result: "win" }]);
        if (!resultCelebratedRef.current) {
          resultCelebratedRef.current = true;
          celebrateWin();
        }
        playVictory();
        posthog?.capture("mines_game_ended", { result: "win", bet_amount: betAmountRef.current, multiplier: newMultiplier, mines: totalMines, revealed: newRevealedCount });
        await handleCashOutInternal();
      }
    } catch (err) {
      console.error("Autoplay error:", err);
    } finally {
      isProcessingRef.current = false;
    }
  }

  function startAutoplay() {
    if (autoplayTimerRef.current) {
      clearInterval(autoplayTimerRef.current);
    }
    autoplayTimerRef.current = setInterval(() => {
      autoplayRevealCell();
    }, autoplaySpeed);
  }

  function stopAutoplay() {
    if (autoplayTimerRef.current) {
      clearInterval(autoplayTimerRef.current);
      autoplayTimerRef.current = null;
    }
  }

  function calculateMultiplier(mines, revealed) {
    return getMinesMultiplier(mines, revealed);
  }

  // Refs used by autoplay to read current revealed state
  const revealedRef = useRef(revealed);
  useEffect(() => { revealedRef.current = revealed; }, [revealed]);

  async function handleClick(index) {
    if (!gameStarted) return false;
    if (revealedRef.current[index] || gameOverRef.current) return false;
    if (isProcessingRef.current) return false;

    isProcessingRef.current = true;
    setLoading(true);

    const updated = [...revealedRef.current];
    updated[index] = true;
    setRevealed(updated);
    revealedRef.current = updated;

    const newRevealedCount = revealedCount + 1;
    setRevealedCount(newRevealedCount);
    revealedCountRef.current = newRevealedCount;
    playCardDraw();

    try {
      const revealRes = await fetch("/api/mines/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ index }),
      });
      const revealData = await revealRes.json();

      if (!revealData.success) {
        console.error("Reveal failed:", revealData.error);
        // Rollback
        const rolledBack = [...revealedRef.current];
        rolledBack[index] = false;
        setRevealed(rolledBack);
        revealedRef.current = rolledBack;
        setRevealedCount(revealedCount);
        revealedCountRef.current = revealedCount;
        return false;
      }

      if (revealData.data?.mineHit) {
        setGameOver(true);
        setMultiplier(0);
        setShowAllMines(true);
        setAutoplayEnabled(false);
        setShowResultModal(true);
        gameOverRef.current = true;
        setSessionResults((prev) => [...prev, { multiplier: 0, result: "loss" }]);
        playDefeat();
        posthog?.capture("mines_game_ended", { result: "loss", bet_amount: betAmount, multiplier: 0, mines: totalMines, revealed: revealedCount + 1 });

        if (Array.isArray(revealData.data.minePositions)) {
          const nextGrid = Array(GRID_SIZE * GRID_SIZE).fill("diamond");
          revealData.data.minePositions.forEach((pos) => {
            if (Number.isInteger(pos) && pos >= 0 && pos < nextGrid.length)
              nextGrid[pos] = "mine";
          });
          setGrid(nextGrid);
        }
        return true;
      }
    } catch (err) {
      console.error("Network error on reveal:", err);
      // Rollback
      const rolledBack = [...revealedRef.current];
      rolledBack[index] = false;
      setRevealed(rolledBack);
      revealedRef.current = rolledBack;
      setRevealedCount(revealedCount);
      revealedCountRef.current = revealedCount;
      return false;
    } finally {
      isProcessingRef.current = false;
      setLoading(false);
    }

    const newMultiplier = calculateMultiplier(totalMines, newRevealedCount);
    setMultiplier(newMultiplier);
    multiplierRef.current = newMultiplier;

    const safeCells = GRID_SIZE * GRID_SIZE - totalMines;
    if (newRevealedCount >= safeCells) {
      setHasWon(true);
      setGameOver(true);
      setShowAllMines(true);
      setAutoplayEnabled(false);
      setShowResultModal(true);
      gameOverRef.current = true;
      setSessionResults((prev) => [...prev, { multiplier: newMultiplier, result: "win" }]);
      if (!resultCelebratedRef.current) {
        resultCelebratedRef.current = true;
        celebrateWin();
      }
      playVictory();
      posthog?.capture("mines_game_ended", { result: "win", bet_amount: betAmount, multiplier: newMultiplier, mines: totalMines, revealed: newRevealedCount });
    }
    return false;
  }

  async function handleCashOutInternal() {
    try {
      const res = await fetch("/api/mines/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "cashout" }),
      });
      const data = await res.json();
      if (data.success) {
        setUserTokens(data.data.newBalance);
        userTokensRef.current = data.data.newBalance;
      }
    } catch (err) {
      console.error("Settle error:", err);
    }
  }

  async function handleCashOut() {
    setHasWon(true);
    setGameOver(true);
    setShowAllMines(true);
    setAutoplayEnabled(false);
    setShowResultModal(true);
    gameOverRef.current = true;
    const currentMult = multiplierRef.current;
    setSessionResults((prev) => [...prev, { multiplier: currentMult, result: "win" }]);
    if (!resultCelebratedRef.current) {
      resultCelebratedRef.current = true;
      celebrateWin();
    }
    playVictory();
    posthog?.capture("mines_game_ended", { result: "win", bet_amount: betAmount, multiplier: currentMult, mines: totalMines, revealed: revealedCount });
    await handleCashOutInternal();
  }

  async function handleReset() {
    if (isProcessingRef.current) return;

    isProcessingRef.current = true;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/mines/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ betAmount: betAmountRef.current, mines: totalMines }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Unable to start game");
        return;
      }
      setUserTokens(data.data.newBalance);
      userTokensRef.current = data.data.newBalance;
    } catch (err) {
      console.error("Error starting mines game:", err);
      setError("Unable to start game");
      return;
    } finally {
      isProcessingRef.current = false;
      setLoading(false);
    }

    setGrid(Array(GRID_SIZE ** 2).fill("diamond"));
    setRevealed(Array(GRID_SIZE ** 2).fill(false));
    revealedRef.current = Array(GRID_SIZE ** 2).fill(false);
    setGameOver(false);
    gameOverRef.current = false;
    setMultiplier(1);
    multiplierRef.current = 1;
    setHasWon(false);
    setRevealedCount(0);
    revealedCountRef.current = 0;
    setShowAllMines(false);
    setAutoplaySettings(false);      setGameStarted(true);
    setShowResultModal(false);
    resultCelebratedRef.current = false;
    posthog?.capture("mines_game_started", { bet_amount: betAmount, mines: totalMines });
  }

  function handleMineChange(mines) {
    setTotalMines(mines);
    setError(null);
  }

  function toggleAutoplay() {
    if (gameOver) return;
    if (!autoplayEnabled) {
      setAutoplaySettings(true);
    } else {
      setAutoplayEnabled(false);
    }
  }

  function startAutoplayWithSettings() {
    setAutoplaySettings(false);
    setAutoplayEnabled(true);
    autoplayEnabledRef.current = true;
  }

  function getCellContent(cellType, index) {
    if (revealed[index]) {
      return cellType === "mine" ? <AnimatedBomb exploded={gameOver} /> : "💎";
    }
    if (showAllMines && cellType === "mine") {
      return <AnimatedBomb exploded />;
    }
    return "❓";
  }

  function getCellStyle(cellType, index) {
    const baseStyle = gameOver ? "opacity-70" : "";

    if (revealed[index]) {
      return `${baseStyle} ${
        cellType === "mine"
          ? "bg-[#3b1021] border border-[#ff4fd8] shadow-[0_0_14px_rgba(255,79,216,0.5)]"
          : "bg-[#09243f] border border-[#00e5ff] shadow-[0_0_12px_rgba(0,229,255,0.45)]"
      }`;
    }

    if (showAllMines && cellType === "mine") {
      return `${baseStyle} bg-[#3b1021] border border-[#ff4fd8] shadow-[0_0_14px_rgba(255,79,216,0.5)]`;
    }

    return `${baseStyle} ${
      gameOver
        ? "bg-[#0c1a33] border border-[#1f3a6a]"
        : "bg-[#071226] border border-[#00e5ff]/20 hover:border-[#00e5ff]/70 hover:shadow-[0_0_16px_rgba(0,229,255,0.35)]"
    }`;
  }

  const maxMultiplier = calculateMultiplier(
    totalMines,
    GRID_SIZE * GRID_SIZE - totalMines - 1,
  );

  function AnimatedBomb({ exploded = false }) {
    return (
      <span
        className={`
        relative text-4xl
        ${exploded ? "animate-bomb-explode" : "animate-bomb-fuse"}
      `}
      >
        💣
        {!exploded && (
          <span className="absolute -top-2 -right-2 text-orange-400 animate-ping">
            ✨
          </span>
        )}
      </span>
    );
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-start overflow-x-clip bg-[#030817] px-3 pb-24 pt-20 text-white sm:px-4 md:pb-8">
      <NavigationBar currentPath="/casino" />

      {/* Autoplay Settings Modal */}
      <AnimatePresence>
        {autoplaySettings && (
          <motion.div
            key="autoplay-settings"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="w-full max-w-sm rounded-2xl border border-[#00e5ff]/40 bg-[#03142b] p-6 shadow-[0_0_40px_rgba(0,229,255,0.15)]"
            >
              <h3 className="text-xl font-bold text-[#00e5ff] mb-4 text-center">Auto Play Settings</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-gray-300 mb-1">Auto Cashout At</label>
                  <input
                    type="number"
                    min="1.1"
                    step="0.1"
                    value={autoCashoutAt}
                    onChange={(e) => setAutoCashoutAt(Number(e.target.value) || 1.1)}
                    className="w-full rounded-lg border border-[#00e5ff]/30 bg-[#071226] px-3 py-2 text-white text-center focus:border-[#00e5ff] focus:outline-none"
                  />
                  <p className="text-xs text-gray-400 mt-1 text-center">Auto cash out when multiplier reaches this value</p>
                </div>
                <div>
                  <label className="block text-sm text-gray-300 mb-1">Speed (ms)</label>
                  <select
                    value={autoplaySpeed}
                    onChange={(e) => setAutoplaySpeed(Number(e.target.value))}
                    className="w-full rounded-lg border border-[#00e5ff]/30 bg-[#071226] px-3 py-2 text-white text-center focus:border-[#00e5ff] focus:outline-none"
                  >
                    <option value={300}>Fast (300ms)</option>
                    <option value={500}>Normal (500ms)</option>
                    <option value={800}>Slow (800ms)</option>
                    <option value={1200}>Very Slow (1.2s)</option>
                  </select>
                </div>
                <div className="flex gap-3 pt-2">
                  <button
                    onClick={() => setAutoplaySettings(false)}
                    className="flex-1 px-4 py-2 rounded-lg border border-gray-500/40 bg-gray-500/20 text-gray-300 font-semibold hover:bg-gray-500/30 transition"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={startAutoplayWithSettings}
                    className="flex-1 px-4 py-2 rounded-lg border border-[#00e5ff]/70 bg-[#07325e] text-white font-bold shadow-[0_0_14px_rgba(0,229,255,0.3)] hover:shadow-[0_0_20px_rgba(0,229,255,0.5)] transition"
                  >
                    Start Auto
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Result Modal */}
      <AnimatePresence>
        {showResultModal && (
          <motion.div
            key="mines-result"
            {...gameOverModal.backdrop}
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm"
          >
            <motion.div
              {...gameOverModal.panel}
              className={`relative w-full max-w-md overflow-hidden rounded-3xl border-4 p-6 text-center shadow-2xl ${
                hasWon
                  ? "border-amber-400 bg-gradient-to-b from-[#1a3a1a] to-[#0d2b0d] shadow-[0_0_60px_rgba(251,191,36,0.4)]"
                  : "border-red-500 bg-gradient-to-b from-[#3a1a1a] to-[#2b0d0d] shadow-[0_0_60px_rgba(239,68,68,0.3)]"
              }`}
            >
              <motion.div
                initial={{ scale: 0, rotate: -30 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: "spring", stiffness: 300, damping: 12, delay: 0.3 }}
                className="mb-2 text-7xl"
              >
                {hasWon ? "🏆" : "💣"}
              </motion.div>
              <motion.h2
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.5, duration: 0.4 }}
                className={`mt-3 text-4xl font-black uppercase ${hasWon ? "text-amber-300" : "text-red-400"}`}
              >
                {hasWon ? `Won ${multiplier.toFixed(2)}x!` : "Boom! Mine Hit"}
              </motion.h2>
              {hasWon && (
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
              )}
              <motion.div
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.8, duration: 0.4 }}
                className="mt-6"
              >
                <button
                  onClick={() => { setShowResultModal(false); handleReset(); }}
                  className={`rounded-xl border-b-4 px-8 py-3 text-lg font-black transition active:translate-y-[2px] ${hasWon ? "border-amber-700 bg-amber-400 text-black shadow-[0_0_25px_rgba(251,191,36,0.5)]" : "border-red-700 bg-red-500 text-white shadow-[0_0_25px_rgba(239,68,68,0.4)]"}`}
                >
                  New Game
                </button>
              </motion.div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className={`bg-gradient-to-br from-[#001933] via-[#00111f] to-[#000814] rounded-2xl border border-[#00e5ff]/40 p-8 w-full max-w-6xl min-w-[80%] shadow-[0_0_60px_rgba(0,229,255,0.2),inset_0_0_30px_rgba(0,229,255,0.08)] ${gameOver ? "relative" : ""}`}>
        {gameOver && (
          <div className="absolute inset-0 bg-black bg-opacity-10 rounded-lg pointer-events-none"></div>
        )}

        <div className="flex flex-col lg:flex-row gap-6">
          {/* Left sidebar */}
          <div className="w-full lg:w-1/4 flex flex-col gap-4">
            <h1 className="text-3xl font-bold text-yellow-400 text-center w-full mt-3">
              💣 Mines
            </h1>

            {/* ── Bet input section ── */}
            <div className="rounded-xl border border-[#00e5ff]/30 bg-[#03142b] p-4 shadow-[inset_0_0_18px_rgba(0,229,255,0.1)]">
              <label htmlFor="bet-input" className="block mb-2 text-center font-semibold">
                Bet Amount
              </label>

              {/* Quick chip values */}
              <div className="flex flex-wrap gap-1.5 justify-center mb-2">
                {CHIP_VALUES.map((val) => (
                  <button
                    key={val}
                    onClick={() => setBetAmount(val)}
                    className={`px-2 py-0.5 rounded-full text-xs font-bold border transition-all duration-150 ${
                      betAmount === val
                        ? "bg-[#FFFF33] text-black border-[#FFFF33] shadow-[0_0_10px_rgba(255,255,51,0.6)] scale-110"
                        : "bg-[#0a1a3a] text-[#FFFF33]/80 border-[#FFFF33]/30 hover:bg-[#FFFF33]/20 hover:border-[#FFFF33]/60"
                    }`}
                  >
                    {val}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1.5">
                <input
                  id="bet-input"
                  type="number"
                  min="0"
                  max={userTokens}
                  value={betAmount}
                  onChange={(e) => {
                    const v = parseInt(e.target.value);
                    setBetAmount(isNaN(v) ? 0 : v);
                  }}
                  onBlur={() => { if (!betAmount || betAmount < 1) setBetAmount(1); }}
                  className="flex-1 rounded-lg border border-[#00e5ff]/40 bg-[#071226] px-2 py-2 text-center text-white focus:border-[#00e5ff] focus:outline-none focus:shadow-[0_0_12px_rgba(0,229,255,0.45)]"
                  disabled={autoplayEnabled}
                  placeholder="Enter your bet"
                />
                <button
                  onClick={() => { if (userTokens) setBetAmount(Math.max(1, Math.floor(userTokens / 2))); }}
                  className="px-2 py-2 rounded-lg border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] text-xs font-bold hover:bg-[#FFFF33]/25 transition"
                >
                  ½
                </button>
                <button
                  onClick={() => { if (userTokens) setBetAmount(Math.max(1, userTokens)); }}
                  className="px-2 py-2 rounded-lg border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] text-xs font-bold hover:bg-[#FFFF33]/25 transition"
                >
                  TOUT
                </button>
                <button
                  onClick={() => setBetAmount((prev) => Math.min(prev * 2, userTokens || 999999))}
                  className="px-2 py-2 rounded-lg border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] text-xs font-bold hover:bg-[#FFFF33]/25 transition"
                >
                  2×
                </button>
              </div>
              <p className="text-xs text-gray-300 mt-1 text-center">
                Balance: {userTokens.toLocaleString()} tokens
              </p>
            </div>

            {/* Mine selection */}
            <div className="rounded-xl border border-[#00e5ff]/30 bg-[#03142b] p-4 shadow-[inset_0_0_18px_rgba(0,229,255,0.1)]">
              <p className="text-lg mb-3 text-center">Select Mines</p>
              <div className="grid grid-cols-3 gap-2">
                {[1, 3, 5, 10, 15, 20].map((mineCount) => (
                  <button
                    key={mineCount}
                    onClick={() => handleMineChange(mineCount)}
                    disabled={autoplayEnabled}
                    className={`py-2 px-1 rounded-lg border text-sm transition-all ${
                      totalMines === mineCount
                        ? "border-[#00e5ff] bg-[#07325e] text-white shadow-[0_0_14px_rgba(0,229,255,0.45)]"
                        : "border-[#00e5ff]/20 bg-[#071226] text-gray-300 hover:border-[#00e5ff]/60"
                    } ${autoplayEnabled ? "opacity-70" : ""}`}
                  >
                    {mineCount}
                  </button>
                ))}
              </div>

              {/* Custom mine input */}
              <form onSubmit={handleCustomMineInput} className="mt-4 flex gap-2">
                <input
                  id="custom-mine-input"
                  type="number"
                  min="1"
                  max={GRID_SIZE * GRID_SIZE - 1}
                  placeholder="Custom"
                  className="w-full rounded-lg border border-[#00e5ff]/30 bg-[#071226] px-2 py-1 text-sm text-white focus:border-[#00e5ff] focus:outline-none"
                  disabled={gameOver || autoplayEnabled}
                />
                <button
                  type="submit"
                  className={`rounded-lg border border-[#ff4fd8]/70 bg-[#39123b] px-2 py-1 text-sm font-semibold text-[#ffd7ff] shadow-[0_0_12px_rgba(255,79,216,0.35)] transition-all hover:shadow-[0_0_16px_rgba(255,79,216,0.55)]
                  ${gameOver || autoplayEnabled ? "opacity-70 cursor-not-allowed" : ""}`}
                  disabled={gameOver || autoplayEnabled}
                >
                  Set
                </button>
              </form>
            </div>

            {/* Game stats */}
            <div className="rounded-xl border border-[#00e5ff]/30 bg-[#03142b] p-4 shadow-[inset_0_0_18px_rgba(0,229,255,0.1)]">
              <div className="flex justify-between items-center mb-2">
                <span className="font-bold">Diamonds:</span>
                <span className="flex items-center">
                  <span className="text-green-400 mr-1">💎</span>
                  {25 - totalMines}
                </span>
              </div>
              <div className="flex justify-between items-center mb-4">
                <span className="font-bold">Mines:</span>
                <span className="flex items-center">
                  <span className="text-purple-500 mr-1">💣</span>
                  {totalMines}
                </span>
              </div>

              {/* Session history strip */}
              {sessionResults.length > 0 && (
                <div className="mt-3 pt-3 border-t border-[#00e5ff]/20">
                  <p className="text-xs text-gray-400 mb-1">Session:</p>
                  <div className="flex flex-wrap gap-1">
                    {sessionResults.slice(-10).map((r, i) => (
                      <span
                        key={i}
                        className={`inline-flex items-center justify-center min-w-[36px] h-5 px-1 rounded text-[10px] font-bold ${
                          r.result === "win"
                            ? "bg-green-500/20 text-green-400 border border-green-500/30"
                            : "bg-red-500/20 text-red-400 border border-red-500/30"
                        }`}
                      >
                        {r.multiplier.toFixed(1)}x
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Main game grid */}
          <div className="w-full lg:w-2/4 relative">
            {!gameStarted && (
              <div
                className="absolute inset-0 z-20 bg-black/50 rounded-lg
                    flex flex-col items-center justify-center text-center"
              >
                <p className="text-2xl font-bold mb-3 animate-pulse">
                  🎮 Click NEW GAME to start
                </p>
                <p className="text-sm text-gray-300">
                  Place your bet, choose mines, then start the game
                </p>
              </div>
            )}

            {loading && gameStarted && (
              <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30">
                <span className="inline-block w-6 h-6 border-2 border-[#00e5ff] border-t-transparent rounded-full animate-spin"></span>
              </div>
            )}

            <div
              className={`grid grid-cols-5 gap-3 ${!gameStarted ? "pointer-events-none" : ""}`}
            >
              {grid.map((cell, i) => (
                <button
                  key={i}
                  onClick={() => handleClick(i)}
                  disabled={
                    !gameStarted ||
                    gameOver ||
                    (showAllMines && cell === "mine") ||
                    autoplayEnabled ||
                    loading
                  }
                  className={`w-full aspect-square rounded-xl flex items-center justify-center
  transition-all duration-300 text-3xl
  ${getCellStyle(cell, i)}
  ${!gameStarted ? "opacity-50 cursor-not-allowed" : ""}
`}
                >
                  {getCellContent(cell, i)}
                </button>
              ))}
            </div>
          </div>

          {/* Right sidebar */}
          <div className="w-full lg:w-1/4 flex flex-col gap-4">
            {/* Tokens */}
            <div className="rounded-xl border border-[#00e5ff]/30 bg-[#03142b] p-4 text-center shadow-[inset_0_0_18px_rgba(0,229,255,0.1)]">
              <p className="text-lg font-semibold mb-1">🪙 Tokens</p>
              <p className="text-yellow-400 text-xl font-bold">{userTokens.toLocaleString()}</p>
            </div>

            {/* Multiplier display */}
            <div className={`rounded-xl border p-4 text-center shadow-[inset_0_0_18px_rgba(0,229,255,0.1)] transition-colors ${
              multiplier > 3 ? "border-[#f5ff3b]/50 bg-[#03142b] shadow-[0_0_20px_rgba(245,255,59,0.15)]" : "border-[#00e5ff]/30 bg-[#03142b]"
            }`}>
              <div className={`text-3xl font-bold mb-1 transition-colors ${
                multiplier > 3 ? "text-[#f5ff3b]" : multiplier > 1.5 ? "text-yellow-400" : "text-green-400"
              }`}>
                {multiplier.toFixed(2)}x
              </div>
              <div className="text-sm text-gray-300">
                Max: {maxMultiplier.toFixed(2)}x
              </div>
              {multiplier > 1 && gameStarted && !gameOver && (
                <div className="mt-2 text-xs text-gray-400">
                  Potential: {(betAmount * multiplier).toFixed(0)} tokens
                </div>
              )}
            </div>

            {/* Action buttons */}
            <div className="rounded-xl border border-[#00e5ff]/30 bg-[#03142b] p-4 flex flex-col gap-3 shadow-[inset_0_0_18px_rgba(0,229,255,0.1)]">
              <button
                onClick={handleCashOut}
                className={`rounded-xl border border-[#ff4fd8]/70 bg-[#39123b] px-4 py-3 text-lg font-bold text-[#ffd7ff] shadow-[0_0_16px_rgba(255,79,216,0.35)] transition-all hover:shadow-[0_0_22px_rgba(255,79,216,0.6)]
                ${
                  !gameStarted ||
                  revealedCount === 0 ||
                  gameOver ||
                  autoplayEnabled
                    ? "opacity-50 cursor-not-allowed"
                    : ""
                }
`}
                disabled={
                  !gameStarted ||
                  revealedCount === 0 ||
                  gameOver ||
                  autoplayEnabled
                }
              >
                {gameStarted && !gameOver && revealedCount > 0
                  ? `CASHOUT (${(betAmount * multiplier).toFixed(0)} tokens)`
                  : "CASHOUT"}
              </button>
              <button
                onClick={toggleAutoplay}
                className={`${autoplayEnabled ? "bg-[#4a3b05] border-[#ffe066]" : "bg-[#0a2643] border-[#00e5ff]/55"} hover:border-[#00e5ff] text-white 
                border font-bold py-3 px-4 rounded-xl text-lg shadow-[0_0_14px_rgba(0,229,255,0.2)] transition-all ${gameOver ? "opacity-70 cursor-not-allowed" : ""}`}
                disabled={gameOver}
              >
                {autoplayEnabled ? "STOP AUTO" : "AUTO PLAY"}
              </button>
              <button
                onClick={handleReset}
                className={`rounded-xl border border-[#00e5ff]/70 bg-[#07325e] px-4 py-3 text-lg font-bold text-white shadow-[0_0_18px_rgba(0,229,255,0.35)] transition-all hover:shadow-[0_0_24px_rgba(0,229,255,0.6)]
                ${autoplayEnabled || loading ? "opacity-70 cursor-not-allowed" : ""}`}
                disabled={autoplayEnabled || loading}
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                    Starting...
                  </span>
                ) : (
                  "NEW GAME"
                )}
              </button>
            </div>

            {/* Error display */}
            {error && (
              <div className="bg-red-900/30 border border-red-400/30 text-red-300 p-2 rounded text-xs text-center">
                {error}
              </div>
            )}

            {/* Game status */}
            {gameOver && (
              <div
                className={`p-3 text-center rounded-lg text-lg ${hasWon ? "bg-green-900" : "bg-red-900"}`}
              >
                {hasWon
                  ? `You won ${multiplier.toFixed(2)}x your bet!`
                  : "Game Over! You hit a mine."}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ===== MINES RULES SECTION ===== */}
      <div className="max-w-4xl mx-auto mt-10 px-4">
        <button
          onClick={() => setShowRules(!showRules)}
          className="w-full bg-[#FFD700] text-[#030817] font-bold py-3 rounded-lg text-lg mb-4 pl-10 pr-10 flex items-center justify-center"
        >
          {showRules ? "Hide Mines Rules ▲" : "Show Mines Rules ▼"}
        </button>

        {showRules && (
          <div className="bg-[#081a3d] p-6 rounded-lg text-white space-y-4">
            <h2 className="text-2xl font-bold text-[#FFD700]">
              💣 Mines – How to Play
            </h2>
            <p>
              Mines is a risk-based game where you reveal tiles to find diamonds
              💎 while avoiding hidden mines 💣.
            </p>
            <h3 className="text-xl font-semibold text-[#FFD700]">
              🎯 Objective
            </h3>
            <p>
              Reveal as many safe tiles as possible and cash out before hitting
              a mine.
            </p>
            <h3 className="text-xl font-semibold text-[#FFD700]">
              🕹️ How It Works
            </h3>
            <ul className="list-disc ml-6 space-y-1">
              <li>Select your bet amount</li>
              <li>Choose how many mines are on the board</li>
              <li>Click tiles to reveal diamonds 💎</li>
              <li>Each safe tile increases your multiplier</li>
              <li>You can cash out anytime to secure winnings</li>
            </ul>
            <h3 className="text-xl font-semibold text-[#FFD700]">⚠️ Mines</h3>
            <p>If you hit a mine 💣, you instantly lose your entire bet.</p>
            <h3 className="text-xl font-semibold text-[#FFD700]">
              💰 Multiplier
            </h3>
            <p>
              The more tiles you safely reveal, the higher your multiplier
              becomes. More mines = higher risk but bigger rewards.
            </p>
            <h3 className="text-xl font-semibold text-[#FFD700]">
              🤖 Auto Play
            </h3>
            <p>
              Auto Play automatically reveals tiles and cashes out at your
              chosen multiplier using Auto Cashout.
            </p>
            <h3 className="text-xl font-semibold text-[#FFD700]">
              🧠 Strategy Tips
            </h3>
            <ul className="list-disc ml-6 space-y-1">
              <li>Low mines = safer, slower profit</li>
              <li>High mines = risky but huge multipliers</li>
              <li>Cash out early to avoid losing everything</li>
              <li>Use Auto Cashout to secure profits automatically</li>
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
