"use client";
import React, { useState, useEffect, useRef } from "react";
import NavigationBar from "../../../components/navigation-bar";
import { getMinesMultiplier } from "../../../lib/minesMath";

export default function MinesGamePage() {
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
  const [userTokens, setUserTokens] = useState(0); // user tokens balance
  const [loading, setLoading] = useState(false);
  const [betAmount, setBetAmount] = useState(10);
  const [error, setError] = useState(null);
  const [gameStarted, setGameStarted] = useState(false);
  const [showRules, setShowRules] = useState(false);

  // Autoplay references
  const autoplayTimerRef = useRef(null);
  const currentGridRef = useRef(grid);
  const revealedRef = useRef(revealed);
  const gameOverRef = useRef(gameOver);
  const multiplierRef = useRef(multiplier);
  const revealedCountRef = useRef(revealedCount);
  //fetch user tokens
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
      } catch (error) {
        console.error("Error fetching tokens:", error);
        setError("Impossible de récupérer votre solde de tokens");
      } finally {
        setLoading(false);
      }
    }

    fetchTokens();
  }, []);

  // Update refs when state changes
  useEffect(() => {
    currentGridRef.current = grid;
    revealedRef.current = revealed;
    gameOverRef.current = gameOver;
    multiplierRef.current = multiplier;
    revealedCountRef.current = revealedCount;
  }, [grid, revealed, gameOver, multiplier, revealedCount]);

  // Handle autoplay timer
  useEffect(() => {
    if (autoplayEnabled && !gameOver) {
      startAutoplay();
    } else {
      stopAutoplay();
    }

    return () => stopAutoplay();
  }, [autoplayEnabled, gameOver]);

  // Regenerate grid when totalMines changes
  useEffect(() => {
    setGrid(Array(GRID_SIZE ** 2).fill("diamond"));
    setRevealed(Array(GRID_SIZE ** 2).fill(false));
    setGameOver(false);
    setMultiplier(1);
    setHasWon(false);
    setRevealedCount(0);
    setShowAllMines(false);
  }, [totalMines]);

  function handleCustomMineInput(e) {
    e.preventDefault();
    const inputField = document.getElementById("custom-mine-input");
    const mineCount = parseInt(inputField.value, 10);

    if (isNaN(mineCount)) {
      alert("Please enter a valid number");
      return;
    }

    const maxMines = GRID_SIZE * GRID_SIZE - 1;
    const finalMineCount = Math.min(Math.max(1, mineCount), maxMines);
    setTotalMines(finalMineCount);
    inputField.value = "";
  }

  function startAutoplay() {
    if (autoplayTimerRef.current) {
      clearInterval(autoplayTimerRef.current);
    }

    autoplayTimerRef.current = setInterval(() => {
      // Get current state from refs
      const currentRevealed = revealedRef.current;
      const currentGameOver = gameOverRef.current;
      const currentMultiplier = multiplierRef.current;
      const currentRevealedCount = revealedCountRef.current;

      if (currentGameOver) {
        stopAutoplay();
        return;
      }

      if (currentMultiplier >= autoCashoutAt) {
        handleCashOut();
        stopAutoplay();
        return;
      }

      // Find all unrevealed cells
      const unrevealed = [];
      for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
        if (!currentRevealed[i]) {
          unrevealed.push(i);
        }
      }

      if (unrevealed.length > 0) {
        const randomIndex = Math.floor(Math.random() * unrevealed.length);
        const clickedIndex = unrevealed[randomIndex];

        // Create new revealed array with this cell revealed
        const newRevealed = [...currentRevealed];
        newRevealed[clickedIndex] = true;

        // Check if it's a mine
        if (currentGridRef.current[clickedIndex] === "mine") {
          // Mine hit - game over
          setGameOver(true);
          setMultiplier(0);
          setShowAllMines(true);
          setAutoplayEnabled(false);
          return;
        } else {
          // Diamond revealed - update multiplier
          const newRevealedCount = currentRevealedCount + 1;
          const newMultiplier = calculateMultiplier(
            totalMines,
            newRevealedCount,
          );

          // Update all states and refs
          setRevealed(newRevealed);
          setRevealedCount(newRevealedCount);
          setMultiplier(newMultiplier);
          revealedRef.current = newRevealed;
          revealedCountRef.current = newRevealedCount;
          multiplierRef.current = newMultiplier;

          // Check for win condition
          const safeCells = GRID_SIZE * GRID_SIZE - totalMines;
          if (newRevealedCount >= safeCells) {
            setHasWon(true);
            setGameOver(true);
            setShowAllMines(true);
            setAutoplayEnabled(false);
          }
        }
      } else {
        stopAutoplay();
      }
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

  function generateGrid(mines) {
    const totalCells = GRID_SIZE * GRID_SIZE;
    const cells = Array(totalCells).fill("diamond");

    let minesPlaced = 0;
    while (minesPlaced < mines) {
      const idx = Math.floor(Math.random() * totalCells);
      if (cells[idx] !== "mine") {
        cells[idx] = "mine";
        minesPlaced++;
      }
    }

    return cells;
  }

  async function handleClick(index) {
    if (!gameStarted) return false; // ⛔ block clicks before New Game
    if (revealed[index] || gameOver) return false;

    const updated = [...revealed];
    updated[index] = true;
    setRevealed(updated);

    const newRevealedCount = revealedCount + 1;
    setRevealedCount(newRevealedCount);

    try {
      const revealRes = await fetch("/api/mines/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index }),
      });
      const revealData = await revealRes.json();
      if (!revealData.success) {
        console.error("Reveal failed:", revealData.error);
        return false;
      }

      if (revealData.data?.mineHit) {
        setGameOver(true);
        setMultiplier(0);
        setShowAllMines(true);
        setAutoplayEnabled(false);
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
      return false;
    }

    const newMultiplier = calculateMultiplier(totalMines, newRevealedCount);
    setMultiplier(newMultiplier);

    const safeCells = GRID_SIZE * GRID_SIZE - totalMines;
    if (newRevealedCount >= safeCells) {
      setHasWon(true);
      setGameOver(true);
      setShowAllMines(true);
      setAutoplayEnabled(false);
    }
    return false;
  }

  async function handleCashOut() {
    setHasWon(true);
    setGameOver(true);
    setShowAllMines(true);
    setAutoplayEnabled(false);

    // 🔁 Call settle API for WIN (server-authoritative)
    try {
      const res = await fetch("/api/mines/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cashout" }),
      });

      const data = await res.json();
      if (data.success) {
        setUserTokens(data.data.newBalance);
      } else {
        console.error("Error updating balance (win):", data.error);
      }
    } catch (err) {
      console.error("Network error on win:", err);
    }
  }

  async function handleReset() {
    try {
      const res = await fetch("/api/mines/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ betAmount, mines: totalMines }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Unable to start game");
        return;
      }
      setUserTokens(data.data.newBalance);
    } catch (err) {
      console.error("Error starting mines game:", err);
      setError("Unable to start game");
      return;
    }

    setGrid(Array(GRID_SIZE ** 2).fill("diamond"));
    setRevealed(Array(GRID_SIZE ** 2).fill(false));
    setGameOver(false);
    setMultiplier(1);
    setHasWon(false);
    setRevealedCount(0);
    setShowAllMines(false);
    setAutoplaySettings(false);
    setGameStarted(true); // ✅ game officially starts
  }

  function handleMineChange(mines) {
    setTotalMines(mines);
    handleReset();
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
        {/* Spark */}
        {!exploded && (
          <span className="absolute -top-2 -right-2 text-orange-400 animate-ping">
            ✨
          </span>
        )}
      </span>
    );
  }

  return (
    <div className="min-h-screen bg-[#030817] text-white flex flex-col items-center justify-start pt-24 p-4 relative">
      <NavigationBar currentPath="/casino" />

      <div
        className={`bg-gradient-to-br from-[#001933] via-[#00111f] to-[#000814] rounded-2xl border border-[#00e5ff]/40 p-8 w-full max-w-6xl min-w-[80%] shadow-[0_0_60px_rgba(0,229,255,0.2),inset_0_0_30px_rgba(0,229,255,0.08)] ${gameOver ? "relative" : ""}`}
      >
        {gameOver && (
          <div className="absolute inset-0 bg-black bg-opacity-10 rounded-lg pointer-events-none"></div>
        )}

        {/* Main game area with side panels */}
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Left sidebar */}
          <div className="w-full lg:w-1/4 flex flex-col gap-4">
            {/* Your new input container */}
            <h1 className="text-3xl font-bold text-yellow-400 text-center w-full mt-3">
              Mines
            </h1>
            <div className="rounded-xl border border-[#00e5ff]/30 bg-[#03142b] p-4 shadow-[inset_0_0_18px_rgba(0,229,255,0.1)]">
              <label
                htmlFor="bet-input"
                className="block mb-2 text-center font-semibold"
              >
                Bet Amount
              </label>
              <input
                id="bet-input"
                type="number"
                min="1"
                max={userTokens}
                value={betAmount} // you need to add betAmount state too
                onChange={(e) => setBetAmount(Number(e.target.value))}
                className="w-full rounded-lg border border-[#00e5ff]/40 bg-[#071226] px-2 py-2 text-center text-white focus:border-[#00e5ff] focus:outline-none focus:shadow-[0_0_12px_rgba(0,229,255,0.45)]"
                disabled={gameOver || autoplayEnabled}
                placeholder="Enter your bet"
              />
              <p className="text-xs text-gray-300 mt-1 text-center">
                Balance: {userTokens} tokens
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
                    } ${gameOver || autoplayEnabled ? "opacity-70" : ""}`}
                  >
                    {mineCount}
                  </button>
                ))}
              </div>

              {/* Custom mine input */}
              <form
                onSubmit={handleCustomMineInput}
                className="mt-4 flex gap-2"
              >
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
            </div>
          </div>

          {/* Main game grid */}
          <div className="w-full lg:w-2/4 relative">
            {/* 🔒 Start Game Overlay */}
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
                    autoplayEnabled
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
              <p className="text-yellow-400 text-xl font-bold">{userTokens}</p>
            </div>

            {/* Multiplier display */}
            <div className="rounded-xl border border-[#00e5ff]/30 bg-[#03142b] p-4 text-center shadow-[inset_0_0_18px_rgba(0,229,255,0.1)]">
              <div className="text-3xl font-bold text-green-400 mb-1">
                {multiplier.toFixed(2)}x
              </div>
              <div className="text-sm text-gray-300">
                Max: {maxMultiplier.toFixed(2)}x
              </div>
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
                CASHOUT
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
                ${autoplayEnabled ? "opacity-70 cursor-not-allowed" : ""}`}
                disabled={autoplayEnabled}
              >
                NEW GAME
              </button>
            </div>

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
              Auto Play automatically reveals tiles based on your settings and
              can stop at a chosen multiplier using Auto Cashout.
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
