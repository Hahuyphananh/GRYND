"use client";
import React, { useState, useEffect, useRef } from "react";

export default function MinesGamePage() {
  const GRID_SIZE = 5;
  const [totalMines, setTotalMines] = useState(3);
  const [grid, setGrid] = useState(generateGrid(totalMines));
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
    setGrid(generateGrid(totalMines));
    setRevealed(Array(GRID_SIZE ** 2).fill(false));
    setGameOver(false);
    setMultiplier(1);
    setHasWon(false);
    setRevealedCount(0);
    setShowAllMines(false);
  }, [totalMines]);

  function handleCustomMineInput(e) {
    e.preventDefault();
    const inputField = document.getElementById('custom-mine-input');
    const mineCount = parseInt(inputField.value, 10);
    
    if (isNaN(mineCount)) {
      alert('Please enter a valid number');
      return;
    }
    
    const maxMines = GRID_SIZE * GRID_SIZE - 1;
    const finalMineCount = Math.min(Math.max(1, mineCount), maxMines);
    setTotalMines(finalMineCount);
    inputField.value = '';
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
          const newMultiplier = calculateMultiplier(totalMines, newRevealedCount);
          
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
    const multiplierTable = {
      1: {1:1.03,2:1.08,3:1.12,4:1.18,5:1.24,6:1.30,7:1.37,8:1.46,9:1.55,10:1.65,11:1.77,12:1.90,13:2.06,14:2.25,15:2.47,16:2.75,17:3.09,18:3.54,19:4.12,20:4.95,21:6.19,22:8.25,23:12.37,24:24.75},
      2: {1:1.08,2:1.17,3:1.29,4:1.41,5:1.56,6:1.74,7:1.94,8:2.18,9:2.47,10:2.83,11:3.26,12:3.81,13:4.50,14:5.40,15:6.60,16:8.25,17:10.61,18:14.14,19:19.80,20:29.70,21:49.50,22:99,23:297},
      3: {1:1.12,2:1.29,3:1.48,4:1.71,5:2.00,6:2.35,7:2.79,8:3.35,9:4.07,10:5.00,11:6.26,12:7.96,13:10.35,14:13.80,15:18.97,16:27.11,17:40.66,18:65.06,19:113.85,20:227.70,21:569.25,22:2277},
      4: {1:1.18,2:1.41,3:1.71,4:2.09,5:2.58,6:3.23,7:4.09,8:5.26,9:6.88,10:9.17,11:12.51,12:17.52,13:25.30,14:37.95,15:59.64,16:99.39,17:178.91,18:357.81,19:834.90,20:2504.70,21:12523.50},
      5: {1:1.24,2:1.56,3:2.00,4:2.58,5:3.39,6:4.52,7:6.14,8:8.50,9:12.04,10:17.52,11:26.27,12:40.87,13:66.41,14:113.85,15:208.72,16:417.45,17:939.26,18:2504.70,19:8766.45,20:52598.70},
      6: {1:1.30,2:1.74,3:2.35,4:3.23,5:4.52,6:6.46,7:9.44,8:14.17,9:21.89,10:35.03,11:58.38,12:102.17,13:189.75,14:379.50,15:834.90,16:2087.25,17:6261.75,18:25047,19:175329},
      7: {1:1.37,2:1.94,3:2.79,4:4.09,5:6.14,6:9.44,7:14.95,8:24.47,9:41.60,10:73.95,11:138.66,12:277.33,13:600.87,14:1442.10,15:3965.77,16:13219.25,17:59486.62,18:475893},
      8: {1:1.46,2:2.18,3:3.35,4:5.26,5:8.50,6:14.17,7:24.47,8:44.05,9:83.20,10:166.40,11:356.56,12:831.98,13:2163.15,14:6489.45,15:23794.65,16:118973.25,17:1070759.25},
      9: {1:1.55,2:2.47,3:4.07,4:6.88,5:12.04,6:21.89,7:41.60,8:83.20,9:176.80,10:404.10,11:1010.26,12:2828.73,13:9193.39,14:36773.55,15:202254.52,16:2022545.25},
      10: {1:1.65,2:2.83,3:5.00,4:9.17,5:17.52,6:35.03,7:73.95,8:166.40,9:404.10,10:1077.61,11:3232.84,12:11314.94,13:49031.4,14:294188.4,15:3236072.4},
      11: {1:1.77,2:3.26,3:6.26,4:12.51,5:26.27,6:58.38,7:138.66,8:356.56,9:1010.26,10:3232.84,11:12123.15,12:56574.69,13:367735.5,14:4412826},
      12: {1:1.90,2:3.81,3:7.96,4:17.52,5:40.87,6:102.17,7:277.33,8:831.98,9:2828.73,10:11314.94,11:56574.69,12:396022.85,13:5148297},
      13: {1:2.06,2:4.50,3:10.35,4:25.30,5:66.41,6:189.75,7:600.87,8:2163.15,9:9193.39,10:49031.4,11:367735.5,12:5148297},
      14: {1:2.25,2:5.40,3:13.80,4:37.95,5:113.85,6:379.50,7:1442.10,8:6489.45,9:36773.55,10:294188.4,11:4412826},
      15: {1:2.47,2:6.60,3:18.97,4:59.64,5:208.72,6:834.9,7:3965.77,8:23794.65,9:202254.52,10:3236072.4},
      16: {1:2.75,2:8.25,3:27.11,4:99.39,5:417.45,6:2087.25,7:13219.25,8:118973.25,9:2022545.25},
      17: {1:3.09,2:10.61,3:40.66,4:178.91,5:939.26,6:6261.75,7:59486.62,8:1070759.25},
      18: {1:3.54,2:14.14,3:65.06,4:357.81,5:2504.7,6:25047,7:475893},
      19: {1:4.12,2:19.8,3:113.85,4:834.9,5:8766.45,6:175329},
      20: {1:4.95,2:29.7,3:227.7,4:2504.7,5:52598.7},
      21: {1:6.19,2:49.5,3:569.25,4:12523.5},
      22: {1:8.25,2:99,3:2277},
      23: {1:12.37,2:297},
      24: {1:24.75}
    };
    
    return multiplierTable[mines]?.[revealed] || 1.0;
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
  if (revealed[index] || gameOver) return false;

  const updated = [...revealed];
  updated[index] = true;
  setRevealed(updated);
  
  const newRevealedCount = revealedCount + 1;
  setRevealedCount(newRevealedCount);

  if (grid[index] === "mine") {
    setGameOver(true);
    setMultiplier(0);
    setShowAllMines(true);
    setAutoplayEnabled(false);

    // 🔁 Call settle API for LOSS
    try {
      const res = await fetch("/api/mines/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          betAmount: 1,
          mines: totalMines,
          revealedCount,
          gameWon: false,
        }),
      });

      const data = await res.json();
      if (data.success) {
        setUserTokens(data.data.newBalance);
      } else {
        console.error("Error updating balance (loss):", data.error);
      }
    } catch (err) {
      console.error("Network error on loss:", err);
    }

    return true;
  } else {
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
}

 async function handleCashOut() {
  setHasWon(true);
  setGameOver(true);
  setShowAllMines(true);
  setAutoplayEnabled(false);

  // 🔁 Call settle API for WIN
  try {
    const res = await fetch("/api/mines/settle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        betAmount: 1, // You can make this a state later if needed
        mines: totalMines,
        revealedCount,
        gameWon: true,
      }),
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

  function handleReset() {
    setGrid(generateGrid(totalMines));
    setRevealed(Array(GRID_SIZE ** 2).fill(false));
    setGameOver(false);
    setMultiplier(1);
    setHasWon(false);
    setRevealedCount(0);
    setShowAllMines(false);
    setAutoplaySettings(false);
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
      return cellType === "mine" ? "☢️" : "💎";
    }
    
    if (showAllMines && cellType === "mine") {
      return "☢️";
    }
    
    return "❓";
  }
  
  function getCellStyle(cellType, index) {
    const baseStyle = gameOver ? "opacity-70" : "";
    
    if (revealed[index]) {
      return `${baseStyle} ${cellType === "mine" ? "bg-red-600" : "bg-green-600"}`;
    }
    
    if (showAllMines && cellType === "mine") {
      return `${baseStyle} bg-red-800 border border-red-400`;
    }
    
    return `${baseStyle} ${gameOver ? "bg-gray-800" : "bg-gray-700 hover:bg-gray-600"}`;
  }

  const maxMultiplier = calculateMultiplier(totalMines, GRID_SIZE * GRID_SIZE - totalMines - 1);

 

  return (
    <><p className="text-lg font-semibold">🪙 Tokens: {userTokens}</p><div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-4">
      <div className={`bg-gray-800 rounded-lg p-8 w-full max-w-6xl min-w-[80%] ${gameOver ? "relative" : ""}`}>
        {gameOver && (
          <div className="absolute inset-0 bg-black bg-opacity-10 rounded-lg pointer-events-none"></div>
        )}

        {/* Main game area with side panels */}
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Left sidebar */}
          <div className="w-full lg:w-1/4 flex flex-col gap-4">
            {/* Mine selection */}
            <div className="bg-gray-700 rounded-lg p-4">
              <p className="text-lg mb-3 text-center">Select Mines</p>
              <div className="grid grid-cols-3 gap-2">
                {[1, 3, 5, 10, 15, 20].map(mineCount => (
                  <button
                    key={mineCount}
                    onClick={() => handleMineChange(mineCount)}
                    disabled={autoplayEnabled}
                    className={`py-2 px-1 rounded text-sm ${totalMines === mineCount
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-600 text-gray-300'} ${gameOver || autoplayEnabled ? 'opacity-70' : ''}`}
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
                  className="bg-gray-600 text-white rounded px-2 py-1 w-full text-sm"
                  disabled={gameOver || autoplayEnabled} />
                <button
                  type="submit"
                  className={`px-2 py-1 rounded text-sm bg-blue-600 text-white
                    ${(gameOver || autoplayEnabled) ? 'opacity-70 cursor-not-allowed' : ''}`}
                  disabled={gameOver || autoplayEnabled}
                >
                  Set
                </button>
              </form>
            </div>

            {/* Game stats */}
            <div className="bg-gray-700 rounded-lg p-4">
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
                  <span className="text-purple-500 mr-1">☢️</span>
                  {totalMines}
                </span>
              </div>
              <div className="bg-gray-900 rounded p-3 text-center mb-2">
                <span className="text-yellow-500 mr-2">🪙</span>
                <span>0.00000000</span>
              </div>
            </div>
          </div>

          {/* Main game grid */}
          <div className="w-full lg:w-2/4">
            <div className="grid grid-cols-5 gap-3">
              {grid.map((cell, i) => (
                <button
                  key={i}
                  onClick={() => handleClick(i)}
                  disabled={gameOver || (showAllMines && cell === "mine") || autoplayEnabled}
                  className={`w-full aspect-square rounded-lg flex items-center justify-center transition-all duration-300 text-3xl
                    ${getCellStyle(cell, i)} ${autoplayEnabled ? "cursor-not-allowed" : ""}`}
                >
                  {getCellContent(cell, i)}
                </button>
              ))}
            </div>
          </div>

          {/* Right sidebar */}
          <div className="w-full lg:w-1/4 flex flex-col gap-4">
            {/* Multiplier display */}
            <div className="bg-gray-700 rounded-lg p-4 text-center">
              <div className="text-3xl font-bold text-green-400 mb-1">
                {multiplier.toFixed(2)}x
              </div>
              <div className="text-sm text-gray-400">
                Max: {maxMultiplier.toFixed(2)}x
              </div>
            </div>

            {/* Action buttons */}
            <div className="bg-gray-700 rounded-lg p-4 flex flex-col gap-3">
              <button
                onClick={handleCashOut}
                className={`bg-pink-600 hover:bg-pink-700 text-white font-bold py-3 px-4 rounded-lg text-lg
                  ${(gameOver || autoplayEnabled) ? 'opacity-50 cursor-not-allowed' : ''}`}
                disabled={gameOver || autoplayEnabled}
              >
                CASHOUT
              </button>
              <button
                onClick={toggleAutoplay}
                className={`${autoplayEnabled ? 'bg-yellow-600' : 'bg-gray-600'} hover:bg-gray-500 text-white 
                  font-bold py-3 px-4 rounded-lg text-lg ${gameOver ? 'opacity-70 cursor-not-allowed' : ''}`}
                disabled={gameOver}
              >
                {autoplayEnabled ? 'STOP AUTO' : 'AUTO PLAY'}
              </button>
              <button
                onClick={handleReset}
                className={`bg-green-600 hover:bg-green-700 text-white font-bold py-3 px-4 rounded-lg text-lg
                  ${autoplayEnabled ? 'opacity-70 cursor-not-allowed' : ''}`}
                disabled={autoplayEnabled}
              >
                NEW GAME
              </button>
            </div>

            {/* Game status */}
            {gameOver && (
              <div className={`p-3 text-center rounded-lg text-lg ${hasWon ? 'bg-green-900' : 'bg-red-900'}`}>
                {hasWon
                  ? `You won ${multiplier.toFixed(2)}x your bet!`
                  : "Game Over! You hit a mine."}
              </div>
            )}
          </div>
        </div>

        {/* Autoplay Settings Modal */}
        {autoplaySettings && !gameOver && (
          <div className="absolute inset-0 bg-gray-900 bg-opacity-95 rounded-lg flex flex-col justify-center items-center z-30 p-6">
            <h3 className="text-2xl font-bold mb-6">Autoplay Settings</h3>

            <div className="w-full mb-6">
              <label className="block text-lg mb-2">Auto-cashout at:</label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="1.1"
                  max="10"
                  step="0.1"
                  value={autoCashoutAt}
                  onChange={(e) => setAutoCashoutAt(parseFloat(e.target.value))}
                  className="w-full h-3" />
                <span className="text-green-400 font-bold text-xl min-w-[60px]">{autoCashoutAt.toFixed(1)}x</span>
              </div>
            </div>

            <div className="w-full mb-8">
              <label className="block text-lg mb-2">Speed:</label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="100"
                  max="2000"
                  step="100"
                  value={autoplaySpeed}
                  onChange={(e) => setAutoplaySpeed(parseInt(e.target.value))}
                  className="w-full h-3" />
                <span className="text-xl min-w-[60px]">{(autoplaySpeed / 1000).toFixed(1)}s</span>
              </div>
            </div>

            <div className="flex gap-3 w-full">
              <button
                onClick={() => setAutoplaySettings(false)}
                className="bg-gray-700 hover:bg-gray-600 text-white font-bold py-3 px-6 rounded-lg text-lg w-1/2"
              >
                Cancel
              </button>
              <button
                onClick={startAutoplayWithSettings}
                className="bg-yellow-600 hover:bg-yellow-500 text-white font-bold py-3 px-6 rounded-lg text-lg w-1/2"
              >
                Start
              </button>
            </div>
          </div>
        )}
      </div>
    </div></>
  );
}